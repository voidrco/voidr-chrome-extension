import { safeStringify } from './utils/helpers.js';

export const DEFAULT_CHUNK_TARGET_BYTES = 8 * 1024 * 1024;
export const BODY_TRUNCATION_MARKER = '[TRUNCATED: exceeded collector chunk limit]';

const BODY_FIELDS = ['requestBody', 'responseBody', 'response'];
const OMITTED_JSON_TYPES = new Set(['undefined', 'function', 'symbol']);

export function utf8ByteLength(value) {
  const text = String(value ?? '');
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }

  return bytes;
}

export function targetChunkBytes(maxBytes) {
  const parsed = Number(maxBytes);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed * 0.8))
    : DEFAULT_CHUNK_TARGET_BYTES;
}

export const isNetworkBatchEvent = (event) =>
  event?.type === 5 &&
  event?.data?.plugin === 'network.batch' &&
  Array.isArray(event?.data?.payload?.requests);

function estimateJsonValue(value, seen) {
  if (value === null) return 4;
  if (typeof value === 'string') return 2 + value.length * 2;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
  if (OMITTED_JSON_TYPES.has(typeof value)) return null;
  if (typeof value?.toJSON === 'function') return estimateJsonValue(value.toJSON(), seen);
  if (seen.has(value)) return 22;
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.map((item) => estimateJsonValue(item, seen) ?? 4);
    return 2 + items.reduce((total, bytes) => total + bytes, 0) + Math.max(0, items.length - 1);
  }

  const entries = Object.keys(value)
    .map((key) => [key, estimateJsonValue(value[key], seen)])
    .filter(([, bytes]) => bytes !== null);
  return (
    2 +
    entries.reduce((total, [key, bytes]) => total + 2 + key.length * 2 + 1 + bytes, 0) +
    Math.max(0, entries.length - 1)
  );
}

export const jsonValueByteLength = (value) => utf8ByteLength(safeStringify(value) ?? 'null');
const jsonBytes = (value) => estimateJsonValue(value, new WeakSet()) ?? 0;

const withNetworkRequests = (event, requests) => ({
  ...event,
  data: {
    ...event.data,
    payload: {
      ...event.data.payload,
      requests,
    },
  },
});

const createChunkItem = ({ wireEvents, retryEvents, serializePayload }) => {
  const serializedPayload = serializePayload(wireEvents);
  return {
    wireEvents,
    retryEvents,
    serializedPayload,
    byteLength:
      typeof Blob === 'function'
        ? new Blob([serializedPayload]).size
        : utf8ByteLength(serializedPayload),
  };
};

export function materializeChunkItem(item, serializePayload) {
  return item.serializedPayload == null
    ? { ...item, serializedPayload: serializePayload(item.wireEvents) }
    : item;
}

const createEventPair = (wireEvent, retryEvent) => ({
  wireEvent,
  retryEvent,
  byteLength: jsonBytes(wireEvent),
});

const estimateNetworkBatchBytes = (event) =>
  isNetworkBatchEvent(event)
    ? event.data.payload.requests.reduce(
        (total, request) =>
          total +
          BODY_FIELDS.reduce(
            (bodyTotal, field) =>
              bodyTotal + (typeof request?.[field] === 'string' ? request[field].length : 0),
            2048,
          ),
        0,
      )
    : 0;

function groupRequestPairs({ pairs, wrapperBytes, targetBytes }) {
  const initial = { groups: [], current: [], currentBytes: wrapperBytes + 2 };
  const grouped = pairs.reduce((state, pair) => {
    const separatorBytes = state.current.length === 0 ? 0 : 1;
    const candidateBytes = state.currentBytes + separatorBytes + pair.byteLength;
    if (state.current.length > 0 && candidateBytes > targetBytes) {
      state.groups.push(state.current);
      state.current = [pair];
      state.currentBytes = wrapperBytes + 2 + pair.byteLength;
      return state;
    }
    state.current.push(pair);
    state.currentBytes = candidateBytes;
    return state;
  }, initial);
  return grouped.current.length > 0 ? [...grouped.groups, grouped.current] : grouped.groups;
}

function splitNetworkPair(pair, targetBytes) {
  const measuredPair =
    typeof pair.byteLength === 'number' ? pair : createEventPair(pair.wireEvent, pair.retryEvent);
  if (!isNetworkBatchEvent(pair.wireEvent) || !isNetworkBatchEvent(pair.retryEvent)) {
    return [measuredPair];
  }
  const wireRequests = pair.wireEvent.data.payload.requests;
  const retryRequests = pair.retryEvent.data.payload.requests;
  if (wireRequests.length <= 1 || wireRequests.length !== retryRequests.length) {
    return [measuredPair];
  }

  const wrapperBytes = Math.max(0, jsonBytes(withNetworkRequests(pair.wireEvent, [])) - 2);
  const requestPairs = wireRequests.map((wireRequest, index) => ({
    wireRequest,
    retryRequest: retryRequests[index],
    byteLength: jsonBytes(wireRequest),
  }));
  return groupRequestPairs({ pairs: requestPairs, wrapperBytes, targetBytes }).map((group) =>
    createEventPair(
      withNetworkRequests(
        pair.wireEvent,
        group.map(({ wireRequest }) => wireRequest),
      ),
      withNetworkRequests(
        pair.retryEvent,
        group.map(({ retryRequest }) => retryRequest),
      ),
    ),
  );
}

const createEventPairs = (wireEvents, retryEvents, targetBytes) =>
  wireEvents.flatMap((wireEvent, index) => {
    if (estimateNetworkBatchBytes(wireEvent) > targetBytes / 2) {
      return splitNetworkPair({ wireEvent, retryEvent: retryEvents[index] }, targetBytes);
    }
    const pair = createEventPair(wireEvent, retryEvents[index]);
    return pair.byteLength > targetBytes ? splitNetworkPair(pair, targetBytes) : [pair];
  });

function groupEventPairs({ pairs, payloadOverheadBytes, targetBytes }) {
  const initial = { groups: [], current: [], currentBytes: payloadOverheadBytes + 2 };
  const grouped = pairs.reduce((state, pair) => {
    const separatorBytes = state.current.length === 0 ? 0 : 1;
    const candidateBytes = state.currentBytes + separatorBytes + pair.byteLength;
    if (state.current.length > 0 && candidateBytes > targetBytes) {
      state.groups.push(state.current);
      state.current = [pair];
      state.currentBytes = payloadOverheadBytes + 2 + pair.byteLength;
      return state;
    }
    state.current.push(pair);
    state.currentBytes = candidateBytes;
    return state;
  }, initial);
  return grouped.current.length > 0 ? [...grouped.groups, grouped.current] : grouped.groups;
}

function createChunksFromPairs({ pairs, targetBytes, serializePayload }) {
  const emptyPayloadBytes = utf8ByteLength(serializePayload([]));
  const payloadOverheadBytes = Math.max(0, emptyPayloadBytes - 2);
  const groups = groupEventPairs({
    pairs,
    payloadOverheadBytes,
    targetBytes,
  });
  return groups.map((group) => ({
    wireEvents: group.map(({ wireEvent }) => wireEvent),
    retryEvents: group.map(({ retryEvent }) => retryEvent),
    serializedPayload: null,
    byteLength:
      payloadOverheadBytes +
      2 +
      group.reduce((total, pair) => total + pair.byteLength, 0) +
      Math.max(0, group.length - 1),
  }));
}

export function planChunkItem(item, { targetBytes, serializePayload }) {
  if (item.byteLength <= targetBytes || item.wireEvents.length === 0) return [item];
  const pairs = createEventPairs(item.wireEvents, item.retryEvents, targetBytes);
  return createChunksFromPairs({ pairs, targetBytes, serializePayload });
}

export function planChunkBatch({ wireEvents, retryEvents, targetBytes, serializePayload }) {
  if (wireEvents.some((event) => estimateNetworkBatchBytes(event) > targetBytes / 2)) {
    const pairs = createEventPairs(wireEvents, retryEvents, targetBytes);
    return createChunksFromPairs({ pairs, targetBytes, serializePayload });
  }
  const item = createChunkItem({ wireEvents, retryEvents, serializePayload });
  return planChunkItem(item, { targetBytes, serializePayload });
}

export const replanChunkItems = (items, options) =>
  items.flatMap((item) => planChunkItem(item, options));

export const retryEventsForChunks = (items) => items.flatMap(({ retryEvents }) => retryEvents);

const truncationFlag = (field) =>
  field === 'requestBody' ? 'requestBodyTruncated' : 'responseBodyTruncated';

function replaceNetworkBody(requests, candidate) {
  return requests.map((request, index) =>
    index === candidate.index
      ? {
          ...request,
          [candidate.field]: BODY_TRUNCATION_MARKER,
          [truncationFlag(candidate.field)]: true,
        }
      : request,
  );
}

export function truncateLargestNetworkBody(item, serializePayload) {
  if (item.wireEvents.length !== 1 || item.retryEvents.length !== 1) return null;
  const wireEvent = item.wireEvents[0];
  const retryEvent = item.retryEvents[0];
  if (!isNetworkBatchEvent(wireEvent) || !isNetworkBatchEvent(retryEvent)) return null;
  const wireRequests = wireEvent.data.payload.requests;
  const retryRequests = retryEvent.data.payload.requests;
  if (wireRequests.length !== retryRequests.length) return null;

  const candidate = wireRequests
    .flatMap((request, index) =>
      BODY_FIELDS.filter(
        (field) => request?.[field] != null && request[field] !== BODY_TRUNCATION_MARKER,
      ).map((field) => ({ index, field, byteLength: jsonBytes(request[field]) })),
    )
    .sort((left, right) => right.byteLength - left.byteLength)[0];
  if (!candidate) return null;

  const truncated = createChunkItem({
    wireEvents: [withNetworkRequests(wireEvent, replaceNetworkBody(wireRequests, candidate))],
    retryEvents: [withNetworkRequests(retryEvent, replaceNetworkBody(retryRequests, candidate))],
    serializePayload,
  });
  return truncated.byteLength < item.byteLength ? truncated : null;
}
