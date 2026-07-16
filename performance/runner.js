import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { arch, cpus, platform, release } from 'node:os';
import { chromium } from 'playwright';
import { startBenchmarkServers } from './server.js';
import { summarizeSamples } from './metrics.js';

const TIMED_METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
const CONTROL_WARMUP_MS = 2200;
const ACTION_TIMEOUT_MS = 15_000;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ACTION_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const toMetricMap = ({ metrics }) =>
  Object.fromEntries(metrics.map(({ name, value }) => [name, value]));

async function readCdpMetrics(client) {
  return toMetricMap(await client.send('Performance.getMetrics'));
}

function diffCdpMetrics(before, after) {
  return Object.fromEntries(
    TIMED_METRICS.map((name) => [
      `${name[0].toLowerCase()}${name.slice(1)}Ms`,
      ((after[name] || 0) - (before[name] || 0)) * 1000,
    ]),
  );
}

async function measure({ client, page, action, settleMs = 75 }) {
  await page.evaluate(() => window.BenchmarkFixture.resetObservation());
  const before = await readCdpMetrics(client);
  const value = await withTimeout(Promise.resolve().then(action), 'benchmark action');
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  const after = await readCdpMetrics(client);
  const observation = await page.evaluate(() => window.BenchmarkFixture.readObservation());
  return { ...value, ...diffCdpMetrics(before, after), ...observation };
}

async function loadCollector({ client, page, appUrl }) {
  return measure({
    client,
    page,
    action: async () => {
      const startedAt = performance.now();
      await page.addScriptTag({ url: `${appUrl}/recorder.js` });
      return { durationMs: performance.now() - startedAt };
    },
  });
}

async function initCollector({ client, page, collectorUrl }) {
  return measure({
    client,
    page,
    settleMs: 150,
    action: () =>
      page.evaluate(async (url) => {
        const startedAt = performance.now();
        await window.VoidrCollector.init({
          apiKey: 'performance-benchmark',
          applicationId: 'performance-benchmark',
          collectorUrl: url,
          samplingRate: 1,
          system: true,
        });
        return { durationMs: performance.now() - startedAt };
      }, collectorUrl),
  });
}

const idleScenario = ({ client, page }) =>
  measure({
    client,
    page,
    settleMs: 0,
    action: async () => {
      const startedAt = performance.now();
      await page.evaluate(() => window.BenchmarkFixture.wait(3800));
      return { durationMs: performance.now() - startedAt };
    },
  });

const domScenario = ({ client, page }) =>
  measure({
    client,
    page,
    settleMs: 100,
    action: () => page.evaluate(() => window.BenchmarkFixture.runDomStress()),
  });

const networkScenario = ({ client, page }) =>
  measure({
    client,
    page,
    settleMs: 300,
    action: () => page.evaluate(() => window.BenchmarkFixture.runNetworkStress()),
  });

const chunkStressScenario = ({ client, page }) =>
  measure({
    client,
    page,
    settleMs: 100,
    action: () => page.evaluate(() => window.BenchmarkFixture.runChunkStress()),
  });

async function flushScenario({ client, page, active }) {
  return measure({
    client,
    page,
    settleMs: 100,
    action: () =>
      page.evaluate(async (enabled) => {
        const startedAt = performance.now();
        if (enabled) await window.VoidrCollector.flush();
        return { durationMs: performance.now() - startedAt };
      }, active),
  });
}

async function readHeap(client) {
  await client.send('HeapProfiler.collectGarbage');
  const usage = await client.send('Runtime.getHeapUsage');
  return { usedBytes: usage.usedSize, totalBytes: usage.totalSize };
}

async function teardownCollector({ page, active }) {
  if (!active) return { durationMs: 0 };
  return page.evaluate(() => {
    const collectorFetch = window.fetch;
    const externalFetch = (...args) => collectorFetch(...args);
    window.fetch = externalFetch;
    const CollectorXHR = window.XMLHttpRequest;
    function ExternalXHR() {
      return new CollectorXHR();
    }
    Object.setPrototypeOf(ExternalXHR, CollectorXHR);
    ExternalXHR.prototype = CollectorXHR.prototype;
    window.XMLHttpRequest = ExternalXHR;
    const startedAt = performance.now();
    window.VoidrCollector.endSession();
    return {
      durationMs: performance.now() - startedAt,
      externalFetchPreserved: window.fetch === externalFetch,
      externalXhrPreserved: window.XMLHttpRequest === ExternalXHR,
    };
  });
}

async function reinitializeCollector({ page, active, collectorUrl, servers }) {
  if (!active) return null;
  const before = servers.readStats();
  const initialized = await withTimeout(
    page.evaluate(async (url) => {
      const startedAt = performance.now();
      const initPromise = window.VoidrCollector.init({
        apiKey: 'performance-benchmark',
        applicationId: 'performance-benchmark',
        collectorUrl: url,
        samplingRate: 1,
        system: true,
        meta: { benchmarkInitDelayMs: 150 },
      });
      await window.BenchmarkFixture.wait(25);
      window.VoidrCollector.pause();
      window.VoidrCollector.resume();
      await initPromise;
      return {
        durationMs: performance.now() - startedAt,
        sessionId: window.VoidrCollector.getSessionId(),
      };
    }, collectorUrl),
    'collector reinitialization',
  );
  await withTimeout(
    page.evaluate(async () => {
      document.querySelector('button')?.click();
      history.pushState({}, '', '/lifecycle-reinitialized');
      await window.BenchmarkFixture.wait(200);
      window.VoidrCollector.track('lifecycle.reinitialized');
      await window.VoidrCollector.flush();
      window.VoidrCollector.endSession();
    }),
    'collector lifecycle validation',
  );
  await page.waitForTimeout(100);
  const after = servers.readStats();
  return {
    ...initialized,
    chunkCalls: after.chunkCalls - before.chunkCalls,
    fullSnapshots: after.fullSnapshotCount - before.fullSnapshotCount,
    semanticClicks: after.semanticClickCount - before.semanticClickCount,
    pageViews: after.pageViewCount - before.pageViewCount,
  };
}

async function cancelPendingInitialization({ page, active, collectorUrl, servers }) {
  if (!active) return null;
  const before = servers.readStats();
  const result = await withTimeout(
    page.evaluate(async (url) => {
      const startedAt = performance.now();
      const initPromise = window.VoidrCollector.init({
        apiKey: 'performance-benchmark',
        applicationId: 'performance-benchmark',
        collectorUrl: url,
        samplingRate: 1,
        system: true,
        meta: { benchmarkInitDelayMs: 250 },
      });
      await window.BenchmarkFixture.wait(25);
      window.VoidrCollector.endSession();
      await initPromise;
      return {
        durationMs: performance.now() - startedAt,
        sessionId: window.VoidrCollector.getSessionId(),
      };
    }, collectorUrl),
    'collector initialization cancellation',
  );
  await page.waitForTimeout(100);
  const after = servers.readStats();
  return { ...result, chunkCalls: after.chunkCalls - before.chunkCalls };
}

async function runMode({ browser, cpuThrottle, iteration, mode, servers }) {
  servers.resetStats();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const client = await context.newCDPSession(page);
  await client.send('Performance.enable');
  await client.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  await page.goto(servers.appUrl, { waitUntil: 'load' });

  const load =
    mode === 'off' ? null : await loadCollector({ client, page, appUrl: servers.appUrl });
  if (mode === 'loaded') {
    const heap = await readHeap(client);
    await context.close();
    return { iteration, mode, load, heap, errors };
  }

  const active = mode === 'active';
  const init = active
    ? await initCollector({ client, page, collectorUrl: servers.collectorUrl })
    : null;
  if (!active) await page.waitForTimeout(CONTROL_WARMUP_MS);
  const idle = await idleScenario({ client, page });
  const dom = await domScenario({ client, page });
  const network = await networkScenario({ client, page });
  const flush = await flushScenario({ client, page, active });
  const chunkStress = await chunkStressScenario({ client, page });
  const chunkFlush = await flushScenario({ client, page, active });
  const heap = await readHeap(client);
  const transport = servers.readStats();
  const teardown = await teardownCollector({ page, active });
  const lifecycle = await reinitializeCollector({
    page,
    active,
    collectorUrl: servers.collectorUrl,
    servers,
  });
  const cancelledInitialization = await cancelPendingInitialization({
    page,
    active,
    collectorUrl: servers.collectorUrl,
    servers,
  });
  await context.close();
  return {
    iteration,
    mode,
    load,
    init,
    idle,
    dom,
    network,
    chunkStress,
    flush,
    chunkFlush,
    heap,
    teardown,
    lifecycle,
    cancelledInitialization,
    transport,
    errors,
  };
}

async function bundleMetadata(bundlePath) {
  const [contents, details] = await Promise.all([readFile(bundlePath), stat(bundlePath)]);
  return {
    path: bundlePath,
    sha256: createHash('sha256').update(contents).digest('hex'),
    rawBytes: details.size,
    gzipBytes: gzipSync(contents, { level: 9 }).length,
    brotliBytes: brotliCompressSync(contents).length,
  };
}

const MODE_ORDERS = [
  ['off', 'active', 'loaded'],
  ['loaded', 'off', 'active'],
  ['active', 'loaded', 'off'],
];

const modeOrder = (iteration) => MODE_ORDERS[iteration % MODE_ORDERS.length];

export async function runBenchmark({ bundlePath, cpuThrottle = 4, iterations = 3 }) {
  const servers = await startBenchmarkServers(bundlePath);
  let browser = null;
  let browserVersion = null;
  const samples = [];

  try {
    browser = await chromium.launch({ headless: true });
    browserVersion = browser.version();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const mode of modeOrder(iteration)) {
        samples.push(await runMode({ browser, cpuThrottle, iteration, mode, servers }));
      }
    }
  } finally {
    await Promise.allSettled([browser?.close(), servers.close()]);
  }

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model || 'unknown',
      browser: browserVersion,
      cpuThrottle,
      iterations,
    },
    bundle: await bundleMetadata(bundlePath),
    samples,
    summary: summarizeSamples(samples),
  };
}
