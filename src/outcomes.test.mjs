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


test('uploaded success is restricted to upload-only intent and accepted is not upload completion', () => {
  const state = { plan: { platforms: ['ios'] }, publicationRequested: false,
    outcomes: { ios: { state: 'uploaded' } } };
  assert.equal(releaseExitCode(state), 2);
  assert.equal(releaseExitCode({ ...state, uploadRequested: true }), 0);
  assert.equal(releaseExitCode({ ...state, uploadRequested: true, publicationRequested: true }), 2);
  assert.equal(releaseExitCode({ ...state, uploadRequested: true,
    outcomes: { ios: { state: 'accepted' } } }), 2);
  assert.equal(releaseExitCode({ ...state, uploadRequested: true,
    outcomes: { ios: { state: 'unknown' } } }), 2);
});
