import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { assertPerformanceBudgets } from './budgets.js';
import { runBenchmark } from './runner.js';

test(
  'collector stays inside client-side performance budgets under stress',
  { timeout: 240_000 },
  async () => {
    const report = await runBenchmark({
      bundlePath: resolve('dist/recorder.min.js'),
      cpuThrottle: Number(process.env.PERF_CPU_THROTTLE || 4),
      iterations: Number(process.env.PERF_ITERATIONS || 3),
    });
    await mkdir(resolve('performance/results'), { recursive: true });
    await writeFile(resolve('performance/results/ci.json'), `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(report.samples.length, report.environment.iterations * 3);
    assertPerformanceBudgets(report);
  },
);
