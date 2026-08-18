import assert from 'node:assert/strict';

const EXPECTED = {
  clicks: 256,
  inputs: 64,
  pageViews: 3,
  networkRequests: 20,
  scenarioRequests: 14,
  screenElements: 1500,
};

const impact = (report, scenario, metric) => report.summary.impact[scenario][metric];
const label = (sample, metric) => `iteration ${sample.iteration} ${sample.mode} ${metric}`;

function assertAtMost(value, maximum, name) {
  assert.ok(value <= maximum, `${name} was ${value}; budget is ${maximum}`);
}

function assertActiveFidelity(sample) {
  const { transport, lifecycle, cancelledInitialization } = sample;
  assert.ok(transport.chunkCalls > 0, label(sample, 'did not send chunks'));
  assert.ok(transport.chunkCalls <= 16, label(sample, `sent ${transport.chunkCalls} chunks`));
  assert.ok(transport.screenMapCalls > 0, label(sample, 'did not sync the screen map'));
  assert.equal(transport.decodeErrors, 0, label(sample, 'payload decode errors'));
  assert.equal(transport.fullSnapshotCount, 1, label(sample, 'full snapshots'));
  assert.equal(transport.semanticClickCount, EXPECTED.clicks, label(sample, 'semantic clicks'));
  assert.equal(transport.semanticInputCount, EXPECTED.inputs, label(sample, 'semantic inputs'));
  assert.equal(transport.pageViewCount, EXPECTED.pageViews, label(sample, 'page views'));
  assert.ok(
    transport.networkBatchCount >= 2 && transport.networkBatchCount <= 10,
    label(sample, `sent ${transport.networkBatchCount} network batches`),
  );
  assert.equal(
    transport.networkRequestCount,
    EXPECTED.networkRequests,
    label(sample, 'network requests'),
  );
  assert.equal(transport.networkFetchRequestCount, 10, label(sample, 'fetch requests'));
  assert.equal(transport.networkXhrRequestCount, 10, label(sample, 'XHR requests'));
  assert.equal(transport.chunkRejected413, 0, label(sample, 'oversized chunks'));
  assertAtMost(
    transport.maxChunkEventBytes,
    8 * 1024 * 1024,
    label(sample, 'largest uncompressed chunk'),
  );
  assert.ok(transport.screenCount > 0, label(sample, 'missing screen map'));
  assert.ok(
    transport.screenElementCount >= EXPECTED.screenElements,
    label(sample, `screen map only had ${transport.screenElementCount} elements`),
  );
  assertAtMost(transport.chunkBytes, 100 * 1024, label(sample, 'chunk bytes'));
  assertAtMost(transport.collectorBytes, 150 * 1024, label(sample, 'collector bytes'));

  assert.ok(lifecycle.sessionId, label(sample, 'reinitialization session id'));
  assert.ok(lifecycle.chunkCalls > 0, label(sample, 'reinitialization chunks'));
  assert.equal(lifecycle.fullSnapshots, 2, label(sample, 'reinitialization full snapshots'));
  assert.equal(lifecycle.semanticClicks, 1, label(sample, 'reinitialization clicks'));
  assert.equal(lifecycle.pageViews, 2, label(sample, 'reinitialization page views'));
  assert.equal(cancelledInitialization.sessionId, null, label(sample, 'cancelled session id'));
  assert.equal(cancelledInitialization.chunkCalls, 0, label(sample, 'cancelled session chunks'));
}

function assertActivePerformance(sample, multiplier = 1) {
  assertAtMost(
    sample.load.scriptDurationMs,
    120 * multiplier,
    label(sample, 'bundle load script time'),
  );
  assertAtMost(sample.load.totalBlockingTimeMs, 75 * multiplier, label(sample, 'bundle load TBT'));
  assertAtMost(sample.load.maxFrameGapMs, 180 * multiplier, label(sample, 'bundle load frame gap'));
  assertAtMost(
    sample.init.scriptDurationMs,
    150 * multiplier,
    label(sample, 'initialization script time'),
  );
  assertAtMost(
    sample.init.totalBlockingTimeMs,
    100 * multiplier,
    label(sample, 'initialization TBT'),
  );
  assertAtMost(
    sample.init.maxFrameGapMs,
    180 * multiplier,
    label(sample, 'initialization frame gap'),
  );
  assertAtMost(
    sample.network.fetchDispatchP95Ms,
    35 * multiplier,
    label(sample, 'fetch dispatch p95'),
  );
  assertAtMost(sample.network.xhrDispatchP95Ms, 35 * multiplier, label(sample, 'XHR dispatch p95'));
  assertAtMost(
    sample.network.xhrCallbackDelayP95Ms,
    35 * multiplier,
    label(sample, 'XHR application callback delay p95'),
  );
  assertAtMost(
    sample.chunkFlush.durationMs,
    1000 * multiplier,
    label(sample, 'large chunk flush time'),
  );
  assertAtMost(
    sample.chunkFlush.totalBlockingTimeMs,
    100 * multiplier,
    label(sample, 'large chunk flush TBT'),
  );
  assertAtMost(
    sample.chunkFlush.maxFrameGapMs,
    120 * multiplier,
    label(sample, 'large chunk flush frame gap'),
  );
  assertAtMost(sample.flush.durationMs, 1000 * multiplier, label(sample, 'flush duration'));
  assertAtMost(sample.flush.scriptDurationMs, 35 * multiplier, label(sample, 'flush script time'));
  assertAtMost(sample.flush.totalBlockingTimeMs, 75 * multiplier, label(sample, 'flush TBT'));
  assertAtMost(sample.flush.maxFrameGapMs, 180 * multiplier, label(sample, 'flush frame gap'));
  assertAtMost(sample.teardown.durationMs, 50 * multiplier, label(sample, 'teardown duration'));
  assert.equal(
    sample.teardown.externalFetchPreserved,
    true,
    label(sample, 'external fetch wrapper'),
  );
  assert.equal(sample.teardown.externalXhrPreserved, true, label(sample, 'external XHR wrapper'));
  assertAtMost(sample.heap.usedBytes, 12 * 1024 * 1024 * multiplier, label(sample, 'heap usage'));
}

function assertLoadedPerformance(sample, multiplier = 1) {
  assertAtMost(
    sample.load.scriptDurationMs,
    120 * multiplier,
    label(sample, 'bundle load script time'),
  );
  assertAtMost(sample.load.totalBlockingTimeMs, 75 * multiplier, label(sample, 'bundle load TBT'));
  assertAtMost(sample.load.maxFrameGapMs, 180 * multiplier, label(sample, 'bundle load frame gap'));
  assertAtMost(sample.heap.usedBytes, 5 * 1024 * 1024 * multiplier, label(sample, 'loaded heap'));
}

export function assertPerformanceBudgets(report) {
  assertAtMost(report.bundle.gzipBytes, 100 * 1024, 'gzip bundle size');

  for (const sample of report.samples) {
    assert.deepEqual(sample.errors, [], label(sample, 'browser errors'));
    if (sample.mode === 'active') {
      assertActiveFidelity(sample);
      assertActivePerformance(sample, 2);
    }
    if (sample.mode === 'loaded') {
      assertLoadedPerformance(sample, 2);
    }
    if (sample.mode === 'off') {
      assert.equal(
        sample.network.requestCount,
        EXPECTED.scenarioRequests,
        label(sample, 'requests'),
      );
    }
  }

  assertActivePerformance(report.summary.modes.active);
  assertLoadedPerformance(report.summary.modes.loaded);
  assertAtMost(impact(report, 'idle', 'taskDurationMs').delta, 100, 'idle task overhead');
  assertAtMost(impact(report, 'dom', 'durationMs').delta, 400, 'DOM elapsed overhead');
  assertAtMost(impact(report, 'dom', 'taskDurationMs').delta, 450, 'DOM task overhead');
  assertAtMost(impact(report, 'dom', 'totalBlockingTimeMs').delta, 150, 'DOM TBT overhead');
  assertAtMost(impact(report, 'dom', 'maxLongTaskMs').delta, 150, 'DOM longest-task overhead');
  assertAtMost(impact(report, 'network', 'taskDurationMs').delta, 250, 'network task overhead');
  assertAtMost(impact(report, 'network', 'totalBlockingTimeMs').delta, 100, 'network TBT overhead');
  assertAtMost(
    impact(report, 'network', 'maxFrameGapMs').delta,
    120,
    'network max frame gap overhead',
  );
  assertAtMost(
    impact(report, 'chunkStress', 'scriptDurationMs').delta,
    100,
    'chunk stress script overhead',
  );
  assertAtMost(
    impact(report, 'chunkStress', 'totalBlockingTimeMs').delta,
    150,
    'chunk stress TBT overhead',
  );
  assertAtMost(
    impact(report, 'chunkStress', 'maxFrameGapMs').delta,
    180,
    'chunk stress max frame gap overhead',
  );
}
