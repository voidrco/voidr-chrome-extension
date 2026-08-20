const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LOOP_FRAGMENT_VERSION,
  attachSessionWithCapability,
  buildLoopCodeHandoffPath,
  createGenerationCapabilityStore,
  createStagingStore,
  parseAndStripLoopDeepLink,
  prepareAutomaticLoopViewport,
} = require('../shared/loop-bootstrap-helpers.js');
const {
  authorizeDiscardRequest,
  authorizeStopRequest,
  canRecoverStopSender,
  cleanupFailedCollectorBootstrap,
  createKeyedSingleFlightLatch,
  createSerializedExecutor,
  createSingleFlightLatch,
  createStopCapabilityStore,
  isCollectorReadinessConfirmed,
  lifecycleToken,
  markRecordingReady,
  matchesLifecycleGeneration,
  matchesLifecycleToken,
  planTrackedTabRemoval,
  reconcileRemovedTabsForRetry,
  resumeCollectorWithLifecycleChecks,
  shouldResumeOnNavigation,
} = require('../background/recording-lifecycle-helpers.js');

function secureRecordingUrl(targetUrl, token = 'fragment-secret') {
  const url = new URL(targetUrl);
  const originalHash = url.hash ? url.hash.slice(1) : '';
  url.searchParams.set('voidr_record', '1');
  url.searchParams.set('voidr_mode', 'loop-test');
  url.searchParams.set('voidr_bootstrap', 'v1');
  url.searchParams.set('voidr_scenario_id', 'scn-1');
  url.searchParams.set('voidr_session_n', '1');
  const envelope = Buffer.from(JSON.stringify({ token, originalHash })).toString('base64url');
  url.hash = `${LOOP_FRAGMENT_VERSION}=${envelope}`;
  return url.toString();
}

function compactRecordingUrl(targetUrl) {
  const url = new URL(targetUrl);
  const originalHash = url.hash ? url.hash.slice(1) : '';
  const token = `t1.${'n'.repeat(24)}.${'s'.repeat(43)}`;
  url.searchParams.set('voidr_record', '1');
  url.searchParams.set('voidr_mode', 'loop-test');
  url.searchParams.set('voidr_bootstrap', 'v2');
  url.searchParams.set('voidr_scenario_id', 'scn-v2');
  url.searchParams.set('voidr_cycle_id', '11111111-1111-4111-8111-111111111111');
  url.searchParams.set('voidr_session_n', '1');
  const restored = originalHash
    ? `~${Buffer.from(originalHash, 'utf8').toString('base64url')}`
    : '';
  url.hash = `voidr-loop-v2=${token}${restored}`;
  return { url: url.toString(), token };
}

for (const targetUrl of [
  'http://localhost:8080/',
  'https://shop.example/checkout?campaign=spring#/cart?step=payment',
]) {
  test(`compact v2 launch stages and restores ${targetUrl}`, () => {
    const compact = compactRecordingUrl(targetUrl);
    const parsed = parseAndStripLoopDeepLink(compact.url);

    assert.deepEqual(parsed.staged, {
      scenarioId: 'scn-v2',
      token: compact.token,
      cycleId: '11111111-1111-4111-8111-111111111111',
      transportVersion: 'v2',
    });
    assert.equal(parsed.safeUrl, new URL(targetUrl).toString());
    assert.equal(parsed.failureCode, null);
    assert.ok(compact.url.length < 400);
  });
}

test('truncated v2 launch is stripped and reports a recoverable bootstrap failure', () => {
  const compact = compactRecordingUrl('http://localhost:8080/');
  const parsed = parseAndStripLoopDeepLink(compact.url.slice(0, -18));

  assert.equal(parsed.staged, null);
  assert.equal(parsed.failureCode, 'malformed_bootstrap');
  assert.equal(parsed.safeUrl, 'http://localhost:8080/');
});

test('bootstrap version mismatch fails closed without retaining a capability fragment', () => {
  const compact = compactRecordingUrl('http://localhost:8080/');
  const mismatched = compact.url.replace('voidr_bootstrap=v2', 'voidr_bootstrap=v1');
  const parsed = parseAndStripLoopDeepLink(mismatched);

  assert.equal(parsed.staged, null);
  assert.equal(parsed.failureCode, 'malformed_bootstrap');
  assert.equal(parsed.safeUrl, 'http://localhost:8080/');
});

test('code handoff path contains only non-secret coordinates', () => {
  const path = buildLoopCodeHandoffPath({
    scenarioId: 'lts checkout',
    cycleId: '11111111-1111-4111-8111-111111111111',
    agent: 'claude_code',
  });
  assert.equal(
    path,
    '/loops/lts%20checkout/consolidated?handoff=1&cycle=11111111-1111-4111-8111-111111111111&agent=claude_code',
  );
  assert.doesNotMatch(path, /token|secret|authorization/i);
});

test('code handoff rejects missing coordinates and unknown agents fail closed to Codex', () => {
  assert.throws(() => buildLoopCodeHandoffPath({ scenarioId: '', cycleId: 'cycle' }));
  assert.match(
    buildLoopCodeHandoffPath({ scenarioId: 'lts_1', cycleId: 'cycle_1', agent: 'unknown' }),
    /agent=codex$/,
  );
});

for (const [name, targetUrl] of [
  ['ordinary URL', 'https://shop.example/checkout'],
  ['existing query', 'https://shop.example/checkout?campaign=spring&marker=a%2Fb'],
  ['hash router', 'https://shop.example/checkout?campaign=spring#/cart?step=payment'],
]) {
  test(`secure fragment stages capability and restores ${name} losslessly`, () => {
    const recordingUrl = secureRecordingUrl(targetUrl);
    const parsed = parseAndStripLoopDeepLink(recordingUrl);

    assert.deepEqual(parsed.staged, { scenarioId: 'scn-1', token: 'fragment-secret' });
    assert.equal(parsed.safeUrl, new URL(targetUrl).toString());
    assert.doesNotMatch(parsed.safeUrl, /fragment-secret|voidr_/);
    assert.doesNotMatch(recordingUrl.split('#', 1)[0], /fragment-secret|voidr_token/);
  });
}

test('malformed secure fragment is stripped without staging or reaching page history', () => {
  const parsed = parseAndStripLoopDeepLink(
    'https://shop.example/checkout?keep=1&voidr_record=1&voidr_mode=loop-test&voidr_bootstrap=v1&voidr_scenario_id=scn-1#voidr-loop-v1=not_json',
  );

  assert.equal(parsed.staged, null);
  assert.equal(parsed.safeUrl, 'https://shop.example/checkout?keep=1');
  assert.doesNotMatch(parsed.safeUrl, /voidr-loop|not_json|voidr_/);
});

test('stages a localhost bootstrap copied with one encoded Markdown backtick', () => {
  const recordingUrl = `${secureRecordingUrl(
    'http://localhost:8080/',
    'localhost-fragment-secret',
  )}%60`;
  const parsed = parseAndStripLoopDeepLink(recordingUrl);

  assert.deepEqual(parsed.staged, {
    scenarioId: 'scn-1',
    token: 'localhost-fragment-secret',
  });
  assert.equal(parsed.safeUrl, 'http://localhost:8080/');
  assert.doesNotMatch(parsed.safeUrl, /localhost-fragment-secret|voidr_|voidr-loop|%60/);
});

test('does not normalize arbitrary secure-envelope suffixes', () => {
  const recordingUrl = `${secureRecordingUrl('http://localhost:8080/', 'must-not-stage')}%21`;
  const parsed = parseAndStripLoopDeepLink(recordingUrl);

  assert.equal(parsed.staged, null);
  assert.equal(parsed.safeUrl, 'http://localhost:8080/');
});

test('backward-compatible query capability is staged and stripped', () => {
  const parsed = parseAndStripLoopDeepLink(
    'https://shop.example/checkout?campaign=spring&voidr_record=1&voidr_mode=loop-test&voidr_scenario_id=scn-1&voidr_token=secret&voidr_session_n=2#payment',
  );

  assert.deepEqual(parsed.staged, { scenarioId: 'scn-1', token: 'secret' });
  assert.equal(parsed.safeUrl, 'https://shop.example/checkout?campaign=spring#payment');
  assert.doesNotMatch(parsed.safeUrl, /secret|voidr_/);
});

test('strips a malformed or expired-style Loop bootstrap before validation can fail', () => {
  const parsed = parseAndStripLoopDeepLink(
    'https://shop.example/checkout?keep=1&voidr_record=1&voidr_mode=loop-test&voidr_token=expired',
  );

  assert.equal(parsed.staged, null);
  assert.equal(parsed.safeUrl, 'https://shop.example/checkout?keep=1');
  assert.doesNotMatch(parsed.safeUrl, /expired|voidr_/);
});

test('does not alter unrelated target query parameters named by the application', () => {
  assert.equal(
    parseAndStripLoopDeepLink('https://shop.example/?token=target-token&mode=checkout'),
    null,
  );
});

test('fresh Loop bootstraps disable restoration and reset the viewport before capture', () => {
  const calls = [];
  const target = {
    history: { scrollRestoration: 'auto' },
    scrollTo: (...args) => calls.push(args),
  };

  assert.equal(prepareAutomaticLoopViewport(target), true);
  assert.equal(target.history.scrollRestoration, 'manual');
  assert.deepEqual(calls, [[0, 0]]);
  assert.equal(prepareAutomaticLoopViewport({}), false);
});

test('staging is tab-scoped, one-shot, and expires without exposing other tabs', async () => {
  const values = {};
  let now = 1000;
  const storage = {
    async set(update) {
      Object.assign(values, update);
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const staging = createStagingStore(storage, { now: () => now, ttlMs: 100 });

  await staging.stage(7, { scenarioId: 'scn-7', token: 'cap-7' });
  assert.equal(await staging.consume(8), null);
  assert.deepEqual(await staging.consume(7), { scenarioId: 'scn-7', token: 'cap-7' });
  assert.equal(await staging.consume(7), null);

  await staging.stage(7, { scenarioId: 'expired', token: 'expired-cap' });
  now += 101;
  assert.equal(await staging.consume(7), null);
  assert.deepEqual(values, {});
});

test('validated capability is generation-scoped and consumed only when its lease commits', async () => {
  const values = {};
  let now = 1000;
  const storage = {
    async set(update) {
      Object.assign(values, update);
    },
    async get(keys) {
      if (keys === null) return { ...values };
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const secrets = createGenerationCapabilityStore(storage, { now: () => now, ttlMs: 100 });

  await secrets.stage('generation-a', 7, 'scn-7', 'capability-secret');
  assert.equal(await secrets.has('generation-a', 8, 'scn-7'), false);
  assert.equal(await secrets.has('generation-a', 7, 'scn-7'), true);
  const first = await secrets.lease('generation-a', 'scn-7');
  assert.equal(first.token, 'capability-secret');
  assert.equal(await secrets.lease('generation-a', 'scn-7'), null);
  assert.equal(await secrets.commit(first), true);
  assert.equal(await secrets.lease('generation-a', 'scn-7'), null);
  assert.deepEqual(values, {});

  await secrets.stage('generation-b', 9, 'scn-9', 'cleanup-secret');
  await secrets.discardGeneration('generation-b');
  assert.deepEqual(values, {});

  await secrets.stage('generation-c', 11, 'scn-11', 'tab-secret');
  await secrets.discardTab(11);
  assert.deepEqual(values, {});

  await secrets.stage('generation-expired', 12, 'scn-12', 'expired-secret');
  const expiredLease = await secrets.lease('generation-expired', 'scn-12');
  now += 101;
  await secrets.purgeExpired();
  assert.equal(await secrets.release(expiredLease), false);
  assert.deepEqual(values, {});
});

test('generation capability remains available after a recording exceeds 15 minutes', async () => {
  const values = {};
  let now = 1000;
  const storage = {
    async set(update) {
      Object.assign(values, update);
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const secrets = createGenerationCapabilityStore(storage, { now: () => now });
  await secrets.stage('generation-long', 7, 'scn-long', 'attach-capability');

  now += 16 * 60 * 1000;

  const capabilityLease = await secrets.lease('generation-long', 'scn-long');
  assert.equal(capabilityLease.token, 'attach-capability');
  await secrets.release(capabilityLease);
});

test('tab teardown serializes behind an in-flight capability write', async () => {
  const values = {};
  let releaseWrite;
  const writeStarted = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let allowWrite;
  const writeAllowed = new Promise((resolve) => {
    allowWrite = resolve;
  });
  const storage = {
    async set(update) {
      releaseWrite();
      await writeAllowed;
      Object.assign(values, update);
    },
    async get() {
      return { ...values };
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const secrets = createGenerationCapabilityStore(storage);
  const staging = secrets.stage('generation-race', 17, 'scn-race', 'race-secret');
  await writeStarted;
  const teardown = secrets.discardTab(17);
  allowWrite();
  await Promise.all([staging, teardown]);
  assert.deepEqual(values, {});
});

test('failed capability attach releases its lease so a retry can succeed and consume it', async () => {
  const calls = [];
  const values = {};
  const storage = {
    async set(update) {
      Object.assign(values, update);
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const capabilityStore = createGenerationCapabilityStore(storage);
  await capabilityStore.stage('generation-a', 7, 'scn-a', 'attach-capability');
  let status = 503;
  const attach = () =>
    attachSessionWithCapability({
      capabilityStore,
      lifecycleGeneration: 'generation-a',
      scenarioId: 'scn-a',
      sessionId: 'session-a',
      endpoint: 'https://api.example/loop-test/scenarios/scn-a/sessions',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: status === 200,
          status,
          json: async () => ({ sessionsRecorded: 1, maxSessions: 1 }),
        };
      },
    });

  await assert.rejects(attach, (error) => {
    assert.doesNotMatch(error.message, /attach-capability/);
    return /HTTP 503/.test(error.message);
  });
  assert.equal(await capabilityStore.has('generation-a', 7, 'scn-a'), true);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: 'session-a',
    token: 'attach-capability',
    lifecycleGeneration: 'generation-a',
  });

  status = 200;
  assert.deepEqual(await attach(), { sessionsRecorded: 1, maxSessions: 1 });
  assert.deepEqual(values, {});
  await assert.rejects(attach, /authorization is unavailable or expired/);
  assert.equal(calls.length, 2);
});

test('concurrent capability attach cannot duplicate an in-flight lease', async () => {
  const values = {};
  const storage = {
    async set(update) {
      Object.assign(values, update);
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const capabilityStore = createGenerationCapabilityStore(storage);
  await capabilityStore.stage('generation-a', 7, 'scn-a', 'attach-capability');
  let finishFetch;
  const fetchFinished = new Promise((resolve) => {
    finishFetch = resolve;
  });
  let fetchCalls = 0;
  const attach = () =>
    attachSessionWithCapability({
      capabilityStore,
      lifecycleGeneration: 'generation-a',
      scenarioId: 'scn-a',
      sessionId: 'session-a',
      endpoint: 'https://api.example/attach',
      fetchImpl: async () => {
        fetchCalls += 1;
        await fetchFinished;
        return { ok: true, status: 200, json: async () => ({ attached: true }) };
      },
    });

  const owner = attach();
  await assert.rejects(attach(), /authorization is unavailable or expired/);
  assert.equal(fetchCalls, 1);
  finishFetch();
  assert.deepEqual(await owner, { attached: true });
  assert.deepEqual(values, {});
});

test('explicit discard invalidates an active capability lease', async () => {
  const values = {};
  const storage = {
    async set(update) {
      Object.assign(values, update);
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const capabilityStore = createGenerationCapabilityStore(storage);
  await capabilityStore.stage('generation-a', 7, 'scn-a', 'attach-capability');
  const capabilityLease = await capabilityStore.lease('generation-a', 'scn-a');

  await capabilityStore.discardGeneration('generation-a');

  assert.equal(await capabilityStore.release(capabilityLease), false);
  assert.equal(await capabilityStore.lease('generation-a', 'scn-a'), null);
  assert.deepEqual(values, {});
});

test('collector readiness rejects a forced ID without authenticated initialization', () => {
  assert.equal(
    isCollectorReadinessConfirmed({ ready: false, sessionId: 'forced-session-id' }),
    false,
  );
  assert.equal(
    isCollectorReadinessConfirmed({ ready: true, sessionId: 'forced-session-id' }),
    true,
  );
});

test('confirmed readiness performs the starting to recording transition', () => {
  const starting = {
    lifecycle: 'starting',
    canonicalSessionId: 'forced-id',
    initOptions: { forcedSessionId: 'forced-id' },
    sessionIds: ['forced-id'],
  };
  const recording = markRecordingReady(starting, 'server-confirmed-id');

  assert.equal(starting.lifecycle, 'starting');
  assert.equal(recording.lifecycle, 'recording');
  assert.equal(recording.canonicalSessionId, 'server-confirmed-id');
  assert.equal(recording.initOptions.forcedSessionId, 'server-confirmed-id');
  assert.deepEqual(recording.sessionIds, ['forced-id', 'server-confirmed-id']);
});

test('collector bootstrap cleanup removes CSP from every tracked child before active state', async () => {
  const calls = [];
  const trackedTabIds = [42];
  // A child joins while the parent recording is still in `starting`.
  trackedTabIds.push(73, 91);
  await cleanupFailedCollectorBootstrap({
    tabId: 42,
    trackedTabIds: [...trackedTabIds],
    disableCsp: async (tabId) => calls.push(`csp:${tabId}`),
    clearActive: async () => calls.push('active'),
  });
  assert.deepEqual(calls, ['csp:42', 'csp:73', 'csp:91', 'active']);
});

test('navigation resumes starting and recording states but never stopping', () => {
  assert.equal(shouldResumeOnNavigation({ lifecycle: 'starting' }), true);
  assert.equal(shouldResumeOnNavigation({ lifecycle: 'recording' }), true);
  assert.equal(shouldResumeOnNavigation({ lifecycle: 'stopping' }), false);
});

test('resume rechecks the lifecycle after fetch and immediately before initialization', async () => {
  const original = {
    lifecycle: 'recording',
    lifecycleGeneration: 'generation-a',
    lifecycleVersion: 4,
  };
  const token = lifecycleToken(original);
  let current = original;
  const calls = [];

  const stoppedDuringFetch = await resumeCollectorWithLifecycleChecks({
    token,
    isCurrent: (candidate) => matchesLifecycleToken(current, candidate),
    fetchCollector: async () => {
      calls.push('fetch');
      current = { ...original, lifecycle: 'stopping', lifecycleVersion: 5 };
      return 'collector';
    },
    injectCollector: async () => calls.push('inject'),
    initializeCollector: async () => calls.push('initialize'),
  });
  assert.deepEqual(stoppedDuringFetch, { resumed: false, stage: 'before-injection' });
  assert.deepEqual(calls, ['fetch']);

  current = original;
  calls.length = 0;
  const stoppedAfterInjection = await resumeCollectorWithLifecycleChecks({
    token,
    isCurrent: (candidate) => matchesLifecycleToken(current, candidate),
    fetchCollector: async () => {
      calls.push('fetch');
      return 'collector';
    },
    injectCollector: async () => {
      calls.push('inject');
      current = { ...original, lifecycle: 'stopping', lifecycleVersion: 5 };
    },
    initializeCollector: async () => calls.push('initialize'),
  });
  assert.deepEqual(stoppedAfterInjection, {
    resumed: false,
    stage: 'before-initialization',
  });
  assert.deepEqual(calls, ['fetch', 'inject']);
});

test('concurrent stop callers share one result and stale stop tokens cannot restore replacement state', async () => {
  let executions = 0;
  const latch = createSingleFlightLatch();
  const first = latch.begin();
  const second = latch.begin();
  if (first.isOwner) {
    executions += 1;
  }

  assert.equal(first.isOwner, true);
  assert.equal(second.isOwner, false);
  assert.strictEqual(first.promise, second.promise);
  first.resolve({ success: true, finalized: true });
  assert.deepEqual(await Promise.all([first.promise, second.promise]), [
    { success: true, finalized: true },
    { success: true, finalized: true },
  ]);
  assert.equal(executions, 1);
  const later = latch.begin();
  assert.equal(later.isOwner, true);
  later.resolve({ success: false });

  const staleStopToken = { generation: 'old-generation', version: 3 };
  const replacement = {
    lifecycle: 'recording',
    lifecycleGeneration: 'new-generation',
    lifecycleVersion: 0,
  };
  assert.equal(matchesLifecycleToken(replacement, staleStopToken), false);
});

test('cold hydration is serialized before a newer recording write', async () => {
  const runSerialized = createSerializedExecutor();
  let releaseStorageRead;
  const storageRead = new Promise((resolve) => {
    releaseStorageRead = resolve;
  });
  let active = null;

  const hydration = runSerialized(async () => {
    active = await storageRead;
  });
  const newerWrite = runSerialized(async () => {
    active = { lifecycleGeneration: 'new-generation', lifecycle: 'starting' };
  });

  releaseStorageRead({ lifecycleGeneration: 'stored-generation', lifecycle: 'recording' });
  await Promise.all([hydration, newerWrite]);
  assert.equal(active.lifecycleGeneration, 'new-generation');
});

test('benign same-generation tab updates do not cancel collector startup', async () => {
  const original = {
    lifecycle: 'starting',
    lifecycleGeneration: 'generation-a',
    lifecycleVersion: 4,
  };
  const token = lifecycleToken(original);
  let current = original;
  const calls = [];

  const resumed = await resumeCollectorWithLifecycleChecks({
    token,
    isCurrent: (candidate) =>
      matchesLifecycleGeneration(current, candidate, ['starting', 'recording']),
    fetchCollector: async () => {
      calls.push('fetch');
      current = {
        ...current,
        currentTabId: 73,
        trackedTabIds: [42, 73],
        lifecycleVersion: 5,
      };
      return 'collector';
    },
    injectCollector: async () => calls.push('inject'),
    initializeCollector: async () => {
      calls.push('initialize');
      return 'session-a';
    },
  });

  assert.equal(matchesLifecycleToken(current, token), false);
  assert.equal(matchesLifecycleGeneration(current, token, ['starting']), true);
  assert.deepEqual(resumed, { resumed: true, sessionId: 'session-a' });
  assert.deepEqual(calls, ['fetch', 'inject', 'initialize']);
});

test('tab removal leaves a generation and session tombstone before stop', () => {
  const recording = {
    lifecycle: 'recording',
    lifecycleGeneration: 'generation-a',
    lifecycleVersion: 8,
    canonicalSessionId: 'session-a',
    tabId: 42,
    currentTabId: 42,
    trackedTabIds: [42, 73],
  };
  const staleStopToken = { generation: 'generation-a', version: 7 };
  const removal = planTrackedTabRemoval(recording, 42);

  assert.equal(removal.action, 'mark-removed');
  assert.deepEqual(removal.recording.trackedTabIds, [73]);
  assert.deepEqual(removal.recording.removedTabIds, [42]);
  assert.deepEqual(
    { ...removal.recording.unacknowledgedRemovals[0], removedAt: 0 },
    {
      tabId: 42,
      generation: 'generation-a',
      sessionId: 'session-a',
      removedAt: 0,
      acknowledged: false,
    },
  );
  assert.equal(matchesLifecycleToken(recording, staleStopToken, ['recording']), false);
  assert.equal(matchesLifecycleGeneration(recording, staleStopToken, ['recording']), true);
});

test('unacknowledged removed tabs make the stop terminal without a dead-tab retry loop', () => {
  const recording = {
    lifecycle: 'stopping',
    lifecycleGeneration: 'generation-a',
    tabId: 42,
    currentTabId: 42,
    trackedTabIds: [42, 73],
  };
  const first = reconcileRemovedTabsForRetry(recording, [
    {
      tabId: 42,
      sessionId: 'canonical',
      ok: false,
      flushed: false,
      removed: true,
      error: 'closed before flush',
    },
    { tabId: 73, sessionId: 'canonical', ok: true, flushed: true, finalChunkSeq: 9 },
  ]);

  assert.equal(first.policy, 'terminal');
  assert.deepEqual(first.removedTabIds, [42]);
  assert.equal(first.recording, null);

  const terminal = reconcileRemovedTabsForRetry({ ...recording, trackedTabIds: [42] }, [
    { tabId: 42, ok: false, flushed: false, removed: true },
  ]);
  assert.deepEqual(terminal, {
    policy: 'terminal',
    removedTabIds: [42],
    recording: null,
  });
});

test('stop authorization requires current generation and tracked content sender', () => {
  const recording = {
    lifecycleGeneration: 'generation-current',
    trackedTabIds: [42],
  };
  assert.deepEqual(authorizeStopRequest(recording, 'generation-current', 42), {
    authorized: true,
    reason: null,
  });
  assert.equal(authorizeStopRequest(recording, 'generation-stale', 42).authorized, false);
  assert.deepEqual(authorizeStopRequest(recording, 'generation-current', 73), {
    authorized: false,
    reason: 'untracked-tab',
  });
  assert.equal(authorizeStopRequest(recording, 'generation-current', null).authorized, true);
});

test('stop recovers an untracked sender only with the canonical live collector session', () => {
  const recording = {
    lifecycleGeneration: 'generation-current',
    canonicalSessionId: 'session-canonical',
    trackedTabIds: [42],
  };
  assert.equal(canRecoverStopSender(recording, 73, 'session-canonical'), true);
  assert.equal(canRecoverStopSender(recording, 73, 'session-other'), false);
  assert.equal(canRecoverStopSender(recording, 42, 'session-canonical'), false);
  assert.equal(canRecoverStopSender(recording, 73, null), false);
});

test('stop capability survives a worker restart and stays generation, tab and session bound', async () => {
  const values = {};
  const storage = {
    async get(keys) {
      if (keys === null) return { ...values };
      return Object.fromEntries(
        keys.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const options = { now: () => 1_000, randomToken: () => 'opaque-stop-capability' };
  const firstWorker = createStopCapabilityStore(storage, options);
  const token = await firstWorker.issue('generation-current', 73, 'session-canonical');
  const restartedWorker = createStopCapabilityStore(storage, options);

  assert.equal(
    await restartedWorker.verify('generation-current', 73, 'session-canonical', token),
    true,
  );
  assert.equal(
    await restartedWorker.verify('generation-other', 73, 'session-canonical', token),
    false,
  );
  assert.equal(
    await restartedWorker.verify('generation-current', 74, 'session-canonical', token),
    false,
  );
  assert.equal(
    await restartedWorker.verify('generation-current', 73, 'session-other', token),
    false,
  );
  assert.equal(
    await restartedWorker.verify('generation-current', 73, 'session-canonical', 'wrong'),
    false,
  );
  assert.equal(
    await restartedWorker.verify('generation-current', 73, 'session-canonical', token),
    true,
    'a forged request must not revoke the legitimate stop capability',
  );

  await restartedWorker.discardGeneration('generation-current');
  assert.equal(
    await restartedWorker.verify('generation-current', 73, 'session-canonical', token),
    false,
  );
});

test('discard is busy during stop and cannot enter the side-effect path', () => {
  const recording = {
    lifecycle: 'stopping',
    lifecycleGeneration: 'generation-current',
    trackedTabIds: [42],
  };
  let sideEffects = 0;
  const authorization = authorizeDiscardRequest(recording, 'generation-current', 42);
  if (authorization.authorized) sideEffects += 1;

  assert.deepEqual(authorization, { authorized: false, reason: 'stop-in-progress' });
  assert.equal(sideEffects, 0);
});

test('overlapping starts claim one generation before side effects', async () => {
  const runSerialized = createSerializedExecutor();
  let active = null;
  const cspEnabledFor = [];

  const start = (generation) =>
    runSerialized(async () => {
      if (active) return false;
      active = { lifecycle: 'starting', lifecycleGeneration: generation };
      cspEnabledFor.push(generation);
      return true;
    });

  assert.deepEqual(await Promise.all([start('generation-a'), start('generation-b')]), [
    true,
    false,
  ]);
  assert.equal(active.lifecycleGeneration, 'generation-a');
  assert.deepEqual(cspEnabledFor, ['generation-a']);
});

test('stop single-flight ownership is scoped to lifecycle generation', async () => {
  const latch = createKeyedSingleFlightLatch();
  const oldOwner = latch.begin('generation-a');
  const oldFollower = latch.begin('generation-a');
  const newOwner = latch.begin('generation-b');

  assert.equal(oldOwner.isOwner, true);
  assert.equal(oldFollower.isOwner, false);
  assert.strictEqual(oldFollower.promise, oldOwner.promise);
  assert.equal(newOwner.isOwner, true);
  assert.notStrictEqual(newOwner.promise, oldOwner.promise);

  oldOwner.resolve({ generation: 'generation-a' });
  newOwner.resolve({ generation: 'generation-b' });
  assert.deepEqual(await oldFollower.promise, { generation: 'generation-a' });
  assert.deepEqual(await newOwner.promise, { generation: 'generation-b' });
});
