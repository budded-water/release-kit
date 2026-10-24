import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubExecutor } from './github-executor.mjs';

const workflowPath = '.github/workflows/release-local.yml';
const workflow = await readFile(new URL(`../examples/${workflowPath}`, import.meta.url), 'utf8');
const requestId = `request-${'a'.repeat(32)}`;
const sha = 'b'.repeat(40);
const repository = 'example/mobile-app';
const prefix = `repos/${repository}`;
const designatedRunner = {
  id: 123,
  name: 'release-mac',
  os: 'macos',
  status: 'online',
  busy: false,
  labels: [{ name: 'self-hosted' }, { name: 'macOS' }, { name: 'release-example' }],
};

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-github-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, '.github/workflows'), { recursive: true });
  await writeFile(join(directory, workflowPath), workflow);
  const policy = {
    repository,
    controlRepository: directory,
    github: {
      enabled: true,
      workflow: 'release-local.yml',
      ref: 'main',
      runnerName: 'release-mac',
      runnerLabel: 'release-example',
    },
  };
  Object.assign(policy.github, overrides.policy);
  const calls = [];
  let headReads = 0;
  const command = async (binary, args, options) => {
    const method = args[args.indexOf('--method') + 1];
    const path = args.find((arg) => arg.startsWith('repos/'));
    const call = { binary, args, options, method, path };
    calls.push(call);
    assert.equal(binary, 'gh');
    assert.equal(options.sensitive, true);
    assert.equal(options.diagnostics, false);
    assert.equal(options.cwd, directory);
    assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
    assert.ok(args.includes('X-GitHub-Api-Version: 2026-03-10'));
    if (overrides.errorAt === path) throw new Error('private-token provider detail');
    let result;
    if (path === prefix)
      result = {
        full_name: repository,
        private: true,
        default_branch: 'main',
        archived: false,
        disabled: false,
        ...overrides.repository,
      };
    else if (path === `${prefix}/actions/workflows/release-local.yml`)
      result = { state: 'active', path: workflowPath, ...overrides.workflow };
    else if (path.startsWith(`${prefix}/git/ref/heads/`)) {
      headReads += 1;
      result = {
        ref: `refs/heads/${policy.github.ref}`,
        object: { type: 'commit', sha: overrides.heads?.[headReads - 1] ?? sha },
        ...overrides.headResponse,
      };
    } else if (path.startsWith(`${prefix}/contents/`)) {
      assert.equal(path, `${prefix}/contents/${workflowPath}?ref=${sha}`);
      result = {
        type: 'file',
        path: workflowPath,
        encoding: 'base64',
        content: Buffer.from(overrides.content ?? workflow).toString('base64'),
        ...overrides.contentResponse,
      };
    } else if (path.startsWith(`${prefix}/actions/runners?`)) {
      const page = Number(path.match(/page=(\d+)$/)[1]);
      result = overrides.pages?.[page - 1] ?? {
        total_count: 1,
        runners: [{ ...designatedRunner, ...overrides.runner }],
      };
    } else if (path === `${prefix}/actions/workflows/release-local.yml/dispatches`) {
      assert.equal(method, 'POST');
      return {
        stdout:
          overrides.dispatchResponse ??
          JSON.stringify({
            workflow_run_id: 456,
            html_url: `https://github.com/${repository}/actions/runs/456`,
          }),
      };
    } else assert.fail(`Unexpected API path: ${path}`);
    assert.equal(method, 'GET');
    return { stdout: JSON.stringify(result) };
  };
  const environment = { PATH: '/tools', GH_TOKEN: 'private-token' };
  return {
    executor: createGithubExecutor({ policy, command, environment }),
    policy,
    calls,
    directory,
    command,
  };
}

test('availability attests the exact private default-branch workflow and unique idle Mac without mutation', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.executor.available(), {
    available: true,
    reason: 'designated-mac-ready',
    workflowSha: sha,
    workflowDigest: createHash('sha256').update(workflow).digest('hex'),
    runnerId: designatedRunner.id,
  });
  assert.ok(f.calls.every(({ method }) => method === 'GET'));
  assert.ok(f.calls.every(({ options }) => options.env.GH_PROMPT_DISABLED === '1'));
  assert.ok(f.calls.every(({ args }) => !args.some((value) => value.includes('private-token'))));
});

test('disabled or unsupported routing policies make no GitHub calls', async (t) => {
  for (const policy of [
    { enabled: false },
    { runnerLabel: 'ubuntu-latest' },
    { workflow: 'arbitrary.yml' },
    { runnerName: '' },
    { ref: 'main\nmalicious' },
  ]) {
    const f = await fixture(t, { policy });
    assert.equal((await f.executor.available()).available, false);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
    assert.equal(f.calls.length, 0);
  }
});

test('public, wrong, archived, disabled, or non-default repositories cannot dispatch', async (t) => {
  for (const value of [
    { private: false },
    { full_name: 'someone/else' },
    { default_branch: 'other' },
    { archived: true },
    { disabled: true },
  ]) {
    const f = await fixture(t, { repository: value });
    assert.deepEqual(await f.executor.available(), {
      available: false,
      reason: 'repository-policy-mismatch',
    });
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
  }
});

test('inactive, relocated, missing, or different workflow content is unavailable', async (t) => {
  for (const value of [
    { workflow: { state: 'disabled_manually' } },
    { workflow: { path: '.github/workflows/paid.yml' } },
    { contentResponse: { encoding: 'none' } },
    { contentResponse: { type: 'symlink' } },
    { contentResponse: { content: 'not base64!' } },
    { content: workflow.replace('[self-hosted, macOS, release-example]', 'macos-latest') },
  ]) {
    const f = await fixture(t, value);
    assert.equal((await f.executor.available()).available, false);
    assert.ok(f.calls.every(({ method }) => method === 'GET'));
    await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
  }
});

test('an API/CLI failure returns a safe unavailable reason without exposing provider data', async (t) => {
  const f = await fixture(t, { errorAt: `${prefix}/actions/runners?per_page=100&page=1` });
  const result = await f.executor.available();
  assert.deepEqual(result, { available: false, reason: 'github-availability-unknown' });
  assert.doesNotMatch(JSON.stringify(result), /private-token|provider detail/);
  assert.ok(f.calls.every(({ method }) => method === 'GET'));
});

test('an offline, busy, wrong-name, non-Mac, or non-self-hosted runner is not selected', async (t) => {
  for (const runner of [
    { status: 'offline' },
    { busy: true },
    { name: 'another-mac' },
    { os: 'linux' },
    { labels: [{ name: 'macOS' }, { name: 'release-example' }] },
    { labels: [{ name: 'self-hosted' }, { name: 'release-example' }] },
  ]) {
    const f = await fixture(t, { runner });
    assert.equal((await f.executor.available()).available, false);
    await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
    assert.ok(f.calls.every(({ method }) => method === 'GET'));
  }
});

function otherRunners(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...designatedRunner,
    id: 1000 + index,
    name: `other-${index}`,
    labels: [{ name: 'self-hosted' }, { name: 'macOS' }],
  }));
}

test('runner selection reads every page and can find the designated Mac after page one', async (t) => {
  const f = await fixture(t, {
    pages: [
      { total_count: 101, runners: otherRunners(100) },
      { total_count: 101, runners: [designatedRunner] },
    ],
  });
  assert.equal((await f.executor.available()).available, true);
  assert.equal(f.calls.filter(({ path }) => path.includes('/actions/runners?')).length, 2);
});

test('duplicate routing labels on a later page block even when the other runner is offline', async (t) => {
  const f = await fixture(t, {
    pages: [
      { total_count: 101, runners: [designatedRunner, ...otherRunners(99)] },
      {
        total_count: 101,
        runners: [{ ...designatedRunner, id: 999, name: 'other', status: 'offline' }],
      },
    ],
  });
  assert.deepEqual(await f.executor.available(), {
    available: false,
    reason: 'runner-label-not-unique',
  });
  await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
});

test('incomplete, duplicated, or shifting runner inventory is unknown and cannot route', async (t) => {
  for (const pages of [
    [{ total_count: 2, runners: [designatedRunner] }],
    [{ total_count: 1, runners: [designatedRunner, designatedRunner] }],
    [{ total_count: 2, runners: [designatedRunner, designatedRunner] }],
    [
      { total_count: 101, runners: otherRunners(100) },
      { total_count: 102, runners: [designatedRunner] },
    ],
    [{ total_count: 1, runners: [{ ...designatedRunner, labels: null }] }],
  ]) {
    const f = await fixture(t, { pages });
    assert.deepEqual(await f.executor.available(), {
      available: false,
      reason: 'runner-inventory-unavailable',
    });
    assert.ok(f.calls.every(({ method }) => method === 'GET'));
  }
});

test('default branch movement during availability invalidates the workflow attestation', async (t) => {
  const f = await fixture(t, { heads: [sha, 'c'.repeat(40)] });
  assert.deepEqual(await f.executor.available(), {
    available: false,
    reason: 'workflow-ref-changed',
  });
  await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
});

test('head lookup requires the exact branch reference rather than a similarly named tag', async (t) => {
  for (const headResponse of [
    { ref: 'refs/tags/main' },
    { ref: 'refs/heads/main-other' },
    { object: { type: 'tag', sha } },
    { object: { type: 'commit', sha: 'invalid' } },
  ]) {
    const f = await fixture(t, { headResponse });
    assert.equal((await f.executor.available()).available, false);
    await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
    assert.ok(f.calls.every(({ method }) => method === 'GET'));
  }
});

test('dispatch uses one structured POST with only the ref and opaque request ID', async (t) => {
  const f = await fixture(t);
  await f.executor.available();
  assert.deepEqual(await f.executor.dispatch(requestId), {
    runId: 456,
    runUrl: `https://github.com/${repository}/actions/runs/456`,
    workflowSha: sha,
  });
  const mutations = f.calls.filter(({ method }) => method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args.slice(-4), [
    '-f',
    'ref=main',
    '-f',
    `inputs[request_id]=${requestId}`,
  ]);
  assert.doesNotMatch(
    JSON.stringify(mutations[0].args),
    /private-token|stateDirectory|releaseConfig/,
  );
  await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
  assert.equal(f.calls.filter(({ method }) => method === 'POST').length, 1);
});

test('historical empty dispatch responses leave the durable request as the source of execution ownership', async (t) => {
  const f = await fixture(t, { dispatchResponse: '' });
  await f.executor.available();
  assert.deepEqual(await f.executor.dispatch(requestId), { workflowSha: sha });
});

test('malformed, mismatched, or lost dispatch responses are unknown and never automatically resent', async (t) => {
  for (const overrides of [
    { dispatchResponse: 'private-token invalid response' },
    { dispatchResponse: '{}' },
    {
      dispatchResponse: JSON.stringify({
        workflow_run_id: 456,
        html_url: 'https://example.com/456',
      }),
    },
    { errorAt: `${prefix}/actions/workflows/release-local.yml/dispatches` },
  ]) {
    const f = await fixture(t, overrides);
    await f.executor.available();
    await assert.rejects(f.executor.dispatch(requestId), (error) => {
      assert.match(error.message, /response is unknown/);
      assert.doesNotMatch(error.message, /private-token|provider detail/);
      return true;
    });
    await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
    assert.equal(f.calls.filter(({ method }) => method === 'POST').length, 1);
  }
});

test('a moved default ref between availability and dispatch is refused before POST', async (t) => {
  const f = await fixture(t, { heads: [sha, sha, 'c'.repeat(40)] });
  assert.equal((await f.executor.available()).available, true);
  await assert.rejects(f.executor.dispatch(requestId), /ref changed; no request was sent/);
  assert.ok(f.calls.every(({ method }) => method === 'GET'));
});

test('request IDs cannot introduce path traversal, flags, shell commands, or new workflow inputs', async (t) => {
  const f = await fixture(t);
  await f.executor.available();
  const before = f.calls.length;
  for (const id of [
    '../../private',
    '--ref=other',
    'request-$(touch /tmp/unwanted)',
    `${requestId}\ninputs[source]=evil`,
    `request-${'A'.repeat(32)}`,
    'request-short',
  ])
    await assert.rejects(f.executor.dispatch(id), /Invalid release request ID/);
  assert.equal(f.calls.length, before);
  assert.equal((await f.executor.dispatch(requestId)).runId, 456);
});

test('a later failed availability check cannot reuse an earlier successful attestation', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.executor.available()).available, true);
  f.policy.github.enabled = false;
  assert.equal((await f.executor.available()).available, false);
  await assert.rejects(f.executor.dispatch(requestId), /availability verification/);
  assert.ok(f.calls.every(({ method }) => method === 'GET'));
});

test('checked-in workflow is manual, private default-branch-only and uses trusted local scripts without checkout', () => {
  const trigger = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1];
  assert.equal((trigger.match(/^  \w+:/gm) ?? []).join('\n'), '  workflow_dispatch:');
  assert.equal((trigger.match(/^      \w+:/gm) ?? []).join('\n'), '      request_id:');
  assert.match(trigger, /required: true/);
  assert.match(workflow, /github\.event\.repository\.private == true/);
  assert.match(
    workflow,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.deepEqual(workflow.match(/^\s+runs-on:.*$/gm), [
    '    runs-on: [self-hosted, macOS, release-example]',
  ]);
  assert.doesNotMatch(workflow, /^\s*-?\s*uses:|checkout|upload-artifact|download-artifact/gm);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /group: release-request-\$\{\{ inputs\.request_id \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /REQUEST_ID: \$\{\{ inputs\.request_id \}\}/);
  const script = workflow.split('        run: |\n')[1];
  assert.doesNotMatch(script, /\$\{\{/);
  assert.match(script, /unset GEM_HOME GEM_PATH/);
  assert.match(script, /unset .*NODE_OPTIONS NODE_PATH/);
  assert.match(script, /exec "\$\{RELEASE_KIT_NODE:\?\}"/);
  assert.match(script, /"\$\{RELEASE_KIT_BOOTSTRAP:\?\}" worker/);
  assert.match(script, /--request "\$REQUEST_ID"/);
  assert.doesNotMatch(script, /CONTROL_REPO|EXECUTOR_CONFIG|worker\.mjs|source /);
});


for (const phase of ['availability', 'preflight', 'submission', 'observation']) {
  test(`GitHub ${phase} sanitizes provider secrets while preserving cleanup uncertainty`, async t => {
    const f = await fixture(t);
    let fail = phase === 'availability' || phase === 'observation';
    let posts = 0;
    const executor = createGithubExecutor({ policy: f.policy, command: async (...args) => {
      const post = args[1].includes('POST');
      if (post) posts++;
      if (fail && (phase !== 'submission' || post))
        throw Object.assign(new Error('synthetic-private-token'), { cleanupIncomplete: true });
      return f.command(...args);
    } });
    if (phase === 'preflight' || phase === 'submission') {
      assert.equal((await executor.available()).available, true);
      fail = true;
    }
    const action = phase === 'availability' ? executor.available()
      : phase === 'observation' ? executor.observeRun({ runId: 456, workflowSha: sha })
      : executor.dispatch(requestId);
    await assert.rejects(action, error => {
      assert.equal(error.cleanupIncomplete, true);
      assert.doesNotMatch(error.message, /synthetic-private-token/);
      return true;
    });
    if (phase === 'preflight' || phase === 'submission') {
      await assert.rejects(executor.dispatch(requestId), /availability verification/);
      assert.equal(posts, phase === 'submission' ? 1 : 0);
    }
  });
}
