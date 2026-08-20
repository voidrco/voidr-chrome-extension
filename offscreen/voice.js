const TARGET_SAMPLE_RATE = 16_000;
const SEGMENT_SECONDS = 15;

let capture = null;

function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function resample(chunks, sourceRate) {
  const sourceLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const source = new Float32Array(sourceLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    source.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  const targetLength = Math.max(1, Math.round((source.length * TARGET_SAMPLE_RATE) / sourceRate));
  const pcm = new Int16Array(targetLength);
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(source.length - 1, Math.floor(position));
    const right = Math.min(source.length - 1, left + 1);
    const mix = position - left;
    const sample = Math.max(-1, Math.min(1, source[left] * (1 - mix) + source[right] * mix));
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return pcm;
}

async function emitSegment() {
  if (!capture || capture.frames === 0) return;
  const active = capture;
  const chunks = active.chunks;
  const frames = active.frames;
  active.chunks = [];
  active.frames = 0;
  const pcm = resample(chunks, active.context.sampleRate);
  if (pcm.byteLength < 320) return;
  const startedAtMs = active.baseOffsetMs + active.emittedDurationMs;
  const durationMs = Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000);
  active.emittedDurationMs += durationMs;
  await chrome.runtime.sendMessage({
    action: 'voidr:voicePcmSegment',
    verificationId: active.verificationId,
    generation: active.generation,
    tabId: active.tabId,
    segment: {
      generation: active.generation,
      segmentId: crypto.randomUUID(),
      startedAtMs,
      endedAtMs: startedAtMs + durationMs,
      sampleRate: TARGET_SAMPLE_RATE,
      language: active.language,
      pcmBase64: pcmBase64(pcm),
    },
  });
}

async function stopCapture() {
  const active = capture;
  if (!active) return;
  if (active.timer) clearInterval(active.timer);
  active.processor.disconnect();
  active.source.disconnect();
  await emitSegment();
  active.stream.getTracks().forEach((track) => track.stop());
  await active.context.close();
  capture = null;
}

async function startCapture(message) {
  await stopCapture();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  const context = new AudioContext({ latencyHint: 'interactive' });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentOutput = context.createGain();
  silentOutput.gain.value = 0;
  capture = {
    verificationId: message.verificationId,
    generation: message.generation,
    tabId: message.tabId,
    language: message.language || 'pt-BR',
    baseOffsetMs: Math.max(0, Number(message.baseOffsetMs) || 0),
    emittedDurationMs: 0,
    chunks: [],
    frames: 0,
    stream,
    context,
    source,
    processor,
    timer: null,
  };
  processor.onaudioprocess = (event) => {
    if (!capture) return;
    const copy = new Float32Array(event.inputBuffer.getChannelData(0));
    capture.chunks.push(copy);
    capture.frames += copy.length;
  };
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(context.destination);
  capture.timer = setInterval(() => void emitSegment(), SEGMENT_SECONDS * 1000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'voidr:offscreenStartVoice') {
    startCapture(message)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.action === 'voidr:offscreenStopVoice') {
    stopCapture()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }
});
