import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BODY_TRUNCATION_MARKER,
  jsonValueByteLength,
  planChunkBatch,
  retryEventsForChunks,
  targetChunkBytes,
  truncateLargestNetworkBody,
  utf8ByteLength,
} from '../src/chunk-planner.js';
import { safeStringify } from '../src/utils/helpers.js';

const serializePayload = (events) => safeStringify({ sessionId: 'test', events });

const networkBatch = (requests) => ({
  type: 5,
  timestamp: 1700000000000,
  data: { plugin: 'network.batch', payload: { requests } },
});

describe('chunk planner', () => {
  it('measures UTF-8 bytes exactly', () => {
    const samples = ['ascii', 'ação', '🙂', 'a🙂ç', '\ud800', '"\\\n'];
    for (const sample of samples) {
      assert.equal(utf8ByteLength(sample), Buffer.byteLength(sample));
    }
  });

  it('matches the UTF-8 size of serialized JSON', () => {
    const shared = { value: 'ação🙂\n"\\' };
    const value = {
      shared,
      repeated: shared,
      array: [undefined, null, true, -12.5, '\ud800'],
      omitted: undefined,
    };
    assert.equal(jsonValueByteLength(value), Buffer.byteLength(safeStringify(value)));
  });

  it('uses eighty percent of a server limit and a stable fallback', () => {
    assert.equal(targetChunkBytes(1000), 800);
    assert.equal(targetChunkBytes(null), 8 * 1024 * 1024);
  });

  it('partitions ordered events without mutating retry events', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      type: 3,
      timestamp: 1700000000000 + index,
      data: { index, value: 'x'.repeat(160) },
    }));
    const snapshot = structuredClone(events);
    const chunks = planChunkBatch({
      wireEvents: events,
      retryEvents: events,
      targetBytes: 500,
      serializePayload,
    });

    assert.ok(chunks.length > 1);
    assert.ok(
      chunks.every(({ byteLength, wireEvents }) => byteLength <= 500 || wireEvents.length === 1),
    );
    assert.deepEqual(
      chunks.flatMap(({ wireEvents }) => wireEvents.map(({ data }) => data.index)),
      Array.from({ length: 12 }, (_, index) => index),
    );
    assert.deepEqual(retryEventsForChunks(chunks), events);
    assert.deepEqual(events, snapshot);
  });

  it('splits network batches by request while preserving every body and id', () => {
    const requests = Array.from({ length: 4 }, (_, index) => ({
      requestId: `request-${index}`,
      requestBody: `request-${'x'.repeat(280)}`,
      responseBody: `response-${'y'.repeat(280)}`,
    }));
    const event = networkBatch(requests);
    const snapshot = structuredClone(event);
    const chunks = planChunkBatch({
      wireEvents: [event],
      retryEvents: [event],
      targetBytes: 900,
      serializePayload,
    });
    const delivered = chunks.flatMap(({ wireEvents }) => wireEvents[0].data.payload.requests);

    assert.ok(chunks.length > 1);
    assert.deepEqual(delivered, requests);
    assert.deepEqual(event, snapshot);
  });

  it('truncates only the largest body and mirrors it into retry data', () => {
    const event = networkBatch([
      {
        requestId: 'request-1',
        requestBody: 'q'.repeat(300),
        responseBody: 'r'.repeat(900),
      },
    ]);
    const [item] = planChunkBatch({
      wireEvents: [event],
      retryEvents: [event],
      targetBytes: 5000,
      serializePayload,
    });
    const truncated = truncateLargestNetworkBody(item, serializePayload);
    const wireRequest = truncated.wireEvents[0].data.payload.requests[0];
    const retryRequest = truncated.retryEvents[0].data.payload.requests[0];

    assert.equal(wireRequest.responseBody, BODY_TRUNCATION_MARKER);
    assert.equal(retryRequest.responseBody, BODY_TRUNCATION_MARKER);
    assert.equal(wireRequest.requestBody, event.data.payload.requests[0].requestBody);
    assert.equal(wireRequest.responseBodyTruncated, true);
    assert.equal(event.data.payload.requests[0].responseBody, 'r'.repeat(900));
  });
});
