import { lstat, readFile, unlink } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import {
  acquireLock as acquireStateLock,
  atomicJson,
  digest,
  loadState,
  privateDirectory,
  readJson,
  releasePath,
  saveState,
} from './state.mjs';
import {
  assertCheckout,
  assertProductionSource,
  prepareCheckout,
  readAcceptance,
  acceptanceConfig,
} from './plan.mjs';
import { prepareStoreContent } from './store-content.mjs';
import { requireProject } from './project.mjs';
import { createCleanupGuard } from './cleanup.mjs';

const now = () => new Date().toISOString();
function assertNativeWorkspace(directory) {
  if (/\s/.test(directory))
    throw new Error(
      'Native release workspaces must not contain whitespace. Coordinate a state-store migration before running native validation; do not create a second publication ledger.',
    );
}
function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function observationError(code, message) {
  return Object.assign(new Error(message), { code });
}
function observationSummary(value) {
  if (!value || !/^[a-z][a-z_-]{0,79}$/.test(value.state ?? ''))
    throw new Error('Invalid provider observation');
  const summary = { state: value.state };
  if (typeof value.availabilityVerified === 'boolean')
    summary.availabilityVerified = value.availabilityVerified;
  for (const key of ['providerState', 'buildId', 'versionId', 'editId', 'destination']) {
    if (typeof value[key] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value[key]))
      summary[key] = value[key];
  }
  if (typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)))
    summary.observedAt = new Date(value.observedAt).toISOString();
  return summary;
}
function versionIsHigher(next, previous) {
  if (![next, previous].every((value) => /^\d+(?:\.\d+){0,2}$/.test(String(value)))) return false;
  const left = String(next).split('.').map(BigInt);
  const right = String(previous).split('.').map(BigInt);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0n) !== (right[index] ?? 0n))
      return (left[index] ?? 0n) > (right[index] ?? 0n);
  }
  return false;
}
export function createRunner({
  repo,
  store,
  config,
  command,
  adapters,
  project,
  environment = process.env,
  signal,
}) {
  const cleanup = createCleanupGuard(store, command);
  command = cleanup.command;
  const acquireLock = async (path) => {
    await cleanup.assertSafe();
    const unlock = await acquireStateLock(path);
    return async () => {
      if (!cleanup.blocked) await unlock();
    };
  };
  const env = {
    ...environment,
    EXPO_NO_DOTENV: '1',
    CI: '1',
    // npm's env-node launcher and its child scripts must use the same runtime
    // as this release process, including source checks that never configure UI.
    PATH: [dirname(process.execPath), environment.PATH].filter(Boolean).join(delimiter),
  };
  const errorMessage = (error) => {
    let message = String(error.message ?? 'Release step failed').slice(0, 2000);
    for (const [name, value] of Object.entries(environment))
      if (/token|secret|password|private.?key/i.test(name) && value && value.length > 3)
        message = message.split(value).join('[redacted]');
    return message;
  };
  async function step(
    state,
    directory,
    key,
    task,
    { sideEffect = false, reconcile = false, repeat = false } = {},
  ) {
    await cleanup.assertSafe();
    if (signal?.aborted) throw new Error('Release execution interrupted');
    const previous = state.stages[key];
    if (previous?.status === 'succeeded' && !repeat) return previous.output;
    if (sideEffect && previous && !reconcile)
      throw new Error(
        `${key} has an unresolved build attempt. Inspect its output and remote version allocation; use a new explicitly planned build attempt after reconciliation. Automatic rebuild is disabled.`,
      );
    state.stages[key] = {
      status: 'running',
      startedAt: now(),
      attempt: (previous?.attempt ?? 0) + 1,
    };
    await saveState(directory, state);
    try {
      const output = await cleanup.run(task);
      state.stages[key] = {
        ...state.stages[key],
        status: 'succeeded',
        finishedAt: now(),
        output: output ?? null,
      };
      await saveState(directory, state);
      return output;
    } catch (error) {
      state.stages[key] = {
        ...state.stages[key],
        status: sideEffect ? 'unknown' : 'failed',
        finishedAt: now(),
        error: errorMessage(error),
        ...(error.cleanupIncomplete === true ? { cleanupIncomplete: true } : {}),
      };
      await saveState(directory, state);
      throw error;
    }
  }
  async function verifyProductionSource(state, directory, platform, root, operation) {
    await cleanup.assertSafe();
    if (!['ios', 'android'].includes(platform)) return;
    let verification;
    try {
      verification = await assertProductionSource({ repo, root, plan: state.plan, command });
    } catch (error) {
      error.releaseSourceRejected = true;
      throw error;
    }
    state.sourceVerifications ??= {};
    state.sourceVerifications[platform] = { ...verification, operation };
    await saveState(directory, state);
  }
  const context = (state, directory, platform, root) => ({
    root,
    repoRoot: repo,
    releaseDir: outputDirectory(state, directory, platform),
    platform,
    plan: state.plan,
    config,
    env,
    command,
    signal,
    publicationRequested: state.publicationRequested,
    artifact: state.artifacts[platform],
    preparation: state.storePreparation?.[platform],
    assertPublicationSource: () =>
      verifyProductionSource(state, directory, platform, root, 'publication'),
    previous: (state.checkpoints[platform] ??= {}),
    checkpoint: async (name, data) => {
      state.checkpoints[platform] ??= {};
      state.checkpoints[platform][name] = data;
      await saveState(directory, state);
    },
  });
  const outputDirectory = (state, directory, platform) =>
    (state.buildAttempts?.[platform] ?? 1) === 1
      ? directory
      : join(directory, 'attempts', `${platform}-${state.buildAttempts[platform]}`);
  const checkoutDirectory = (state, directory, platform) =>
    join(
      directory,
      `build-${platform}${(state.buildAttempts?.[platform] ?? 1) === 1 ? '' : `-attempt-${state.buildAttempts[platform]}`}`,
    );
  async function inspect(state, directory, platform, root) {
    const artifact = state.artifacts[platform];
    if (!artifact?.path || artifact.platform !== platform)
      throw new Error('Missing or mismatched artifact');
    const hash = digest(await readFile(artifact.path));
    if (hash !== artifact.sha256) throw new Error('Artifact changed after inspection');
    const fresh = await cleanup.run(() =>
      adapters[platform].inspect(context(state, directory, platform, root)));
    if (
      fresh.sha256 !== artifact.sha256 ||
      fresh.appId !== artifact.appId ||
      String(fresh.buildNumber) !== String(artifact.buildNumber)
    )
      throw new Error('Artifact identity no longer matches the release record');
    return { ...artifact, ...fresh };
  }
  const projectContext = (root, source) => ({ root, source, config, command, env, environment, signal });
  async function validateSource(state, directory) {
    const hooks = requireProject(project);
    // Explicit semantic identity covers trusted hook dependencies, not just their
    // function text. Legacy adapters remain executable but cannot reuse a pass.
    const policy = hooks.sourceValidationPolicy === undefined ? null : digest({
      contract: 'release-kit/source-validation/v2',
      project: hooks.sourceValidationPolicy,
      node: process.version,
    });
    state.sourceValidation = {
      scope: 'source-checks',
      state: 'running',
      source: state.plan.source,
      command: hooks.checksDescription,
      policy,
      startedAt: now(),
    };
    await saveState(directory, state);
    try {
      if (signal?.aborted) throw new Error('Release execution interrupted');
      const root = join(directory, 'validation');
      await prepareCheckout({ repo, root, source: state.plan.source, command });
      const installationReused = policy !== null &&
        state.stages['install-validation']?.status === 'succeeded' &&
        state.stages['install-validation'].output?.policy === policy;
      const checksReused = installationReused &&
        state.stages.checks?.status === 'succeeded' &&
        state.stages.checks.output?.policy === policy;
      // Revoke stale passes durably before a replacement installation can fail or
      // be interrupted. Original outputs remain in the append-only journal.
      for (const [key, reused] of [
        ['install-validation', installationReused], ['checks', checksReused],
      ]) {
        if (!reused && state.stages[key]?.status === 'succeeded') {
          state.stages[key] = {
            ...state.stages[key], status: 'invalidated',
            invalidatedAt: now(), reason: 'source-validation-policy-unverified',
          };
        }
      }
      await saveState(directory, state);
      await step(state, directory, 'install-validation', async () => {
        await hooks.installValidation(projectContext(root, state.plan.source));
        return { policy };
      });
      await step(state, directory, 'checks', async () => {
        await hooks.checkSource(projectContext(root, state.plan.source));
        await assertCheckout(root, state.plan.source, command);
        if (signal?.aborted) throw new Error('Release execution interrupted');
        return { source: state.plan.source, command: hooks.checksDescription, policy };
      });
      await assertCheckout(root, state.plan.source, command);
      if (signal?.aborted) throw new Error('Release execution interrupted');
      state.sourceValidation = {
        ...state.sourceValidation,
        state: 'passed',
        finishedAt: now(),
        checksReused,
        checksFinishedAt: state.stages.checks.finishedAt,
      };
      await saveState(directory, state);
      return root;
    } catch (error) {
      state.sourceValidation = {
        ...state.sourceValidation,
        state: 'failed',
        finishedAt: now(),
        error: errorMessage(error),
      };
      await saveState(directory, state);
      throw error;
    }
  }
  async function validateUI(state, directory, root) {
    const hooks = requireProject(project);
    await step(state, directory, 'ui-eval', async () => {
      const evidence = await hooks.evaluateUI(projectContext(root, state.plan.source));
      await assertCheckout(root, state.plan.source, command);
      if (signal?.aborted) throw new Error('Release execution interrupted');
      return evidence;
    });
    try {
      await assertCheckout(root, state.plan.source, command);
      const evidence = state.stages['ui-eval'].output;
      // A historical pass is reusable only after current evidence validation.
      if (digest(await readFile(evidence.path)) !== evidence.sha256)
        throw new Error('Recorded UI-eval evidence has changed');
      await hooks.revalidateUI({ ...projectContext(root, state.plan.source), evidence });
      if (signal?.aborted) throw new Error('Release execution interrupted');
      return evidence;
    } catch (error) {
      await cleanup.capture(error);
      state.stages['ui-eval'] = {
        ...state.stages['ui-eval'],
        status: 'invalidated',
        invalidatedAt: now(),
        reason: 'ui-evidence-unverified',
        ...(error.cleanupIncomplete === true ? { cleanupIncomplete: true } : {}),
      };
      await saveState(directory, state);
      throw error;
    }
  }
  async function validateGates(state, directory, ui) {
    if (ui) {
      // Revoke the previous invocation's pass before checks or resource admission.
      // Historical successful stages remain available for verified evidence reuse.
      state.uiValidation = {
        scope: requireProject(project).uiScope,
        state: 'running',
        source: state.plan.source,
        startedAt: now(),
      };
      await saveState(directory, state);
    }
    try {
      if (ui) assertNativeWorkspace(directory);
      const root = await validateSource(state, directory);
      if (!ui) return;
      const unlock = await acquireLock(join(store, 'locks', 'ui-eval.lock'));
      try {
        const evidenceReused = state.stages['ui-eval']?.status === 'succeeded';
        const evidence = await cleanup.run(() => validateUI(state, directory, root));
        if (signal?.aborted) throw new Error('Release execution interrupted');
        state.uiValidation = {
          ...state.uiValidation,
          state: 'passed',
          finishedAt: now(),
          evidenceReused,
          evidenceFinishedAt: state.stages['ui-eval'].finishedAt,
          evidence,
        };
        await saveState(directory, state);
      } finally {
        await unlock();
      }
    } catch (error) {
      if (ui) {
        state.uiValidation = {
          scope: requireProject(project).uiScope,
          source: state.plan.source,
          startedAt: state.uiValidation.startedAt,
          state: 'failed',
          finishedAt: now(),
          error: errorMessage(error),
        };
        await saveState(directory, state);
      }
      throw error;
    }
  }
  async function beginAcceptance(state, directory, platform) {
    state.acceptanceStatus ??= {};
    const previous = state.acceptanceStatus[platform];
    const receipt = state.acceptance[platform];
    if (previous || receipt) {
      state.acceptanceHistory ??= [];
      state.acceptanceHistory.push({
        platform,
        ...(previous ?? { state: 'passed' }),
        ...(receipt ? { receipt } : {}),
        supersededAt: now(),
      });
    }
    delete state.acceptance[platform];
    state.acceptanceStatus[platform] = { state: 'pending', startedAt: now() };
    // Commit revocation before reading a replacement receipt or invoking an
    // acceptance executable. A failure or crash cannot revive the old approval.
    await saveState(directory, state);
  }
  async function accept(state, directory, platform, root, supplied, acceptanceDigests) {
    let path = supplied?.[platform];
    const entry = acceptanceConfig(config, platform);
    if (!path && !entry?.command) return null;
    if (!path) await beginAcceptance(state, directory, platform);
    try {
      if (!path && entry?.command) {
        const input = join(directory, `${platform}-acceptance-input.json`);
        await atomicJson(input, {
          schemaVersion: 1,
          plan: state.plan,
          artifact: state.artifacts[platform],
          uiEval: state.stages['ui-eval'].output,
        });
        const result = await command(entry.command[0], [...entry.command.slice(1), input], {
          cwd: root,
          env,
          timeout: 1800000,
          sensitive: true,
        });
        const receipt = JSON.parse(result.stdout);
        if (receipt.provenance !== 'automation')
          throw new Error('Automated acceptance must declare automation provenance');
        path = join(directory, `${platform}-acceptance-${digest(receipt)}.json`);
        await atomicJson(path, receipt);
      }
      const receipt = await readAcceptance(
        path,
        state.plan,
        state.artifacts[platform],
        supplied[platform] ? acceptanceDigests[platform] : undefined,
      );
      state.acceptance[platform] = receipt;
      state.acceptanceStatus[platform] = {
        ...state.acceptanceStatus[platform],
        state: 'passed',
        finishedAt: now(),
        evidenceSha256: receipt.evidenceSha256,
      };
      await saveState(directory, state);
      return receipt;
    } catch (error) {
      delete state.acceptance[platform];
      state.acceptanceStatus[platform] = {
        ...state.acceptanceStatus[platform],
        state: 'failed',
        finishedAt: now(),
        error: errorMessage(error),
      };
      await saveState(directory, state);
      throw error;
    }
  }
  async function supersedeUnsubmitted(state, directory, platform, owner) {
    if (!['ios', 'android'].includes(platform)) return false;
    const previousDirectory = releasePath(store, owner.id);
    // The target lock is already held. The previous release must also be idle
    // while its fresh provider observation and supersession are journaled.
    const unlockPrevious = await acquireLock(join(store, 'locks', `${owner.id}.lock`));
    let unlockReservation;
    try {
      const previous = await loadState(previousDirectory);
      const artifact = previous?.artifacts?.[platform];
      const replacement = state.artifacts[platform];
      if (
        !artifact ||
        !replacement ||
        Object.keys(previous?.storePreparation?.[platform]?.steps ?? {}).length > 0 ||
        previous.plan.source !== owner.source ||
        previous.plan.repository !== state.plan.repository ||
        previous.plan.configDigest !== state.plan.configDigest ||
        artifact.appId !== replacement.appId ||
        !versionIsHigher(replacement.buildNumber, artifact.buildNumber) ||
        (replacement.version !== artifact.version &&
          !versionIsHigher(replacement.version, artifact.version))
      )
        return false;
      const providerKeys =
        platform === 'ios'
          ? ['ios-upload', 'ios-review']
          : ['android-edit', 'android-upload', 'android-track', 'android-commit'];
      const hasProviderIntent = (checkpoints) =>
        Object.keys(checkpoints).some((name) => name !== 'expo.environment');
      let reservation;
      const reservedId = previous.supersededBy?.[platform]?.releaseId;
      if (reservedId && reservedId !== state.plan.id) {
        // A crash may have recorded revocation without moving the target. A
        // later current-head successor can replace that reservation only while
        // its executor is idle and it has never begun provider publication.
        unlockReservation = await acquireLock(join(store, 'locks', `${reservedId}.lock`));
        reservation = await loadState(releasePath(store, reservedId));
        if (
          !reservation ||
          reservation.plan.repository !== state.plan.repository ||
          reservation.plan.configDigest !== state.plan.configDigest ||
          reservation.artifacts[platform]?.appId !== replacement.appId ||
          hasProviderIntent(reservation.checkpoints[platform] ?? {}) ||
          !versionIsHigher(replacement.buildNumber, reservation.artifacts[platform]?.buildNumber)
        )
          return false;
        await command(
          'git',
          ['merge-base', '--is-ancestor', reservation.plan.source, state.plan.source],
          { cwd: repo },
        );
      }
      const checkpoints = previous.checkpoints?.[platform] ?? {};
      const unpublished = !hasProviderIntent(checkpoints);
      const unuploadedEdit =
        platform === 'android' &&
        checkpoints['android-edit']?.state === 'created' &&
        typeof checkpoints['android-edit'].id === 'string' &&
        checkpoints['android-edit'].id.length > 0 &&
        ['android-upload', 'android-track', 'android-commit'].every(
          (name) => !Object.hasOwn(checkpoints, name),
        );
      if (
        Object.keys(checkpoints).some(
          (name) => name !== 'expo.environment' && !providerKeys.includes(name),
        )
      )
        return false;
      if (
        !unpublished &&
        platform === 'ios' &&
        (checkpoints['ios-upload']?.state !== 'uploaded' ||
          Object.hasOwn(checkpoints, 'ios-review'))
      )
        return false;
      if (
        !unpublished &&
        !unuploadedEdit &&
        platform === 'android' &&
        (checkpoints['android-upload']?.state !== 'uploaded' ||
          (Object.hasOwn(checkpoints, 'android-commit') &&
            checkpoints['android-commit']?.state !== 'not-committed'))
      )
        return false;
      let observation;
      if (!unpublished) {
        observation = await cleanup.run(() => adapters[platform].status(
          context(
            previous,
            previousDirectory,
            platform,
            checkoutDirectory(previous, previousDirectory, platform),
          ),
        ));
        previous.observations ??= {};
        previous.observations[platform] = observation;
        previous.observedAt = now();
        await saveState(previousDirectory, previous);
        const proof =
          platform === 'ios'
            ? observation.unsubmittedUpload
            : unuploadedEdit
              ? observation.unuploadedEdit
              : observation.uncommittedEdit;
        if (
          !proof ||
          !(unuploadedEdit ? ['prepared'] : ['uploaded', 'processing', 'blocked']).includes(
            observation.state,
          ) ||
          proof.source !== previous.plan.source ||
          proof.artifactSha256 !== artifact.sha256 ||
          proof.version !== artifact.version ||
          String(platform === 'ios' ? proof.buildNumber : proof.versionCode) !==
            String(artifact.buildNumber) ||
          !(platform === 'ios' ? proof.buildId : proof.editId) ||
          (platform === 'android' && proof.editId !== checkpoints['android-edit']?.id) ||
          (unuploadedEdit && (proof.uploadState !== 'absent' || proof.track !== 'production'))
        )
          return false;
      }
      const record = {
        platform,
        previousReleaseId: owner.id,
        replacementReleaseId: state.plan.id,
        source: previous.plan.source,
        replacementSource: state.plan.source,
        reason: unpublished
          ? 'no-provider-intent'
          : platform === 'ios'
            ? 'confirmed-unsubmitted-upload'
            : unuploadedEdit
              ? 'confirmed-unuploaded-edit'
              : 'confirmed-uncommitted-edit',
        ...(observation
          ? { observation }
          : {
              journalEvidence: {
                checkpointsSha256: digest(checkpoints),
                stage: previous.stages[`publish-${platform}`] ?? null,
              },
            }),
        ...(reservation ? { abandonedReservationId: reservedId } : {}),
        recordedAt: now(),
      };
      if (reservation) {
        reservation.supersededBy ??= {};
        reservation.supersededBy[platform] = {
          releaseId: state.plan.id,
          source: state.plan.source,
          record,
        };
        reservation.outcomes[platform] = {
          state: 'superseded',
          replacementReleaseId: state.plan.id,
        };
        await saveState(releasePath(store, reservedId), reservation);
      }
      previous.supersededBy ??= {};
      if (
        previous.supersededBy[platform]?.releaseId !== state.plan.id &&
        previous.supersededBy[platform]
      ) {
        previous.supersessionHistory ??= [];
        previous.supersessionHistory.push({ platform, ...previous.supersededBy[platform] });
      }
      previous.supersededBy[platform] = {
        releaseId: state.plan.id,
        source: state.plan.source,
        record,
      };
      previous.outcomes[platform] = { state: 'superseded', replacementReleaseId: state.plan.id };
      // Record the old release's revocation first. A crash between journal and
      // owner writes can be recovered by this plan or a verified newer plan
      // after the abandoned reservation is proven to have no provider intent.
      await saveState(previousDirectory, previous);
      state.supersessions ??= [];
      if (
        !state.supersessions.some(
          (entry) => entry.previousReleaseId === owner.id && entry.platform === platform,
        )
      )
        state.supersessions.push(record);
      await saveState(directory, state);
      return true;
    } finally {
      try {
        if (unlockReservation) await unlockReservation();
      } finally {
        await unlockPrevious();
      }
    }
  }
  async function publicationOwnership(state, directory, platform) {
    const appId = state.artifacts[platform]?.appId ?? state.plan.appIds[platform];
    const key = digest({ appId, platform, destination: state.plan.destinations[platform] });
    const ownerPath = join(store, 'targets', `${key}.json`);
    const unlock = await acquireLock(join(store, 'locks', `target-${key}.lock`));
    try {
      let owner;
      try {
        owner = await readJson(ownerPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (owner && owner.id !== state.plan.id) {
        if (state.stages[`publish-${platform}`])
          throw new Error(
            'This release was superseded; an older resume cannot overwrite the current publication owner',
          );
        if (owner.source === state.plan.source)
          throw new Error(
            'A release already owns this source and destination with different configuration',
          );
        await command('git', ['merge-base', '--is-ancestor', owner.source, state.plan.source], {
          cwd: repo,
        });
        const previous = await loadState(releasePath(store, owner.id));
        if (
          !['available', 'released', 'rejected'].includes(previous?.outcomes?.[platform]?.state) &&
          !(
            ((platform === 'ios' && previous?.storePreparation?.ios?.status === 'prepared') ||
              (platform === 'android' &&
                previous?.storePreparation?.android?.status === 'edit-unavailable')) &&
            !previous.stages[`publish-${platform}`] &&
            !previous.artifacts[platform] &&
            !Object.keys(previous.checkpoints[platform] ?? {}).length
          ) &&
          !(await supersedeUnsubmitted(state, directory, platform, owner))
        )
          throw new Error(
            `Publication target is owned by ${owner.id}; reconcile its outcome with status --remote before planning a replacement`,
          );
      }
      await atomicJson(ownerPath, {
        id: state.plan.id,
        source: state.plan.source,
        appId,
        platform,
        destination: state.plan.destinations[platform],
        claimedAt: now(),
      });
      return async ({ relinquish = false } = {}) => {
        if (cleanup.blocked) return;
        try {
          if (relinquish) {
            const current = await readJson(ownerPath);
            if (current.id !== state.plan.id)
              throw new Error('Publication ownership changed before target relinquishment');
            await unlink(ownerPath);
          }
        } finally {
          await unlock();
        }
      };
    } catch (error) {
      await unlock();
      throw error;
    }
  }
  async function withRelease(plan, task) {
    await cleanup.assertSafe();
    const directory = releasePath(store, plan.id);
    await privateDirectory(directory);
    const unlock = await acquireLock(join(store, 'locks', `${plan.id}.lock`));
    try {
      let state = await loadState(directory);
      if (state && digest(state.plan) !== digest(plan))
        throw new Error('Release plan identity mismatch');
      state ??= {
        schemaVersion: 1,
        plan,
        createdAt: now(),
        publicationRequested: false,
        stages: {},
        artifacts: {},
        checkpoints: {},
        acceptance: {},
        outcomes: {},
      };
      return await cleanup.run(() => task(state, directory));
    } finally {
      await unlock();
    }
  }
  async function prepareContent(plan, { mode = 'plan', approval } = {}) {
    if (plan.platforms.length !== 1 || !['ios', 'android'].includes(plan.platforms[0]))
      throw new Error('Store content preparation requires exactly one iOS/Android platform');
    return withRelease(plan, async (state, directory) => {
      const platform = plan.platforms[0];
      const root = join(directory, 'store-content-source');
      await prepareCheckout({ repo, root, source: plan.source, command });
      // A prepared edit/draft cannot be changed once publication has started.
      if (mode !== 'observe' && state.stages[`publish-${platform}`])
        throw new Error('Publication has started; only store-observe is allowed');
      let unlock;
      try {
        if (mode === 'apply') {
          // Check approval before claiming publication ownership.
          if (!approval || state.storePreparation?.[platform]?.approval !== approval)
            throw new Error('Apply requires the exact reviewed content approval digest');
          await verifyProductionSource(state, directory, platform, root, 'store-content');
        }
        const report = await cleanup.run(() => prepareStoreContent(
          {
            ...context(state, directory, platform, root),
            savePreparation: async (record) => {
              state.storePreparation ??= {};
              state.storePreparation[platform] = record;
              await saveState(directory, state);
            },
            session: adapters?.[platform]?.contentSession,
            acquirePreparationTarget: async () => {
              unlock = await publicationOwnership(state, directory, platform);
            },
          },
          { mode, approval },
        ));
        return {
          operation: `store-${mode}`,
          releaseId: plan.id,
          platform,
          recordDirectory: directory,
          ...report,
        };
      } finally {
        if (unlock)
          await unlock({
            relinquish:
              !Object.keys(state.storePreparation?.[platform]?.steps ?? {}).length &&
              !state.artifacts[platform] &&
              !state.stages[`publish-${platform}`] &&
              !Object.keys(state.checkpoints[platform] ?? {}).length,
          });
      }
    });
  }
  async function validate(plan, { ui = false } = {}) {
    if (typeof ui !== 'boolean') throw new Error('UI validation selection must be boolean');
    return withRelease(plan, async (state, directory) => {
      await validateGates(state, directory, ui);
      return state;
    });
  }
  async function execute(
    plan,
    { publish = false, acceptance = {}, acceptanceDigests = {}, retryBuild } = {},
  ) {
    return withRelease(plan, async (state, directory) => {
      for (const platform of Object.keys(acceptance)) {
        if (!plan.platforms.includes(platform) || !acceptance[platform])
          throw new Error('Acceptance input must identify a selected platform and receipt path');
      }
      for (const [platform, sha256] of Object.entries(acceptanceDigests)) {
        if (!acceptance[platform] || !/^[a-f0-9]{64}$/.test(sha256))
          throw new Error('Pinned acceptance digest must identify a supplied platform receipt');
      }
      for (const platform of Object.keys(acceptance))
        await beginAcceptance(state, directory, platform);
      for (const platform of plan.platforms) {
        // Older journals cannot distinguish a valid saved approval from one
        // retained after a failed replacement. Require a fresh receipt once.
        if (state.acceptance[platform] && state.acceptanceStatus?.[platform]?.state !== 'passed')
          await beginAcceptance(state, directory, platform);
      }
      if (retryBuild) {
        const { platform, reason } = retryBuild;
        if (
          !plan.platforms.includes(platform) ||
          typeof reason !== 'string' ||
          reason.trim().length < 10 ||
          reason.length > 2000
        )
          throw new Error('Build retry requires a selected platform and a reconciliation reason');
        const stage = state.stages[`build-${platform}`];
        if (
          !stage ||
          !['unknown', 'failed', 'running'].includes(stage.status) ||
          Object.keys(state.checkpoints[platform] ?? {}).some(
            (key) => key !== (platform === 'harmony' ? 'harmony.sign.intent' : 'expo.environment'),
          ) ||
          state.stages[`publish-${platform}`]
        )
          throw new Error(
            'Only an unresolved build without publication checkpoints can be retried',
          );
        state.retiredBuilds ??= [];
        state.retiredBuilds.push({
          platform,
          stage,
          checkpoints: state.checkpoints[platform],
          attempt: state.buildAttempts?.[platform] ?? 1,
          reconciledAt: now(),
          provenance: 'operator',
          reason,
        });
        state.buildAttempts ??= {};
        state.buildAttempts[platform] = (state.buildAttempts[platform] ?? 1) + 1;
        for (const key of ['doctor', 'install', 'build']) delete state.stages[`${key}-${platform}`];
        delete state.artifacts[platform];
        delete state.acceptance[platform];
        delete state.checkpoints[platform];
      }
      state.publicationRequested = state.publicationRequested || publish;
      await saveState(directory, state);
      // Installed Expo native phases cannot safely expand workspace paths with
      // whitespace. Source-only validation remains usable in such directories.
      assertNativeWorkspace(directory);
      if (state.publicationRequested) {
        for (const platform of plan.platforms) {
          const preflight = adapters[platform].preflight;
          const providerKeys =
            platform === 'ios'
              ? ['ios-upload', 'ios-review']
              : ['android-edit', 'android-upload', 'android-track', 'android-commit'];
          // Existing intents must stay reconcilable even when provider drafts
          // have become read-only or a newer readiness policy would reject them.
          if (!preflight || providerKeys.some((key) => state.checkpoints[platform]?.[key]))
            continue;
          const root = join(directory, 'validation');
          await prepareCheckout({ repo, root, source: plan.source, command });
          await privateDirectory(outputDirectory(state, directory, platform));
          await step(
            state,
            directory,
            `preflight-${platform}`,
            async () => {
              const result = await preflight(context(state, directory, platform, root));
              const failures = result.checks.filter((check) => !check.ok);
              if (failures.length)
                throw new Error(
                  failures.map((check) => `${check.name}: ${check.message}`).join('; '),
                );
              return result;
            },
            { repeat: true },
          );
        }
      }
      await validateGates(state, directory, true);
      for (const platform of plan.platforms) {
        if (signal?.aborted) throw new Error('Release execution interrupted');
        const root = checkoutDirectory(state, directory, platform);
        try {
          if (state.supersededBy?.[platform])
            throw new Error('This release was superseded; an older resume cannot publish again');
          await prepareCheckout({ repo, root, source: plan.source, command });
          await privateDirectory(outputDirectory(state, directory, platform));
          await step(state, directory, `install-${platform}`, () =>
            requireProject(project).installBuild({ ...projectContext(root, state.plan.source), platform }),
          );
          await assertCheckout(root, plan.source, command);
          const ctx = context(state, directory, platform, root);
          await step(
            state,
            directory,
            `doctor-${platform}`,
            async () => {
              const result = await adapters[platform].doctor(ctx);
              const failures = result.checks.filter((check) => !check.ok);
              if (failures.length)
                throw new Error(
                  failures.map((check) => `${check.name}: ${check.message}`).join('; '),
                );
              return result;
            },
            { repeat: true },
          );
          if (!state.stages[`build-${platform}`])
            await verifyProductionSource(state, directory, platform, root, 'build');
          const artifact = await step(
            state,
            directory,
            `build-${platform}`,
            () => adapters[platform].build(context(state, directory, platform, root)),
            { sideEffect: true },
          );
          const recorded = state.artifacts[platform];
          if (
            recorded &&
            ['path', 'sha256', 'platform', 'appId', 'version', 'buildNumber'].some(
              (key) => String(recorded[key]) !== String(artifact[key]),
            )
          )
            throw new Error(
              'Recorded inspected artifact differs from the successful build identity',
            );
          // Successful build output is immutable and may predate a later
          // inspection upgrade. Preserve that proof only for identical bytes
          // and package identity; a cached build must never erase it on resume.
          state.artifacts[platform] = { ...artifact, ...recorded };
          await saveState(directory, state);
          await assertCheckout(root, plan.source, command);
          state.artifacts[platform] = await inspect(state, directory, platform, root);
          await saveState(directory, state);
          if (!state.acceptance[platform] || acceptance[platform])
            await accept(state, directory, platform, root, acceptance, acceptanceDigests);
          if (!state.publicationRequested) {
            state.outcomes[platform] = {
              state: state.acceptance[platform] ? 'accepted' : 'awaiting_acceptance',
            };
            continue;
          }
          if (!state.acceptance[platform]) {
            state.outcomes[platform] = {
              state: 'awaiting_acceptance',
              message:
                'Provide a native acceptance receipt or configure an acceptance executable before publication',
            };
            continue;
          }
          const prior = state.stages[`publish-${platform}`];
          const observeOnly =
            prior?.status === 'succeeded' &&
            prior.output?.retryable !== true &&
            !['processing', 'uploaded', 'unknown', 'prepared'].includes(prior.output?.state);
          const publicationKeys =
            platform === 'ios'
              ? ['ios-upload', 'ios-review']
              : ['android-edit', 'android-upload', 'android-track', 'android-commit'];
          // A stopped first submission must not claim a target that prevents a
          // fresh release from progressing. Existing provider operations still
          // enter the adapter for read-only reconciliation.
          if (!observeOnly && !publicationKeys.some((key) => state.checkpoints[platform]?.[key]))
            await verifyProductionSource(state, directory, platform, root, 'publication');
          const releaseTarget = await publicationOwnership(state, directory, platform);
          let relinquish = false;
          try {
            if (observeOnly) {
              state.outcomes[platform] = await cleanup.run(() => adapters[platform].status(
                context(state, directory, platform, root),
              ));
            } else {
              state.outcomes[platform] = await step(
                state,
                directory,
                `publish-${platform}`,
                () => adapters[platform].publish(context(state, directory, platform, root)),
                { sideEffect: true, reconcile: true, repeat: true },
              );
            }
          } catch (error) {
            // The default branch can advance between the initial gate and an
            // adapter's first intent. No journaled provider intent means there
            // is no publication to reconcile or keep the target reserved for.
            relinquish =
              error.releaseSourceRejected === true &&
              !Object.keys(state.storePreparation?.[platform]?.steps ?? {}).length &&
              !publicationKeys.some((key) => state.checkpoints[platform]?.[key]);
            throw error;
          } finally {
            await releaseTarget({ relinquish });
          }
        } catch (error) {
          state.outcomes[platform] = { state: 'blocked', message: errorMessage(error) };
          await cleanup.capture(error);
          await cleanup.assertSafe();
        } finally {
          await saveState(directory, state);
        }
      }
      return state;
    });
  }
  async function status(id, { remote = false, observationSignal = signal } = {}) {
    const directory = releasePath(store, id);
    if (!remote) {
      const state = await loadState(directory);
      if (!state) throw new Error('Unknown release ID');
      return state;
    }
    const unlock = await acquireLock(join(store, 'locks', `${id}.lock`));
    try {
      const state = await loadState(directory);
      if (!state) throw new Error('Unknown release ID');
      const observed = {};
      for (const platform of state.plan.platforms) {
        observationSignal?.throwIfAborted();
        try {
          observed[platform] = await cleanup.run(() => adapters[platform].status({
            ...context(state, directory, platform, checkoutDirectory(state, directory, platform)),
            signal: observationSignal,
          }));
        } catch (error) {
          await cleanup.capture(error);
          await cleanup.assertSafe();
          observationSignal?.throwIfAborted();
          observed[platform] = { state: 'unknown', message: errorMessage(error) };
        }
        observationSignal?.throwIfAborted();
        if (state.stages[`publish-${platform}`]) state.outcomes[platform] = observed[platform];
      }
      state.observedAt = now();
      state.observations = observed;
      await saveState(directory, state);
      return state;
    } finally {
      await unlock();
    }
  }
  // Scheduled observation must not inherit status()'s durable outcome updates:
  // those updates can affect a successor's publication-target eligibility.
  async function observe(id) {
    signal?.throwIfAborted();
    let directory;
    let unlock;
    try {
      directory = releasePath(store, id);
      unlock = await acquireLock(join(store, 'locks', `${id}.lock`));
    } catch (error) {
      if (error.message?.startsWith('Execution lock exists: '))
        throw observationError('OBSERVATION_BUSY', 'Release observation is busy');
      throw observationError(
        'INVALID_RECORD',
        'Release observation identity or storage is invalid',
      );
    }
    try {
      signal?.throwIfAborted();
      let state;
      try {
        // The lock validates store ancestors; also reject redirected journal
        // directories before loadState follows them. Never create missing history.
        for (const path of [join(store, 'releases'), directory, join(directory, 'events')]) {
          if (!(await lstat(path)).isDirectory()) throw new Error('Invalid journal path');
        }
        state = await loadState(directory);
      } catch {
        throw observationError(
          'INVALID_RECORD',
          'Release observation history is missing, redirected or invalid',
        );
      }
      const platforms = state?.plan?.platforms;
      if (
        state?.schemaVersion !== 1 ||
        state.plan?.id !== id ||
        !/^[a-f0-9]{40}$/.test(state.plan.source ?? '') ||
        !Array.isArray(platforms) ||
        !platforms.length ||
        new Set(platforms).size !== platforms.length ||
        platforms.some((platform) => !['ios', 'android', 'harmony'].includes(platform))
      )
        throw observationError('INVALID_RECORD', 'Release observation identity is invalid');
      if (state.plan.configDigest !== digest(config))
        throw observationError(
          'CONFIGURATION_MISMATCH',
          'Release observation configuration differs from the saved plan',
        );
      const report = {
        releaseId: id,
        source: state.plan.source,
        stateDigest: digest(state),
        observedAt: now(),
        localOutcomes: {},
        observations: {},
      };
      const readOnly = () => {
        throw new Error('Release observation cannot change publication state');
      };
      for (const platform of platforms) {
        signal?.throwIfAborted();
        const local = state.outcomes?.[platform]?.state;
        if (typeof local === 'string' && /^[a-z][a-z_-]{0,79}$/.test(local))
          report.localOutcomes[platform] = { state: local };
        const artifact = state.artifacts?.[platform];
        if (!artifact) {
          report.observations[platform] = { state: 'not-started' };
          continue;
        }
        if (typeof adapters[platform]?.status !== 'function') {
          report.observations[platform] = { state: 'unsupported' };
          continue;
        }
        try {
          if (
            artifact.platform !== platform ||
            !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') ||
            typeof artifact.appId !== 'string' ||
            !/^[A-Za-z0-9_.-]{1,255}$/.test(artifact.appId) ||
            artifact.appId !== state.plan.appIds?.[platform] ||
            typeof artifact.version !== 'string' ||
            !/^\d+(?:\.\d+){0,2}$/.test(artifact.version) ||
            artifact.version !== state.plan.version ||
            !/^\d+(?:\.\d+){0,2}$/.test(String(artifact.buildNumber ?? '')) ||
            (state.buildAttempts?.[platform] !== undefined &&
              (!Number.isSafeInteger(state.buildAttempts[platform]) ||
                state.buildAttempts[platform] < 1))
          )
            throw new Error('Invalid recorded artifact identity');
          const ctx = Object.freeze({
            root: checkoutDirectory(state, directory, platform),
            repoRoot: repo,
            releaseDir: outputDirectory(state, directory, platform),
            platform,
            plan: immutable(structuredClone(state.plan)),
            artifact: immutable(structuredClone(artifact)),
            previous: immutable(structuredClone(state.checkpoints?.[platform] ?? {})),
            config: immutable(structuredClone(config)),
            env: immutable({ ...env }),
            command,
            signal,
            publicationRequested: false,
            assertPublicationSource: readOnly,
            checkpoint: readOnly,
          });
          const observation = await cleanup.run(() => adapters[platform].status(ctx));
          signal?.throwIfAborted();
          report.observations[platform] = {
            ...observationSummary(observation),
            artifact: {
              sha256: artifact.sha256,
              appId: artifact.appId,
              version: artifact.version,
              buildNumber: String(artifact.buildNumber),
            },
          };
        } catch (error) {
          await cleanup.capture(error);
          await cleanup.assertSafe();
          signal?.throwIfAborted();
          report.observations[platform] = {
            state: 'unavailable',
            message: 'Read-only provider observation could not be confirmed.',
          };
        }
      }
      signal?.throwIfAborted();
      return report;
    } finally {
      await unlock();
    }
  }
  return { execute, validate, status, observe, prepareContent };
}
