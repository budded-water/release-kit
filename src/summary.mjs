// Presentation only. Never persist this projection or use it for recovery/approval.
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
  );

const validation = (value) =>
  pick(value, [
    'scope',
    'state',
    'source',
    'startedAt',
    'finishedAt',
    'checksReused',
    'checksFinishedAt',
    'evidenceReused',
    'evidenceFinishedAt',
    'error',
  ]);

function executionSummary(value) {
  return {
    ...pick(value, [
      'schemaVersion',
      'kind',
      'operation',
      'releaseId',
      'source',
      'controlHead',
      'nodeVersion',
      'scope',
      'publicationRequested',
      'outcomes',
      'recordDirectory',
      'diagnosticsDirectory',
    ]),
    ...Object.fromEntries(
      ['validation', 'uiValidation']
        .filter((key) => value?.[key])
        .map((key) => [key, validation(value[key])]),
    ),
  };
}

export function summarizeStatus(operation, value) {
  if (!['status', 'dispatch-status'].includes(operation) || !value || typeof value !== 'object')
    throw new Error('Status summary requires an existing release or dispatch record');
  const notice = {
    summaryOnly: true,
    scope:
      'Progress projection only; not acceptance or retry authority. Omit --summary for full evidence.',
  };
  if (operation === 'dispatch-status')
    return {
      ...notice,
      ...pick(value, [
        'id',
        'releaseId',
        'operation',
        'state',
        'executor',
        'originalState',
        'reconciliation',
        'retirementDigest',
      ]),
      ...(value.result
        ? {
            result: {
              ...pick(value.result, ['state', 'exitCode', 'finishedAt', 'error']),
              ...(value.result.summary ? { summary: executionSummary(value.result.summary) } : {}),
            },
          }
        : {}),
      ...(value.claim ? { claimedAt: value.claim.createdAt } : {}),
    };
  return {
    ...notice,
    releaseId: value.plan?.id,
    source: value.plan?.source,
    platforms: value.plan?.platforms,
    ...pick(value, ['publicationRequested', 'outcomes', 'observations', 'statusPolling']),
    stages: Object.fromEntries(
      Object.entries(value.stages ?? {}).map(([name, stage]) => [
        name,
        pick(stage, ['status', 'startedAt', 'finishedAt', 'error']),
      ]),
    ),
    ...Object.fromEntries(
      ['sourceValidation', 'uiValidation']
        .filter((key) => value[key])
        .map((key) => [key, validation(value[key])]),
    ),
  };
}
