// Version-level interpretation only. It does not attest a candidate binary,
// full rollout, regions, device installation or a specific review attempt.
const reviewStates = {
  PREPARE_FOR_SUBMISSION: 'not-submitted', READY_FOR_REVIEW: 'not-submitted',
  WAITING_FOR_REVIEW: 'waiting', IN_REVIEW: 'in-review',
  REJECTED: 'rejected', METADATA_REJECTED: 'rejected', INVALID_BINARY: 'rejected',
  DEVELOPER_REJECTED: 'withdrawn',
  PENDING_DEVELOPER_RELEASE: 'approved', PENDING_APPLE_RELEASE: 'approved',
  PROCESSING_FOR_APP_STORE: 'approved', PROCESSING_FOR_DISTRIBUTION: 'approved',
  READY_FOR_SALE: 'approved', READY_FOR_DISTRIBUTION: 'approved',
};
const publicationStates = {
  PENDING_DEVELOPER_RELEASE: 'pending-release', PENDING_APPLE_RELEASE: 'processing',
  PROCESSING_FOR_APP_STORE: 'processing', PROCESSING_FOR_DISTRIBUTION: 'processing',
  READY_FOR_SALE: 'published', READY_FOR_DISTRIBUTION: 'published',
  REMOVED_FROM_SALE: 'removed', DEVELOPER_REMOVED_FROM_SALE: 'removed',
};
export function describeAppleVersionState(value) {
  const rawState = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : null;
  return { rawState, reviewState: reviewStates[rawState] ?? 'unknown',
    publicationState: publicationStates[rawState] ?? 'unknown' };
}
