import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { createCollector } = await import('../src/collector.js');
const { state, resetState } = await import('../src/state.js');

afterEach(() => {
  resetState();
  delete globalThis.fetch;
});

describe('collector explicit stop contract', () => {
  it('exposes stopAndFlush for the extension acknowledgement barrier', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/collector.js', import.meta.url)),
      'utf8',
    );

    assert.match(source, /stopAndFlush\(\)\s*\{\s*return api\.endSession\(\)/);
    assert.match(source, /stopAndFinalize\(\)\s*\{\s*return api\.endSession\(\)/);
    assert.match(source, /endSession\(\)\s*\{/);
  });

  it('persists one stop barrier and preserves the session when sealing fails', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/collector.js', import.meta.url)),
      'utf8',
    );

    assert.match(source, /plugin: 'voidr\.session\.stop'/);
    assert.match(source, /state\.stopBarrierLifecycleId !== lifecycleId/);
    assert.match(source, /if \(!result\.ok\) return result/);
    const stopMethod = source.slice(source.indexOf('    endSession() {'));
    const failureReturn = stopMethod.indexOf('if (!result.ok) return result');
    assert.ok(
      failureReturn < stopMethod.indexOf('resetState();', failureReturn),
      'failed seals must return before collector state is reset',
    );
  });

  it('seals an empty recording through one durable marker and can retry a transient finalize', async () => {
    resetState();
    state.forceStop = false;
    state.isInitialized = true;
    state.sessionId = 'session-short';
    state.authToken = 'collector-token';
    state.config = {
      ...state.config,
      collectorUrl: 'https://collector.test',
      captureEnvironmentBundle: false,
    };

    let chunkRequests = 0;
    let finalizeRequests = 0;
    let finalizeReady = false;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sessions/chunk')) {
        chunkRequests += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'x-voidr-chunk-seq' ? '1' : null) },
        };
      }
      if (String(url).includes('/finalize')) {
        finalizeRequests += 1;
        return {
          ok: true,
          status: finalizeReady ? 200 : 202,
          json: async () =>
            finalizeReady
              ? { sealed: true, finalized: true, sealedThrough: 1 }
              : { sealed: false, finalized: false, status: 'pending' },
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const collector = createCollector();
    const pending = await collector.stopAndFinalize();
    assert.equal(pending.ok, false);
    assert.equal(pending.sealed, false);
    assert.equal(state.sessionId, 'session-short');
    assert.equal(state.lastAcknowledgedChunkSeq, 1);
    assert.equal(chunkRequests, 1);

    finalizeReady = true;
    const sealed = await collector.stopAndFinalize();
    assert.equal(sealed.ok, true);
    assert.equal(sealed.sealed, true);
    assert.equal(sealed.sealedThrough, 1);
    assert.equal(chunkRequests, 1, 'retry must not duplicate the stop marker');
    assert.equal(finalizeRequests, 4, 'three transient attempts plus the successful retry');
    assert.equal(state.sessionId, null);
  });
});
