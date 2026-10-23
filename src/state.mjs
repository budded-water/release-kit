import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  link,
  realpath,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
export function releasePath(store, id) {
  if (!/^release-[a-f0-9]{24}$/.test(id)) throw new Error('Invalid release ID');
  return join(resolve(store), 'releases', id);
}
export async function privateDirectory(path) {
  // Refuse redirected state and output paths, including existing ancestors.
  for (let current = resolve(path); ; current = dirname(current)) {
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const systemAlias =
      stat?.isSymbolicLink() &&
      process.platform === 'darwin' &&
      ['/var', '/tmp'].includes(current) &&
      (await realpath(current)) === `/private${current}`;
    if (stat && !systemAlias && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error(`State directory must not traverse symlinks: ${current}`);
    if (dirname(current) === current) break;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
}
export async function readJson(path) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing redirected record: ${path}`);
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function atomicJson(path, value, { exclusive = false } = {}) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (exclusive) {
      await link(temporary, path);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function acquireLock(path) {
  await privateDirectory(dirname(path));
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  try {
    await atomicJson(path, owner, { exclusive: true });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `Execution lock exists: ${path}. Do not retry concurrently. Reconcile the owning process and its child tools before operator recovery.`,
      );
    throw error;
  }
  return async () => {
    const current = await readJson(path);
    if (current.token !== owner.token)
      throw new Error('Execution ownership changed; refusing to remove another lock');
    await unlink(path);
  };
}
export async function loadState(directory) {
  const events = join(directory, 'events');
  let names;
  try {
    names = (await readdir(events)).filter((name) => /^\d{8}\.json$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let state = null;
  let previous = null;
  for (let index = 0; index < names.length; index++) {
    if (names[index] !== `${String(index + 1).padStart(8, '0')}.json`)
      throw new Error('Release journal has a missing event');
    const event = await readJson(join(events, names[index]));
    if (
      event.sequence !== index + 1 ||
      event.previous !== previous ||
      event.digest !== digest(event.state)
    )
      throw new Error('Release journal integrity mismatch');
    state = event.state;
    previous = digest(event);
  }
  return state;
}
export async function saveState(directory, state) {
  const events = join(directory, 'events');
  await privateDirectory(events);
  const names = (await readdir(events)).filter((name) => /^\d{8}\.json$/.test(name)).sort();
  await loadState(directory); // Refuse to append to a corrupted history.
  const previous = names.length ? digest(await readJson(join(events, names.at(-1)))) : null;
  const sequence = names.length + 1;
  await atomicJson(
    join(events, `${String(sequence).padStart(8, '0')}.json`),
    { sequence, previous, digest: digest(state), state },
    { exclusive: true },
  );
}
