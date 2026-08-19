import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const jwtPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${jwtPart({ alg: 'none' })}.${jwtPart({ exp: 4102444800 })}.benchmark`;
const largeXhrResponse = JSON.stringify({ ok: true, value: 'r'.repeat(2300 * 1024) });
const maxChunkPayloadBytes = 10 * 1024 * 1024;

const write = (response, status, body = '', headers = {}) => {
  response.writeHead(status, headers);
  response.end(body);
};

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function createStats() {
  const values = {
    apiCalls: 0,
    apiBytes: 0,
    collectorCalls: 0,
    collectorBytes: 0,
    chunkCalls: 0,
    chunkBytes: 0,
    maxChunkEventBytes: 0,
    chunkRejected413: 0,
    screenMapCalls: 0,
    eventCount: 0,
    fullSnapshotCount: 0,
    semanticClickCount: 0,
    semanticInputCount: 0,
    pageViewCount: 0,
    networkBatchCount: 0,
    networkRequestCount: 0,
    networkFetchRequestCount: 0,
    networkXhrRequestCount: 0,
    screenCount: 0,
    screenElementCount: 0,
    decodeErrors: 0,
  };

  return {
    values,
    reset: () => Object.keys(values).forEach((key) => (values[key] = 0)),
    snapshot: () => ({ ...values }),
  };
}

function createAppHandler({ bundlePath, stats }) {
  const files = new Map([
    ['/', resolve(root, 'fixture.html')],
    ['/fixture.js', resolve(root, 'fixture.js')],
    ['/recorder.js', bundlePath],
  ]);

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/echo') {
      const body = await readBody(request);
      stats.values.apiCalls += 1;
      stats.values.apiBytes += body.length;
      write(response, 200, JSON.stringify({ ok: true }), {
        'Content-Type': 'application/json',
      });
      return;
    }

    if (url.pathname === '/api/xhr-probe') {
      const body = await readBody(request);
      stats.values.apiCalls += 1;
      stats.values.apiBytes += body.length;
      write(response, 200, url.searchParams.get('id') === '0' ? largeXhrResponse : '{"ok":true}', {
        'Content-Type': 'application/json',
      });
      return;
    }

    const file = files.get(url.pathname);
    if (!file) return write(response, 404);
    const extension = file.endsWith('.html') ? '.html' : '.js';
    write(response, 200, await readFile(file), { 'Content-Type': contentTypes[extension] });
  };
}

function decodeJsonBody(request, body) {
  const decoded = request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
  return JSON.parse(decoded.toString('utf8'));
}

function recordChunkStats(stats, events) {
  stats.values.eventCount += events.length;
  stats.values.fullSnapshotCount += events.filter((event) => event.type === 2).length;
  stats.values.semanticClickCount += events.filter(
    (event) => event.data?.plugin === 'user.click',
  ).length;
  stats.values.semanticInputCount += events.filter(
    (event) => event.data?.plugin === 'user.input',
  ).length;
  stats.values.pageViewCount += events.filter((event) => event.data?.plugin === 'page.view').length;
  const networkBatches = events.filter((event) => event.data?.plugin === 'network.batch');
  stats.values.networkBatchCount += networkBatches.length;
  const requests = networkBatches.flatMap((event) => event.data?.payload?.requests || []);
  stats.values.networkRequestCount += requests.length;
  stats.values.networkFetchRequestCount += requests.filter(({ type }) => type === 'fetch').length;
  stats.values.networkXhrRequestCount += requests.filter(({ type }) => type === 'xhr').length;
}

function recordScreenMapStats(stats, request, body) {
  try {
    const payload = decodeJsonBody(request, body);
    const screens = Array.isArray(payload.screens) ? payload.screens : [];
    stats.values.screenCount += screens.length;
    stats.values.screenElementCount += screens.reduce(
      (count, screen) => count + (Array.isArray(screen.elements) ? screen.elements.length : 0),
      0,
    );
  } catch {
    stats.values.decodeErrors += 1;
  }
}

const corsHeaders = (request) => ({
  'Access-Control-Allow-Origin': request.headers.origin || '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-encoding, content-type',
  'Access-Control-Max-Age': '600',
});

function createCollectorHandler(stats) {
  return async (request, response) => {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return write(response, 204, '', headers);
    const url = new URL(request.url, 'http://localhost');
    const body = await readBody(request);
    const bytes = body.length;
    stats.values.collectorCalls += 1;
    stats.values.collectorBytes += bytes;

    if (url.pathname === '/init') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const delayMs = Math.min(1000, Number(payload.meta?.benchmarkInitDelayMs) || 0);
      if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      write(
        response,
        200,
        JSON.stringify({
          token,
          sessionId: `benchmark-${Date.now()}`,
          ingest: { maxChunkPayloadBytes },
        }),
        { ...headers, 'Content-Type': 'application/json' },
      );
      return;
    }

    if (url.pathname === '/sessions/chunk') {
      stats.values.chunkCalls += 1;
      stats.values.chunkBytes += bytes;
      try {
        const payload = decodeJsonBody(request, body);
        const events = Array.isArray(payload.events) ? payload.events : [];
        const eventBytes = Buffer.byteLength(JSON.stringify(events));
        stats.values.maxChunkEventBytes = Math.max(stats.values.maxChunkEventBytes, eventBytes);
        if (eventBytes > maxChunkPayloadBytes) {
          stats.values.chunkRejected413 += 1;
          write(
            response,
            413,
            JSON.stringify({ code: 'CHUNK_TOO_LARGE', maxBytes: maxChunkPayloadBytes }),
            { ...headers, 'Content-Type': 'application/json' },
          );
          return;
        }
        recordChunkStats(stats, events);
      } catch {
        stats.values.decodeErrors += 1;
      }
    }
    if (url.pathname === '/screen-map/sync') {
      stats.values.screenMapCalls += 1;
      recordScreenMapStats(stats, request, body);
    }
    write(response, 204, '', headers);
  };
}

export async function startBenchmarkServers(bundlePath) {
  const stats = createStats();
  const appServer = createServer(createAppHandler({ bundlePath, stats }));
  const collectorServer = createServer(createCollectorHandler(stats));
  const [appUrl, collectorUrl] = await Promise.all([listen(appServer), listen(collectorServer)]);

  return {
    appUrl,
    collectorUrl,
    resetStats: stats.reset,
    readStats: stats.snapshot,
    close: () =>
      Promise.all(
        [appServer, collectorServer].map(
          (server) => new Promise((resolveClose) => server.close(resolveClose)),
        ),
      ),
  };
}
