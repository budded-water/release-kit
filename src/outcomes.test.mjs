import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseExitCode } from './outcomes.mjs';

test('exit success requires recognized results for every selected platform', () => {
  const base = { plan: { platforms: ['ios', 'android'] }, publicationRequested: true };
  const verified = { state: 'available', availabilityVerified: true };
  assert.equal(releaseExitCode({ ...base, outcomes: { ios: verified } }), 2);
  assert.equal(releaseExitCode({ ...base, outcomes: { ios: verified, android: { state: 'future' } } }), 2);
  assert.equal(releaseExitCode({ ...base, outcomes: { ios: verified, android: { state: 'submitted' } } }), 0);
  assert.equal(releaseExitCode({ ...base, plan: { platforms: [] }, outcomes: {} }), 2);
  for (const publicationRequested of [false, true]) {
    assert.equal(releaseExitCode({ plan: { platforms: ['harmony'] }, publicationRequested,
      outcomes: { harmony: { state: 'accepted' } } }), publicationRequested ? 2 : 0);
  }
});
