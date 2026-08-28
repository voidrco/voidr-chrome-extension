const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  finalizeTrackedTabs,
  isConfirmedCapture,
  classifyStopOutcome,
} = require('../background/session-stop-helpers.js');

test('quiesces every unique tracked tab and seals exactly once at the maximum ACK', async () => {
  const stopped = [];
  const seals = [];
  const result = await finalizeTrackedTabs({
    tabIds: [7, 3, 7, 11],
    stopTab: async (tabId) => {
      stopped.push(tabId);
      return { sessionId: 'canonical', ok: true, flushed: true, finalChunkSeq: tabId + 10 };
    },
    sealSession: async (seal) => {
      seals.push(seal);
      return { sealed: true, finalized: true, sealedThrough: seal.finalizedThrough };
    },
  });

  assert.deepEqual(
    stopped.sort((a, b) => a - b),
    [3, 7, 11],
  );
  assert.equal(result.failures.length, 0);
  assert.equal(seals.length, 1);
  assert.equal(seals[0].finalizedThrough, 21);
  assert.equal(result.finalizations.canonical.sealedThrough, 21);
});

test('does not seal when any tracked tab fails to flush', async () => {
  let sealCalls = 0;
  const result = await finalizeTrackedTabs({
    tabIds: [1, 2],
    stopTab: async (tabId) =>
      tabId === 1
        ? { sessionId: 'canonical', ok: true, flushed: true, finalChunkSeq: 4 }
        : { sessionId: 'canonical', ok: false, flushed: false, error: 'chunk failed' },
    sealSession: async () => {
      sealCalls += 1;
    },
  });

  assert.equal(result.failures.length, 1);
  assert.equal(sealCalls, 0);
});

test('a tab closed during Stop is a failed flush and never an ACK', async () => {
  let sealCalls = 0;
  const result = await finalizeTrackedTabs({
    tabIds: [1, 2],
    stopTab: async (tabId) =>
      tabId === 1
        ? { sessionId: 'canonical', ok: true, flushed: true, finalChunkSeq: 4 }
        : {
            sessionId: 'canonical',
            ok: false,
            flushed: false,
            removed: true,
            error: 'Tracked tab closed before collector flush acknowledgement',
          },
    sealSession: async () => {
      sealCalls += 1;
    },
  });

  assert.equal(sealCalls, 0);
  assert.equal(result.partialFailure, true);
  assert.equal(result.failures[0].removed, true);
  assert.match(result.finalizationFailures[0].error, /failed to flush/);
});

test('legacy tabs accept a successful compatibility finalization', async () => {
  const result = await finalizeTrackedTabs({
    tabIds: [5, 6],
    stopTab: async (tabId) =>
      tabId === 5
        ? {
            sessionId: 'canonical',
            ok: true,
            flushed: false,
            legacy: true,
            finalChunkSeq: null,
          }
        : { sessionId: 'canonical', ok: true, flushed: true, finalChunkSeq: 18 },
    sealSession: async ({ finalizedThrough }) => {
      assert.equal(finalizedThrough, null);
      return { sealed: true, finalized: true, sealedThrough: 18 };
    },
  });

  assert.equal(result.failures.length, 0);
  assert.equal(result.finalizations.canonical.sealed, true);
  assert.equal(result.finalizations.canonical.finalized, true);
  assert.deepEqual(result.successfulSessionIds, ['canonical']);
});

test('legacy tabs retain a successful server finalization result', async () => {
  const result = await finalizeTrackedTabs({
    tabIds: [5],
    stopTab: async () => ({
      sessionId: 'canonical',
      ok: true,
      flushed: false,
      legacy: true,
    }),
    sealSession: async ({ finalizedThrough }) => {
      assert.equal(finalizedThrough, null);
      return {
        sealed: true,
        finalized: true,
        sealedThrough: 22,
        watermarkSource: 'server-authoritative',
        degraded: true,
      };
    },
  });

  assert.equal(result.finalization.sealed, true);
  assert.equal(result.finalization.finalized, true);
  assert.equal(result.finalization.degraded, true);
  assert.deepEqual(result.successfulSessionIds, ['canonical']);
});

test('groups rotated tabs by returned sessionId and never crosses ACK watermarks', async () => {
  const seals = [];
  const result = await finalizeTrackedTabs({
    tabIds: [1, 2, 3, 4],
    stopTab: async (tabId) =>
      tabId <= 2
        ? {
            sessionId: 'canonical',
            ok: true,
            flushed: true,
            finalChunkSeq: tabId === 1 ? 4 : 7,
            finalizedSessionIds: ['rotated-earlier'],
          }
        : {
            sessionId: 'rotated-current',
            ok: true,
            flushed: true,
            finalChunkSeq: tabId === 3 ? 81 : 93,
          },
    sealSession: async (seal) => {
      seals.push(seal);
      return {
        sessionId: seal.sessionId,
        sealed: true,
        finalized: true,
        sealedThrough: seal.finalizedThrough,
      };
    },
  });

  assert.deepEqual(
    seals
      .map(({ sessionId, finalizedThrough }) => ({ sessionId, finalizedThrough }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [
      { sessionId: 'canonical', finalizedThrough: 7 },
      { sessionId: 'rotated-current', finalizedThrough: 93 },
    ],
  );
  assert.deepEqual(
    new Set(result.successfulSessionIds),
    new Set(['rotated-earlier', 'canonical', 'rotated-current']),
  );
  assert.equal(result.partialFailure, false);
});

test('finalizes healthy sessions while reporting a sibling session failure', async () => {
  const result = await finalizeTrackedTabs({
    tabIds: [1, 2],
    stopTab: async (tabId) =>
      tabId === 1
        ? { sessionId: 'healthy', ok: true, flushed: true, finalChunkSeq: 5 }
        : { sessionId: 'failed', ok: false, flushed: false, error: 'flush failed' },
    sealSession: async ({ sessionId, finalizedThrough }) => ({
      sessionId,
      sealed: true,
      finalized: true,
      sealedThrough: finalizedThrough,
    }),
  });

  assert.deepEqual(result.successfulSessionIds, ['healthy']);
  assert.equal(result.finalizations.healthy.sealedThrough, 5);
  assert.equal(result.finalizations.failed, undefined);
  assert.equal(result.partialFailure, true);
  assert.equal(result.failures.length, 1);
  assert.equal(result.finalizationFailures[0].sessionId, 'failed');
});

test('tombstoned session stays unconfirmed while a healthy sibling finalizes', async () => {
  const seals = [];
  const result = await finalizeTrackedTabs({
    tabIds: [1, 2],
    stopTab: async (tabId) =>
      tabId === 1
        ? {
            sessionId: 'unconfirmed',
            ok: false,
            flushed: false,
            removed: true,
            unacknowledged: true,
            error: 'closed before flush',
          }
        : { sessionId: 'healthy', ok: true, flushed: true, finalChunkSeq: 8 },
    sealSession: async ({ sessionId, finalizedThrough }) => {
      seals.push({ sessionId, finalizedThrough });
      return { sessionId, sealed: true, finalized: true, sealedThrough: finalizedThrough };
    },
  });

  assert.deepEqual(seals, [{ sessionId: 'healthy', finalizedThrough: 8 }]);
  assert.deepEqual(result.successfulSessionIds, ['healthy']);
  assert.equal(result.finalizations.unconfirmed, undefined);
  assert.equal(result.partialFailure, true);
  assert.equal(result.failures[0].unacknowledged, true);
});

test('capture confirmation requires both success and finalized', () => {
  assert.equal(isConfirmedCapture({ success: true, finalized: true }), true);
  assert.equal(isConfirmedCapture({ success: true, finalized: false }), false);
  assert.equal(isConfirmedCapture({ success: false, finalized: true }), false);
});

test('an attach failure never turns a durable seal into a recording retry', () => {
  const outcome = classifyStopOutcome({
    quiescencePartialFailure: false,
    finalizedSessionIds: ['sealed-session'],
    attachmentError: 'CollectorSession not found',
  });

  assert.deepEqual(outcome, {
    sealFailed: false,
    success: true,
    finalized: true,
    partial: false,
    attachmentPending: true,
  });
  assert.equal(isConfirmedCapture(outcome), true);
});

test('a collector failure remains retryable as a seal failure', () => {
  const outcome = classifyStopOutcome({
    quiescencePartialFailure: true,
    finalizedSessionIds: ['healthy-sibling'],
    attachmentError: null,
  });

  assert.equal(outcome.sealFailed, true);
  assert.equal(outcome.success, false);
  assert.equal(outcome.finalized, false);
  assert.equal(outcome.attachmentPending, false);
});
