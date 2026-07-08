import { state } from './state.js';

// Sentry-style buffer mode: sessions that lose the samplingRate dice roll keep
// recording into an in-memory ring buffer. On the first error the
// onErrorSampleRate decides (sticky) whether the session upgrades to a real
// recording (buffer + everything after is sent) or is discarded entirely.
const TRIM_INTERVAL_MS = 10000;
const MAX_BUFFER_EVENTS = 5000;

let upgradeFn = null;
let trimInterval = null;
let decision = null; // null = undecided, true = upgraded, false = discarded

function trimBuffer() {
  const events = state.events;
  if (events.length === 0) return;

  // Keep from the Meta(4) that precedes the last-but-one FullSnapshot(2) so
  // the replay always starts from a valid snapshot.
  const snapshotIdx = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type === 2) snapshotIdx.push(i);
  }
  if (snapshotIdx.length >= 2) {
    let cut = snapshotIdx[snapshotIdx.length - 2];
    if (cut > 0 && events[cut - 1]?.type === 4) cut -= 1;
    if (cut > 0) events.splice(0, cut);
  }

  if (events.length > MAX_BUFFER_EVENTS) {
    // Oversized even after snapshot trim — drop to the newest snapshot.
    const lastSnap = snapshotIdx.length ? snapshotIdx[snapshotIdx.length - 1] : -1;
    if (lastSnap > 0) {
      let cut = lastSnap;
      if (events[cut - 1]?.type === 4) cut -= 1;
      events.splice(0, cut);
    }
  }
}

export function armBufferMode(onUpgrade) {
  state.bufferMode = true;
  upgradeFn = onUpgrade;
  decision = null;
  trimInterval = setInterval(trimBuffer, TRIM_INTERVAL_MS);
}

export function disarmBufferMode() {
  state.bufferMode = false;
  upgradeFn = null;
  decision = null;
  if (trimInterval) {
    clearInterval(trimInterval);
    trimInterval = null;
  }
}

/**
 * Called from the error/network paths when a trigger condition fires.
 * @param {string} reason - e.g. 'js-error', 'rejection', 'network-5xx'
 */
export function notifyBufferTrigger(reason) {
  if (!state.bufferMode || state.bufferUpgradeInFlight) return;
  if (decision === false) return;

  if (decision === null) {
    decision = Math.random() <= (state.config.onErrorSampleRate || 0);
    if (!decision) {
      // Not sampled: discard the buffer and stop recording for this session.
      if (state.stopRecording) {
        try {
          state.stopRecording();
        } catch {
          /* noop */
        }
        state.stopRecording = null;
      }
      state.events.length = 0;
      state.networkBuffer.length = 0;
      disarmBufferMode();
      decision = false;
      return;
    }
  }

  if (upgradeFn) {
    state.bufferUpgradeInFlight = true;
    const fn = upgradeFn;
    upgradeFn = null;
    Promise.resolve(fn(reason)).finally(() => {
      state.bufferUpgradeInFlight = false;
    });
  }
}
