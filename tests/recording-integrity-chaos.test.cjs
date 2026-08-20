const assert = require('node:assert/strict');
const { test } = require('node:test');

const { finalizeTrackedTabs } = require('../background/session-stop-helpers.js');
const {
  authorizeStopRequest,
  canRecoverStopSender,
} = require('../background/recording-lifecycle-helpers.js');

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

test('500 deterministic Stop chaos cases never cross session watermarks or confirm failed flushes', async () => {
  const random = deterministicRandom(0x5ea1c0de);

  for (let scenario = 0; scenario < 500; scenario += 1) {
    const tabCount = 1 + Math.floor(random() * 8);
    const sessionCount = 1 + Math.floor(random() * 3);
    const tabIds = [];
    const resultByTab = new Map();
    const expectedBySession = new Map();
    let hasMissingSession = false;

    for (let index = 0; index < tabCount; index += 1) {
      const tabId = scenario * 100 + index + 1;
      const sessionId = `session-${scenario}-${Math.floor(random() * sessionCount)}`;
      const missingSession = random() < 0.04;
      const healthy = random() >= 0.18;
      const finalChunkSeq = Math.floor(random() * 2_000);
      const result = missingSession
        ? { ok: healthy, flushed: healthy, finalChunkSeq }
        : {
            sessionId,
            ok: healthy,
            flushed: healthy,
            finalChunkSeq,
            ...(healthy ? {} : { error: 'deterministic flush failure' }),
          };

      tabIds.push(tabId);
      if (random() < 0.35) tabIds.push(tabId);
      resultByTab.set(tabId, result);
      if (missingSession) {
        hasMissingSession = true;
        continue;
      }
      const expected = expectedBySession.get(sessionId) ?? {
        failed: false,
        maxFinalChunkSeq: -1,
      };
      expected.failed ||= !healthy;
      expected.maxFinalChunkSeq = Math.max(expected.maxFinalChunkSeq, finalChunkSeq);
      expectedBySession.set(sessionId, expected);
    }

    const stoppedTabs = [];
    const sealCalls = [];
    const outcome = await finalizeTrackedTabs({
      tabIds,
      stopTab: async (tabId) => {
        stoppedTabs.push(tabId);
        await Promise.resolve();
        return resultByTab.get(tabId);
      },
      sealSession: async ({ sessionId, finalizedThrough }) => {
        sealCalls.push({ sessionId, finalizedThrough });
        return {
          sessionId,
          sealed: true,
          finalized: true,
          sealedThrough: finalizedThrough,
        };
      },
    });

    assert.equal(new Set(stoppedTabs).size, resultByTab.size, `scenario ${scenario}`);
    assert.equal(stoppedTabs.length, resultByTab.size, `scenario ${scenario}`);
    assert.equal(
      new Set(sealCalls.map((call) => call.sessionId)).size,
      sealCalls.length,
      `scenario ${scenario}`,
    );

    for (const [sessionId, expected] of expectedBySession) {
      const seal = sealCalls.find((call) => call.sessionId === sessionId);
      if (expected.failed) {
        assert.equal(seal, undefined, `scenario ${scenario}: failed session was sealed`);
        assert.equal(
          outcome.successfulSessionIds.includes(sessionId),
          false,
          `scenario ${scenario}: failed session was confirmed`,
        );
      } else {
        assert.deepEqual(
          seal,
          { sessionId, finalizedThrough: expected.maxFinalChunkSeq },
          `scenario ${scenario}: watermark crossed a session boundary`,
        );
        assert.equal(
          outcome.successfulSessionIds.includes(sessionId),
          true,
          `scenario ${scenario}: healthy session was not confirmed`,
        );
      }
    }

    const expectedPartial =
      hasMissingSession || [...expectedBySession.values()].some((session) => session.failed);
    assert.equal(outcome.partialFailure, expectedPartial, `scenario ${scenario}`);
  }
});

test('500 authorization chaos cases recover only the exact canonical live session', () => {
  const random = deterministicRandom(0xa11ce55);

  for (let scenario = 0; scenario < 500; scenario += 1) {
    const trackedTabId = scenario * 10 + 1;
    const senderTabId = scenario * 10 + 2;
    const generation = `generation-${scenario}-${Math.floor(random() * 10_000)}`;
    const canonicalSessionId = `canonical-${scenario}-${Math.floor(random() * 10_000)}`;
    const recording = {
      lifecycle: 'recording',
      lifecycleGeneration: generation,
      canonicalSessionId,
      trackedTabIds: [trackedTabId],
    };

    assert.equal(authorizeStopRequest(recording, generation, trackedTabId).authorized, true);
    assert.equal(
      authorizeStopRequest(recording, `${generation}-stale`, trackedTabId).authorized,
      false,
    );
    assert.deepEqual(authorizeStopRequest(recording, generation, senderTabId), {
      authorized: false,
      reason: 'untracked-tab',
    });
    assert.equal(canRecoverStopSender(recording, senderTabId, canonicalSessionId), true);
    assert.equal(canRecoverStopSender(recording, senderTabId, `${canonicalSessionId}-wrong`), false);
    assert.equal(canRecoverStopSender(recording, trackedTabId, canonicalSessionId), false);
    assert.equal(canRecoverStopSender(recording, senderTabId, null), false);
  }
});
