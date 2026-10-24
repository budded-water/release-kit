// Shared CLI/polling interpretation. Progress is not verified availability.
const waiting = new Set(['processing', 'submitted', 'in-review', 'released']);

export function classifyOutcome(outcome) {
  if (outcome?.state === 'available' && outcome.availabilityVerified === true)
    return 'available';
  if (waiting.has(outcome?.state)) return 'waiting';
  if (outcome?.state === 'accepted') return 'accepted';
  return 'action-required';
}

export function releaseExitCode(state) {
  const platforms = state?.plan?.platforms;
  if (!Array.isArray(platforms) || !platforms.length ||
      new Set(platforms).size !== platforms.length ||
      platforms.some((platform) => !['ios', 'android', 'harmony'].includes(platform))) return 2;
  return platforms.every((platform) => {
    const classification = classifyOutcome(state.outcomes?.[platform]);
    return classification === 'available' || classification === 'waiting' ||
      (classification === 'accepted' && state.publicationRequested !== true);
  }) ? 0 : 2;
}
