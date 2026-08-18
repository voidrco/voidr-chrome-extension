import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from './runner.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(
  process.argv
    .slice(2)
    .map((arg, index, all) => (arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : null))
    .filter(Boolean),
);

const bundlePath = resolve(args.get('bundle') || resolve(root, 'dist/recorder.min.js'));
const outputPath = resolve(args.get('output') || resolve(root, 'performance/results/latest.json'));
const iterations = Number(args.get('iterations') || process.env.PERF_ITERATIONS || 3);
const cpuThrottle = Number(args.get('cpu-throttle') || process.env.PERF_CPU_THROTTLE || 4);

const report = await runBenchmark({ bundlePath, iterations, cpuThrottle });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

const { impact, modes } = report.summary;
console.table({
  bundle: report.bundle,
  startup: {
    initTaskMs: modes.active.init.taskDurationMs,
    initTbtMs: modes.active.init.totalBlockingTimeMs,
  },
  idle: {
    taskDeltaMs: impact.idle.taskDurationMs.delta,
    tbtDeltaMs: impact.idle.totalBlockingTimeMs.delta,
  },
  dom: {
    durationDeltaMs: impact.dom.durationMs.delta,
    taskDeltaMs: impact.dom.taskDurationMs.delta,
    tbtDeltaMs: impact.dom.totalBlockingTimeMs.delta,
  },
  network: {
    fetchDispatchP95Ms: modes.active.network.fetchDispatchP95Ms,
    fetchDispatchDeltaMs: impact.network.fetchDispatchP95Ms.delta,
    xhrDispatchP95Ms: modes.active.network.xhrDispatchP95Ms,
    xhrDispatchDeltaMs: impact.network.xhrDispatchP95Ms.delta,
    xhrCallbackDelayP95Ms: modes.active.network.xhrCallbackDelayP95Ms,
    taskDeltaMs: impact.network.taskDurationMs.delta,
    tbtDeltaMs: impact.network.totalBlockingTimeMs.delta,
  },
  chunkStress: {
    taskDeltaMs: impact.chunkStress.taskDurationMs.delta,
    tbtDeltaMs: impact.chunkStress.totalBlockingTimeMs.delta,
    maxFrameGapMs: modes.active.chunkStress.maxFrameGapMs,
    flushMs: modes.active.chunkFlush.durationMs,
    flushTbtMs: modes.active.chunkFlush.totalBlockingTimeMs,
  },
});
console.log(`Report: ${outputPath}`);
