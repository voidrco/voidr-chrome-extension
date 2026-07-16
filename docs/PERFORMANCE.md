# Client-side performance

The collector has a deterministic Chromium stress suite that runs the same page and workload in three modes: collector absent, bundle loaded but not initialized, and collector active. Performance gates use paired active-minus-control deltas from the same iteration, which reduces host-to-host noise.

## Workload and measurements

Local baseline runs use 4x CPU throttling. The required GitHub check uses 2x, while deployment builds use 1x because their shared workers exhibit substantial control-page blocking time. Paired active-minus-control budgets remain identical. Each iteration exercises:

- 1,500 interactive controls;
- four DOM mutation bursts producing 256 clicks and 64 inputs;
- three page views, including two query-only SPA route updates;
- ten streamed `Request` bodies, including one body larger than 2.5 MiB without `Content-Length`;
- four XHR requests, including large FormData and a JSON response larger than 2 MiB;
- six additional XHR responses whose captured bodies total more than 12 MiB, enough to exceed the collector's 10 MiB uncompressed chunk limit;
- initialization, idle work, gzip flush, screen-map delivery, teardown, cancellation during initialization, and reinitialization after pause/resume.

Chrome DevTools Protocol and in-page `PerformanceObserver` probes collect task, script, layout, long-task, total blocking time, frame-gap, heap, dispatch-latency, bundle-size, request-count, and uploaded-byte metrics. The collector endpoints decode every gzip payload, enforce the production 10 MiB uncompressed limit, and verify event fidelity.

## Baseline captured on 2026-07-15

The before bundle is commit `8eb9c25e12474ff0d000d81e1c2cfd95c0db98df`. Both bundles ran on the same Apple M2 Pro with Node v26.0.0, Chromium 149.0.7827.55, 4x CPU throttling, three iterations, and a balanced Latin-square mode order. The table reports medians, with workload overhead calculated from same-iteration pairs.

| Metric                               |      Before |                After |  Change |
| ------------------------------------ | ----------: | -------------------: | ------: |
| Initialization main-thread task time |  2,169.3 ms |             159.5 ms | -92.65% |
| Initialization TBT                   |    1,961 ms |                 0 ms |   -100% |
| Idle task overhead over control      |    999.8 ms |                ~0 ms |   -100% |
| Idle TBT overhead over control       |      960 ms |                 0 ms |   -100% |
| DOM workload elapsed overhead        |  3,297.7 ms |             153.9 ms | -95.33% |
| DOM workload task overhead           |  3,749.7 ms |             273.0 ms | -92.72% |
| DOM workload TBT overhead            |    3,169 ms |                54 ms | -98.30% |
| Streamed fetch dispatch p95          |  1,311.3 ms |               2.2 ms | -99.83% |
| XHR native dispatch p95              |     20.2 ms |               0.5 ms | -97.52% |
| XHR application callback delay p95   |      3.0 ms |               0.1 ms | -96.67% |
| Network task overhead                |  1,185.9 ms |             116.8 ms | -90.15% |
| Network TBT overhead                 |      977 ms | no positive overhead |   -100% |
| Flush task time                      |    317.9 ms |             157.8 ms | -50.36% |
| Chunk bytes uploaded                 |   213,545 B |             55,957 B | -73.80% |
| Total collector bytes                |   237,418 B |             68,172 B | -71.29% |
| Bundle gzip size                     |    93,251 B |             98,442 B |  +5.57% |
| Used JS heap                         | 4,863,924 B |          5,081,824 B |  +4.48% |

Every optimized sample captured exactly 256 clicks, 64 inputs, three page views, ten fetches, four XHR requests, one initial full snapshot, and a 1,756-element screen map, with no payload decode or browser errors. Browser lifecycle probes verified teardown/reinitialization, pause/resume during authentication, and cancellation without late session or chunk creation. Unit tests additionally cover in-flight flush completion and unload rearming after cancellation or BFCache restoration.

The machine-readable comparison and per-iteration evidence are in `performance/baseline-2026-07-15.json`. CI does not compare against that historical file; it creates a fresh paired control in every run and enforces `performance/budgets.js`.

## Oversized chunk regression captured on 2026-07-15

The final three-iteration gate used the same machine and 4x CPU throttling. It captured all 20 network requests and produced no 413 response, decode error, browser error, duplicated full snapshot, or lost network body.

| Metric                                      |     Median or exact result |
| ------------------------------------------- | -------------------------: |
| Large-response capture duration             |                   190.4 ms |
| Large-response capture TBT                  |                       0 ms |
| Large-response capture maximum frame gap    |                    50.4 ms |
| Remaining large-chunk flush duration        |                   263.9 ms |
| Remaining large-chunk flush TBT             |                       0 ms |
| Remaining large-chunk flush maximum gap     |                    33.1 ms |
| Largest accepted uncompressed `events` body |                4,678,154 B |
| Chunk requests                              |                         13 |
| Collector 413 responses                     |                          0 |
| Final bundle                                | 322,073 B / 101,597 B gzip |

The reactive compatibility path is independently tested against a collector that always returns 413. Delivery stops after eight responses instead of recursively expanding into an unbounded request tree.

## Changes behind the result

- Native `fetch` and XHR dispatch happen before asynchronous request-body capture. Stream, structured-body, header, and response reads are capped and no longer delay the host application's request or XHR callback.
- `ElementMapper` builds one DOM-wide uniqueness index per scan, coalesces startup work, schedules scans during idle time, and rescans only after mutations.
- Mutation-driven full snapshots are thresholded and rate-limited. Query-only route updates no longer force redundant snapshots.
- Flush, token refresh, screen-map upload, authentication, and initialization are bound to a lifecycle and session so stale asynchronous work cannot leak into a later session.
- Chunk planning uses uncompressed UTF-8 byte targets, preserves event and request order, splits `network.batch` events by request, and requeues only the unsent suffix after a partial success.
- Responses larger than 1 MiB trigger a selective early drain, while ordinary network traffic keeps its existing batching behavior.
- The collector advertises its maximum chunk size during initialization. A 413 can update that target, and only the largest body of an indivisible network request is truncated as a final compatibility fallback.
- Unload delivery no longer uses synchronous XHR; payloads within the keepalive quota use `fetch(..., { keepalive: true })`, and larger payloads remain non-blocking.
- DOM listeners, observers, routing and network patches, timers, and injected assets have symmetric teardown and preserve wrappers installed by the host application.
- Font and unreadable-stylesheet inlining are now opt-in, share a 1.5-second deadline, abort on pause/end, and enforce count and byte limits.

## Commands

```bash
npm test
npm run test:performance
npm run performance -- --iterations 5 --output performance/results/manual.json
```

`npm run test:performance` builds the bundle, runs three iterations in each mode, writes `performance/results/ci.json`, and fails on per-sample fidelity and lifecycle violations, a per-sample 2x safety ceiling, nominal median budgets, or median paired-delta regressions. Pull requests upload the JSON report even on failure, and both production and staging deployment pipelines publish only the exact bundle that passed this gate.

For a local before/after comparison, retain the old bundle and run identical commands against both paths:

```bash
npm run performance -- --bundle /tmp/recorder-before.min.js --iterations 3 --output /tmp/before.json
npm run performance -- --bundle dist/recorder.min.js --iterations 3 --output /tmp/after.json
```

This suite is a reproducible regression guarantee for its workload and configured budgets, not proof of zero overhead on every framework, page, device, or customer traffic pattern. Validate major releases against representative customer applications as an additional canary.
