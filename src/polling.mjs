import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyOutcome } from './outcomes.mjs';

function boundedMilliseconds(value, maximum, name) {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum} milliseconds`);
}

async function withSignal(action, signal) {
  signal.throwIfAborted();
  // Keep managed ownership until the underlying operation and its cleanup settle.
  // A deadline requests cancellation; it cannot prove the operation has stopped.
  const result = await action();
  signal.throwIfAborted();
  return result;
}

function classify(state) {
  const platforms = state?.plan?.platforms;
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    platforms.some((platform) => !['ios', 'android', 'harmony'].includes(platform)) ||
    new Set(platforms).size !== platforms.length ||
    !state.observations ||
    typeof state.observations !== 'object' ||
    Array.isArray(state.observations)
  )
    throw new Error('Release status polling requires selected platforms and remote observations');
  const verified = (platform) =>
    classifyOutcome(state.observations[platform]) === 'available';
  if (platforms.every(verified)) return { reason: 'available' };
  const actionRequiredPlatforms = platforms.filter(
    (platform) => !verified(platform) && classifyOutcome(state.observations[platform]) !== 'waiting',
  );
  return actionRequiredPlatforms.length
    ? { reason: 'action-required', actionRequiredPlatforms }
    : null;
}

// observe must use the supplied signal for provider reads and check it before
// recording an observation. An aborted/late callback cannot establish a result
// here; cancellation must also prevent that callback from journaling partial data.
export async function waitForReleaseStatus({
  observe,
  timeoutMs,
  intervalMs = 30_000,
  signal,
  now = () => performance.now(),
  wait = (milliseconds, observationSignal) =>
    delay(milliseconds, undefined, { signal: observationSignal }),
} = {}) {
  boundedMilliseconds(timeoutMs, 3_600_000, 'Polling timeout');
  boundedMilliseconds(intervalMs, 300_000, 'Polling interval');
  if (typeof observe !== 'function' || typeof now !== 'function' || typeof wait !== 'function')
    throw new Error('Release status polling requires observation, clock and wait functions');
  const start = now();
  const deadline = start + timeoutMs;
  const controller = new AbortController();
  let stopped;
  const stop = (reason) => {
    stopped ??= reason;
    controller.abort(new Error(`Release status polling ${stopped}`));
  };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  let state = null;
  let attempts = 0;
  let observations = 0;
  const stopReason = () => {
    if (!stopped && now() >= deadline) stop('timeout');
    return stopped;
  };
  const result = (outcome) => ({
    state,
    polling: {
      ...outcome,
      attempts,
      observations,
      elapsedMs: Math.max(0, Math.ceil(now() - start)),
      timeoutMs,
      intervalMs,
    },
  });
  try {
    while (!stopReason()) {
      attempts++;
      const observed = await withSignal(() => observe(controller.signal), controller.signal);
      // A response arriving at/after the deadline is not successful evidence.
      if (stopReason()) break;
      const outcome = classify(observed);
      state = observed;
      observations++;
      if (outcome) return result(outcome);
      await withSignal(
        () => wait(Math.min(intervalMs, Math.max(0, deadline - now())), controller.signal),
        controller.signal,
      );
    }
    return result({ reason: stopReason() });
  } catch (error) {
    if (stopReason()) return result({ reason: stopped });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
