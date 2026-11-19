// Keep authentication and provider reads under the same observation deadline.
export async function observeStoreRead(options, target, action) {
  const { timeoutMs = 120_000, signal: parent } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw new Error('Read timeout must be 1–3600000 milliseconds');
  parent?.throwIfAborted();
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  const expire = () => controller.abort(new DOMException('Store read timed out', 'TimeoutError'));
  const timer = setTimeout(expire, timeoutMs);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const checkDeadline = () => {
    if (performance.now() >= deadlineAt) expire();
    signal.throwIfAborted();
  };
  const startedAt = new Date().toISOString();
  try {
    const result = await action(signal, checkDeadline);
    signal.throwIfAborted();
    return { schemaVersion: 1, ...result, target, source: 'official-api', readOnly: true,
      startedAt, observedAt: startedAt, completedAt: new Date().toISOString(),
      observationComplete: result.errors.length === 0 };
  } finally { clearTimeout(timer); }
}
