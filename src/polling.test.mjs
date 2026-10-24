import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForReleaseStatus } from './polling.mjs';

const state = (observations, platforms = Object.keys(observations)) => ({
  plan: { platforms },
  observations,
});
const verified = { state: 'available', availabilityVerified: true };

function clock() {
  let time = 0;
  const waits = [];
  return {
    waits,
    now: () => time,
    advance: (amount) => (time += amount),
    wait: async (amount, signal) => {
      signal.throwIfAborted();
      waits.push(amount);
      time += amount;
    },
  };
}

test('polling follows processing and review to verified availability with spaced reads', async () => {
  const timing = clock();
  const snapshots = ['processing', 'submitted', 'in-review', 'released'].map((value) =>
    state({ ios: { state: value, availabilityVerified: false } }),
  );
  snapshots.push(state({ ios: verified }));
  let reads = 0;
  const result = await waitForReleaseStatus({
    observe: async (signal) => {
      assert.equal(signal.aborted, false);
      return snapshots[reads++];
    },
    timeoutMs: 10_000,
    intervalMs: 500,
    ...timing,
  });
  assert.equal(result.polling.reason, 'available');
  assert.equal(reads, 5);
  assert.equal(result.polling.observations, 5);
  assert.equal(result.state, snapshots[4]);
  assert.deepEqual(timing.waits, [500, 500, 500, 500]);
});

test('every selected platform needs verified availability; outcomes are not observations', async () => {
  const timing = clock();
  const selected = ['ios', 'android'];
  let reads = 0;
  const result = await waitForReleaseStatus({
    observe: async () => {
      reads++;
      return {
        ...state(
          { ios: verified, android: reads === 1 ? { state: 'in-review' } : verified },
          selected,
        ),
        outcomes: { ios: verified, android: verified },
      };
    },
    timeoutMs: 1_000,
    intervalMs: 100,
    ...timing,
  });
  assert.equal(result.polling.reason, 'available');
  assert.equal(reads, 2);
  const missing = await waitForReleaseStatus({
    observe: async () => state({ ios: verified }, selected),
    timeoutMs: 1_000,
    ...timing,
  });
  assert.equal(missing.polling.reason, 'action-required');
  assert.deepEqual(missing.polling.actionRequiredPlatforms, ['android']);
});

test('action-required states stop without additional observations or waits', async () => {
  for (const value of [
    'uploaded',
    'prepared',
    'blocked',
    'rejected',
    'unknown',
    'unavailable',
    'pending-release',
    'pending-review',
    'accepted',
    'pending_operator',
    'awaiting_acceptance',
    'failed',
    'superseded',
    'available',
    'future-provider-state',
  ]) {
    const timing = clock();
    let reads = 0;
    const result = await waitForReleaseStatus({
      observe: async () => {
        reads++;
        return state({ ios: verified, android: { state: value, availabilityVerified: false } });
      },
      timeoutMs: 1_000,
      ...timing,
    });
    assert.equal(result.polling.reason, 'action-required', value);
    assert.deepEqual(result.polling.actionRequiredPlatforms, ['android'], value);
    assert.equal(reads, 1, value);
    assert.deepEqual(timing.waits, [], value);
  }
});

test('deadline preserves the last completed observation and never performs a deadline read', async () => {
  const timing = clock();
  const latest = state({ ios: { state: 'released', availabilityVerified: false } });
  let reads = 0;
  const result = await waitForReleaseStatus({
    observe: async () => {
      reads++;
      return latest;
    },
    timeoutMs: 250,
    intervalMs: 100,
    ...timing,
  });
  assert.equal(result.polling.reason, 'timeout');
  assert.equal(result.state, latest);
  assert.equal(reads, 3);
  assert.deepEqual(timing.waits, [100, 100, 50]);
  assert.equal(result.polling.elapsedMs, 250);
});

test('interval exceeding total duration makes one observation then waits only to deadline', async () => {
  const timing = clock();
  const result = await waitForReleaseStatus({
    observe: async () => state({ ios: { state: 'processing' } }),
    timeoutMs: 20,
    intervalMs: 100,
    ...timing,
  });
  assert.equal(result.polling.reason, 'timeout');
  assert.equal(result.polling.attempts, 1);
  assert.deepEqual(timing.waits, [20]);
});

test('response crossing the deadline cannot replace prior evidence', async () => {
  const timing = clock();
  const earlier = state({ ios: { state: 'processing' } });
  let reads = 0;
  const result = await waitForReleaseStatus({
    observe: async () => {
      if (++reads === 1) return earlier;
      timing.advance(100);
      return state({ ios: verified });
    },
    timeoutMs: 100,
    intervalMs: 50,
    ...timing,
  });
  assert.equal(result.polling.reason, 'timeout');
  assert.equal(result.polling.attempts, 2);
  assert.equal(result.polling.observations, 1);
  assert.equal(result.state, earlier);
});

test('a pending provider read receives deadline cancellation; late success is ignored', async () => {
  let observedSignal;
  let settled = false;
  const result = await waitForReleaseStatus({
    observe: async (signal) => {
      observedSignal = signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await delay(30);
      settled = true;
      return state({ ios: verified });
    },
    timeoutMs: 20,
    intervalMs: 10,
  });
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.polling.reason, 'timeout');
  assert.equal(result.polling.observations, 0);
  assert.equal(result.state, null);
  assert.equal(settled, true, 'return only after the observation and its cleanup settle');
});

test('caller cancellation stops a pending provider read without fabricating an observation', async () => {
  const caller = new AbortController();
  let observedSignal;
  const result = await waitForReleaseStatus({
    observe: async (signal) => {
      observedSignal = signal;
      caller.abort();
      return state({ ios: verified });
    },
    signal: caller.signal,
    timeoutMs: 1_000,
  });
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.polling.reason, 'cancelled');
  assert.equal(result.polling.observations, 0);
  assert.equal(result.state, null);
});

test('cancellation while waiting retains completed evidence and performs no extra read', async () => {
  const caller = new AbortController();
  const earlier = state({ ios: { state: 'in-review' } });
  const result = await waitForReleaseStatus({
    observe: async () => earlier,
    wait: async () => {
      caller.abort();
    },
    signal: caller.signal,
    timeoutMs: 1_000,
  });
  assert.equal(result.polling.reason, 'cancelled');
  assert.equal(result.polling.attempts, 1);
  assert.equal(result.state, earlier);
});

test('already cancelled polling never invokes observation', async () => {
  const caller = new AbortController();
  caller.abort();
  const result = await waitForReleaseStatus({
    observe: async () => assert.fail('unexpected observation'),
    signal: caller.signal,
    timeoutMs: 1_000,
  });
  assert.equal(result.polling.reason, 'cancelled');
  assert.equal(result.polling.attempts, 0);
  assert.equal(result.state, null);
});

test('unexpected observation errors remain errors rather than successful or timeout results', async () => {
  const failure = new Error('journal integrity failure');
  await assert.rejects(
    waitForReleaseStatus({
      observe: async () => {
        throw failure;
      },
      timeoutMs: 1_000,
    }),
    (error) => error === failure,
  );
});

test('invalid timing and observation shape cannot busy poll or claim availability', async () => {
  for (const timeoutMs of [undefined, 0, -1, 0.5, NaN, Infinity, 3_600_001])
    await assert.rejects(
      waitForReleaseStatus({ observe: async () => assert.fail('unexpected read'), timeoutMs }),
      /Polling timeout/,
    );
  for (const intervalMs of [0, -1, 0.5, NaN, Infinity, 300_001])
    await assert.rejects(
      waitForReleaseStatus({
        observe: async () => assert.fail('unexpected read'),
        timeoutMs: 100,
        intervalMs,
      }),
      /Polling interval/,
    );
  for (const invalid of [null, {}, state({}, []), state({}, ['ios', 'ios']), state({}, ['other'])])
    await assert.rejects(
      waitForReleaseStatus({ observe: async () => invalid, timeoutMs: 100 }),
      /requires selected platforms/,
    );
});
