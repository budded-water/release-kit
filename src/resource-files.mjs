import { lstat, opendir, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalPrivatePath } from './state.mjs';
import { resourceError } from './resource-ledger.mjs';

export const containsPath = (root, path) => root === path || path.startsWith(root + sep);
export const overlapsPath = (left, right) => containsPath(left, right) || containsPath(right, left);
export const fileIdentity = st => ({ dev: st.dev, ino: st.ino });
export const sameIdentity = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;

export function resourcePath(store, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') ||
      value.split('/').some(part => !part || part === '.' || part === '..'))
    throw resourceError('RESOURCE_PATH', 'Resource path must be a canonical relative leaf');
  const path = resolve(store, value);
  if (!containsPath(join(store, 'releases'), path) || !/^release-[a-f0-9]{24}$/.test(value.split('/')[1] ?? '') ||
      value.split('/').length < 5 || value.split('/')[2] !== 'validation')
    throw resourceError('RESOURCE_PATH', 'Only declared preparation leaves inside a release workspace are supported');
  return path;
}

export async function observeResource(store, resource, { signal, maxEntries = 100000, timeoutMs = 30000 } = {}) {
  const path = resourcePath(store, resource.path);
  const rootStat = await lstat(store);
  const deadline = Date.now() + timeoutMs;
  const entries = [], directories = [];
  let bytes = 0;
  const inodes = new Set();
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline || entries.length >= maxEntries)
      throw resourceError('RESOURCE_BUDGET', 'Resource observation budget exhausted');
  };
  if (await canonicalPrivatePath(path) !== path)
    throw resourceError('RESOURCE_PATH', 'Resource path is redirected');
  let target;
  try { target = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return { missing: true, bytes: 0, entries: [] }; throw error; }
  if (!target.isDirectory() || target.isSymbolicLink() || target.dev !== rootStat.dev ||
      !sameIdentity(target, resource.identity))
    throw resourceError('RESOURCE_IDENTITY', 'Resource generation identity changed');
  async function visit(current, depth) {
    check();
    if (depth > 128) throw resourceError('RESOURCE_BUDGET', 'Resource depth budget exhausted');
    const st = await lstat(current);
    if (st.isSymbolicLink() || st.dev !== rootStat.dev ||
        !(st.isDirectory() || st.isFile()) || st.isFile() && st.nlink !== 1)
      throw resourceError('RESOURCE_PATH', 'Resource contains an opaque link, mount or unsupported entry');
    entries.push({ path: relative(path, current), ...fileIdentity(st), directory: st.isDirectory(),
      size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
    if (st.isDirectory()) {
      directories.push({ path: current, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
      const handle = await opendir(current);
      for await (const child of handle) await visit(join(current, child.name), depth + 1);
    } else {
      const inode = `${st.dev}:${st.ino}`;
      if (!inodes.has(inode)) bytes += st.size;
      inodes.add(inode);
    }
  }
  await visit(path, 0);
  for (const prior of directories) {
    check();
    const current = await lstat(prior.path);
    if (current.mtimeMs !== prior.mtimeMs || current.ctimeMs !== prior.ctimeMs)
      throw resourceError('RESOURCE_CHANGED', 'Resource changed during observation');
  }
  return { missing: false, bytes, entries };
}

export async function removeObservedResource(store, resource, observed, { signal } = {}) {
  const path = resourcePath(store, resource.path);
  for (const entry of [...observed.entries].reverse()) {
    signal?.throwIfAborted();
    const target = resolve(path, entry.path);
    if (await canonicalPrivatePath(dirname(target)) !== dirname(target))
      throw resourceError('RESOURCE_IDENTITY', 'Resource ancestor changed before deletion');
    const root = await lstat(path);
    if (!sameIdentity(root, resource.identity) || root.isSymbolicLink())
      throw resourceError('RESOURCE_IDENTITY', 'Resource root changed before deletion');
    const st = await lstat(target);
    if (!sameIdentity(st, entry) || st.isSymbolicLink() || st.isDirectory() !== entry.directory ||
        !entry.directory && (st.nlink !== 1 || st.size !== entry.size ||
          st.mtimeMs !== entry.mtimeMs || st.ctimeMs !== entry.ctimeMs))
      throw resourceError('RESOURCE_IDENTITY', 'Resource entry changed before deletion');
    if (entry.directory) await rmdir(target);
    else await unlink(target);
  }
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw resourceError('RESOURCE_INCOMPLETE', 'Resource removal did not complete');
}
