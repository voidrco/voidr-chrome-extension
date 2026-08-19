import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeSamples } from '../performance/metrics.js';

test('performance impact is the median of same-iteration deltas', () => {
  const samples = [
    { iteration: 0, mode: 'off', workload: { taskDurationMs: 10 } },
    { iteration: 0, mode: 'active', workload: { taskDurationMs: 30 } },
    { iteration: 1, mode: 'off', workload: { taskDurationMs: 100 } },
    { iteration: 1, mode: 'active', workload: { taskDurationMs: 110 } },
    { iteration: 2, mode: 'off', workload: { taskDurationMs: 1000 } },
    { iteration: 2, mode: 'active', workload: { taskDurationMs: 1300 } },
  ];

  const report = summarizeSamples(samples);

  assert.equal(report.impact.workload.taskDurationMs.control, 100);
  assert.equal(report.impact.workload.taskDurationMs.active, 110);
  assert.equal(report.impact.workload.taskDurationMs.delta, 20);
});
