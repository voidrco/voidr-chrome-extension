const SECTION_COUNT = 75;
const CONTROLS_PER_SECTION = 20;
const STREAM_CHUNKS = 10;
const STREAM_CHUNK_DELAY_MS = 30;
const FETCH_REQUEST_COUNT = 10;
const XHR_REQUEST_COUNT = 4;
const CHUNK_STRESS_REQUEST_COUNT = 6;
const LARGE_XHR_FIELD_COUNT = 4096;
const LARGE_XHR_FIELD_BYTES = 256;

const percentile = (values, ratio) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildDom() {
  const root = document.querySelector('#app');
  const fragment = document.createDocumentFragment();

  for (let sectionIndex = 0; sectionIndex < SECTION_COUNT; sectionIndex += 1) {
    const section = document.createElement('section');
    section.setAttribute('aria-label', `Group ${sectionIndex}`);

    for (let controlIndex = 0; controlIndex < CONTROLS_PER_SECTION; controlIndex += 1) {
      const index = sectionIndex * CONTROLS_PER_SECTION + controlIndex;
      const control = document.createElement(controlIndex % 5 === 0 ? 'input' : 'button');
      control.dataset.benchmarkIndex = String(index);
      if (control instanceof HTMLInputElement) {
        control.placeholder = `Field ${index}`;
        control.setAttribute('aria-label', `Field ${index}`);
      } else {
        control.textContent = `Action ${index}`;
      }
      section.appendChild(control);
    }
    fragment.appendChild(section);
  }

  root.appendChild(fragment);
}

function createObserverState() {
  const state = { frameGaps: [], longTasks: [], startedAt: performance.now() };
  let previousFrame = performance.now();

  const sampleFrame = (timestamp) => {
    if (timestamp >= state.startedAt) state.frameGaps.push(timestamp - previousFrame);
    previousFrame = timestamp;
    requestAnimationFrame(sampleFrame);
  };

  requestAnimationFrame(sampleFrame);

  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      state.longTasks.push(
        ...list
          .getEntries()
          .filter((entry) => entry.startTime >= state.startedAt)
          .map((entry) => entry.duration),
      );
    });
    observer.observe({ type: 'longtask', buffered: true });
  }

  return state;
}

const observerState = createObserverState();

function resetObservation() {
  observerState.frameGaps.length = 0;
  observerState.longTasks.length = 0;
  observerState.startedAt = performance.now();
}

function readObservation() {
  const longTasks = observerState.longTasks.filter(Boolean);
  const frameGaps = observerState.frameGaps.filter(Boolean);
  return {
    longTaskCount: longTasks.length,
    longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0),
    totalBlockingTimeMs: longTasks.reduce((sum, value) => sum + Math.max(0, value - 50), 0),
    maxLongTaskMs: Math.max(0, ...longTasks),
    frameGapP95Ms: percentile(frameGaps, 0.95),
    maxFrameGapMs: Math.max(0, ...frameGaps),
  };
}

function mutateDom(round) {
  const controls = document.querySelectorAll('[data-benchmark-index]');
  const churn = document.querySelector('#churn');
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < 80; index += 1) {
    const control = controls[(round * 97 + index * 13) % controls.length];
    control.toggleAttribute('data-active', (round + index) % 2 === 0);
    if (control instanceof HTMLInputElement) {
      control.value = `value-${round}-${index}`;
      control.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(index) }));
    } else {
      control.textContent = `Action ${control.dataset.benchmarkIndex} run ${round}`;
      control.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: index, clientY: round }),
      );
    }

    const node = document.createElement('span');
    node.textContent = `mutation-${round}-${index}`;
    fragment.appendChild(node);
  }

  churn.replaceChildren(fragment);
}

async function runDomStress() {
  const startedAt = performance.now();
  for (let round = 0; round < 4; round += 1) {
    mutateDom(round);
    if (round % 2 === 1) history.replaceState({}, '', `?round=${round}`);
    await delay(550);
  }
  await delay(500);
  return { durationMs: performance.now() - startedAt };
}

function createSlowRequest(id) {
  const encoder = new TextEncoder();
  const chunkSize = id === 0 ? 256 * 1024 : 4096;
  const stream = new ReadableStream({
    async start(controller) {
      for (let index = 0; index < STREAM_CHUNKS; index += 1) {
        await delay(STREAM_CHUNK_DELAY_MS);
        controller.enqueue(encoder.encode(`${id}-${index}-${'x'.repeat(chunkSize)}`));
      }
      controller.close();
    },
  });

  return new Request(`/api/probe?id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: stream,
    duplex: 'half',
  });
}

let nativeFetchCalls = [];
const nativeFetch = window.fetch.bind(window);
window.fetch = (...args) => {
  const input = args[0];
  const url = typeof input === 'string' ? input : input?.url;
  if (url?.includes('/api/probe')) {
    nativeFetchCalls.push(performance.now());
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  return nativeFetch(...args);
};

async function waitForNativeFetch(callCount) {
  const deadline = performance.now() + 2000;
  while (nativeFetchCalls.length < callCount) {
    if (performance.now() >= deadline) throw new Error('native fetch dispatch timed out');
    await delay(1);
  }
  return nativeFetchCalls[callCount - 1];
}

async function runNetworkStress() {
  nativeFetchCalls = [];
  const dispatchDelays = [];
  const roundTrips = [];

  for (let index = 0; index < FETCH_REQUEST_COUNT; index += 1) {
    const callCount = nativeFetchCalls.length + 1;
    const startedAt = performance.now();
    const responsePromise = fetch(createSlowRequest(index));
    const dispatchedAt = await waitForNativeFetch(callCount);
    dispatchDelays.push(dispatchedAt - startedAt);
    await responsePromise;
    roundTrips.push(performance.now() - startedAt);
  }

  await delay(STREAM_CHUNKS * STREAM_CHUNK_DELAY_MS + 750);

  return {
    fetchDispatchP50Ms: percentile(dispatchDelays, 0.5),
    fetchDispatchP95Ms: percentile(dispatchDelays, 0.95),
    fetchRoundTripP95Ms: percentile(roundTrips, 0.95),
    fetchRequestCount: FETCH_REQUEST_COUNT,
  };
}

let nativeXhrSendCalls = [];
const BrowserXHR = window.XMLHttpRequest;

function InstrumentedXHR() {
  const xhr = new BrowserXHR();
  const nativeSend = xhr.send;
  let nativeLoadEndAt = 0;

  xhr.addEventListener('loadend', () => {
    nativeLoadEndAt = performance.now();
  });
  xhr.send = function () {
    nativeXhrSendCalls.push(performance.now());
    return nativeSend.apply(this, arguments);
  };
  Object.defineProperty(xhr, '__benchmarkNativeLoadEndAt', {
    get: () => nativeLoadEndAt,
  });
  return xhr;
}

Object.setPrototypeOf(InstrumentedXHR, BrowserXHR);
InstrumentedXHR.prototype = BrowserXHR.prototype;
window.XMLHttpRequest = InstrumentedXHR;

function createXhrBody(id) {
  if (id !== 0) return new URLSearchParams({ id: String(id), value: 'x'.repeat(4096) });
  const body = new FormData();
  for (let index = 0; index < LARGE_XHR_FIELD_COUNT; index += 1) {
    body.append(`field-${index}`, `${index}-${'x'.repeat(LARGE_XHR_FIELD_BYTES)}`);
  }
  return body;
}

function sendXhrProbe(id) {
  const body = createXhrBody(id);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/xhr-probe?id=${id}`);
  xhr.timeout = 5000;
  const startedAt = performance.now();
  const nativeCallIndex = nativeXhrSendCalls.length;

  return new Promise((resolve, reject) => {
    xhr.addEventListener('error', () => reject(new Error(`XHR ${id} failed`)));
    xhr.addEventListener('timeout', () => reject(new Error(`XHR ${id} timed out`)));
    xhr.send(body);
    const dispatchedAt = nativeXhrSendCalls[nativeCallIndex];
    xhr.addEventListener('loadend', () => {
      resolve({
        dispatchMs: dispatchedAt - startedAt,
        callbackDelayMs: performance.now() - xhr.__benchmarkNativeLoadEndAt,
      });
    });
  });
}

async function runXhrStress() {
  nativeXhrSendCalls = [];
  const results = [];
  for (let id = 0; id < XHR_REQUEST_COUNT; id += 1) {
    results.push(await sendXhrProbe(id));
  }
  return {
    xhrDispatchP95Ms: percentile(
      results.map(({ dispatchMs }) => dispatchMs),
      0.95,
    ),
    xhrCallbackDelayP95Ms: percentile(
      results.map(({ callbackDelayMs }) => callbackDelayMs),
      0.95,
    ),
    xhrRequestCount: XHR_REQUEST_COUNT,
  };
}

function sendLargeResponseProbe(id) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/xhr-probe?id=0&chunk=${id}`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 5000;
  return new Promise((resolve, reject) => {
    xhr.addEventListener('loadend', resolve);
    xhr.addEventListener('error', () => reject(new Error(`chunk stress XHR ${id} failed`)));
    xhr.addEventListener('timeout', () => reject(new Error(`chunk stress XHR ${id} timed out`)));
    xhr.send(JSON.stringify({ id }));
  });
}

async function runChunkStress() {
  const startedAt = performance.now();
  for (let id = 0; id < CHUNK_STRESS_REQUEST_COUNT; id += 1) {
    await sendLargeResponseProbe(id);
  }
  return {
    durationMs: performance.now() - startedAt,
    requestCount: CHUNK_STRESS_REQUEST_COUNT,
  };
}

const runCombinedNetworkStress = async () => ({
  ...(await runNetworkStress()),
  ...(await runXhrStress()),
  requestCount: FETCH_REQUEST_COUNT + XHR_REQUEST_COUNT,
});

buildDom();

window.BenchmarkFixture = {
  resetObservation,
  readObservation,
  wait: delay,
  runDomStress,
  runNetworkStress: runCombinedNetworkStress,
  runChunkStress,
  elementCount: document.querySelectorAll('[data-benchmark-index]').length,
};
