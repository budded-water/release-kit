import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeStatus } from './summary.mjs';
import { main } from './cli.mjs';
import { saveState, releasePath } from './state.mjs';

test('local status summary preserves failures/reuse and does not alter canonical history or call tools', async (t) => {
  const store = await mkdtemp(join(tmpdir(), 'release-summary-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const state = {
    plan: { id: 'release-' + 'a'.repeat(24), source: 'a'.repeat(40), platforms: ['ios'] },
    stages: {
      checks: { status: 'succeeded', output: { large: 'x'.repeat(10000) } },
      build: { status: 'unknown', error: 'Reconcile before retry' },
    },
    outcomes: { ios: { state: 'unknown' } },
    uiValidation: {
      state: 'passed',
      evidenceReused: true,
      evidenceFinishedAt: 'earlier',
      evidence: { large: 'x'.repeat(10000) },
    },
  };
  const directory = releasePath(store, state.plan.id);
  await saveState(directory, state);
  const snapshot = async () =>
    Promise.all(
      (await readdir(join(directory, 'events')))
        .sort()
        .map(async (file) => [file, await readFile(join(directory, 'events', file), 'utf8')]),
    );
  const before = await snapshot();
  let full, summary;
  for (const flag of [false, true]) {
    assert.equal(
      await main({
        args: ['status', state.plan.id, '--state-dir', store, ...(flag ? ['--summary'] : [])],
        command: async () => assert.fail('Unexpected tool'),
        output: (value) => {
          if (flag) summary = JSON.parse(value);
          else full = JSON.parse(value);
        },
      }),
      0,
    );
  }
  assert.equal(full.stages.checks.output.large.length, 10000);
  assert.equal(summary.stages.build.status, 'unknown');
  assert.match(summary.stages.build.error, /Reconcile/);
  assert.equal(summary.uiValidation.evidenceReused, true);
  assert.deepEqual(summary.outcomes, full.outcomes);
  assert.equal(summary.stages.checks.output, undefined);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 5);
  assert.deepEqual(await snapshot(), before);
});

test('dispatch summaries do not turn running, failed or retired work into success', () => {
  for (const state of ['pending', 'running', 'unknown', 'retired']) {
    const report = summarizeStatus('dispatch-status', {
      id: 'request-one',
      state,
      originalState: 'unknown',
      reconciliation: 'operator-attestation',
    });
    assert.equal(report.state, state);
    assert.equal(report.originalState, 'unknown');
    assert.equal(report.summaryOnly, true);
  }
  const failed = summarizeStatus('dispatch-status', {
    state: 'completed',
    result: { exitCode: 2, error: 'blocked' },
    claim: { token: 'private-token', createdAt: 'then' },
  });
  assert.equal(failed.result.exitCode, 2);
  assert.equal(failed.result.error, 'blocked');
  assert.equal(failed.claim, undefined);
});

test('remote polling and availability evidence survive the projection', () => {
  const value = {
    plan: { id: 'release-one' },
    statusPolling: { reason: 'timeout' },
    observations: { ios: { state: 'released', availabilityVerified: false } },
  };
  const summary = summarizeStatus('status', value);
  assert.deepEqual(summary.statusPolling, value.statusPolling);
  assert.deepEqual(summary.observations, value.observations);
});

test('completed dispatch compacts nested UI evidence while retaining scope, failure and provenance pointers', () => {
  const value = {
    id: 'request-one',
    state: 'completed',
    result: {
      exitCode: 2,
      summary: {
        operation: 'validate',
        releaseId: 'release-one',
        source: 'a'.repeat(40),
        scope: 'source-checks-and-synthetic-ios-simulator',
        recordDirectory: '/private/state/releases/release-one',
        diagnosticsDirectory: '/private/logs',
        validation: { state: 'passed', checksReused: true },
        uiValidation: {
          state: 'failed',
          evidenceReused: false,
          error: 'Mismatch',
          evidence: { reports: 'x'.repeat(10000) },
        },
      },
    },
  };
  const result = summarizeStatus('dispatch-status', value);
  assert.equal(result.result.exitCode, 2);
  assert.equal(result.result.summary.uiValidation.state, 'failed');
  assert.equal(result.result.summary.uiValidation.error, 'Mismatch');
  assert.equal(result.result.summary.uiValidation.evidence, undefined);
  assert.equal(result.result.summary.validation.checksReused, true);
  assert.equal(result.result.summary.recordDirectory, value.result.summary.recordDirectory);
  assert.equal(result.result.summary.source, value.result.summary.source);
  assert.ok(JSON.stringify(result).length < JSON.stringify(value).length / 5);
  const check = summarizeStatus('dispatch-status', {
    result: {
      summary: { kind: 'executor-check', controlHead: 'b'.repeat(40), source: 'a'.repeat(40) },
    },
  });
  assert.equal(check.result.summary.controlHead, 'b'.repeat(40));
});

test('summary cannot hide a content approval plan or start execution', async () => {
  for (const operation of ['store-plan', 'store-apply', 'run', 'resume', 'validate'])
    await assert.rejects(
      main({
        args: [operation, '--summary'],
        command: async () => assert.fail('Unexpected command'),
      }),
    );
});
