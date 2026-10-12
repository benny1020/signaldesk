# Request flow · v0.4

2026-10-12. Build around the actual boundary: caller → our API → dependencies. This replaces the overview's primary card dashboard and the relation list with an investigation canvas. Existing operations remain reachable.

## Research decision

| Primary reference                                                                                                                            | Finding used here                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OTel HTTP spans](https://opentelemetry.io/docs/specs/semconv/http/http-spans/)                                                              | Separate SERVER and CLIENT; one span per wire attempt when available; preserve resend count, status and error.type. Use route templates, never raw paths as dimensions.                   |
| [Google Dapper](https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/)                               | Propagated trace identity connects causal request trees; low overhead and sampling matter. The paper is historical, not a current Google product specification.                           |
| [Uber tracing](https://www.uber.com/blog/distributed-tracing/)                                                                               | Interoperable instrumentation, sampling control, duration scatter and trace minimaps aid investigation. This is the published historical architecture.                                    |
| [AWS retries](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)                                             | Downstream failure, intermediate API response and entry API response differ; retries can amplify overload. Observe attempts and customer outcome independently.                           |
| [AWS X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)                                                             | Downstream nodes inferred from caller-side spans are useful without claiming provider-side telemetry.                                                                                     |
| [Azure map](https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-map)                                                               | Request and dependency nodes connect a map to transaction investigation.                                                                                                                  |
| [Tempo graphs](https://grafana.com/docs/tempo/latest/metrics-from-traces/service_graphs/)                                                    | Pair CLIENT→SERVER once; distinguish observed counterpart from virtual/uninstrumented nodes. Missing counterpart can also result from sampling.                                           |
| [SigNoz external APIs](https://signoz.io/docs/external-api-monitoring/overview/)                                                             | Host/dependency drilldown and latency/failure comparisons deserve a dedicated workflow.                                                                                                   |
| [Collector gateway](https://opentelemetry.io/docs/collector/deploy/gateway/) and [scaling](https://opentelemetry.io/docs/collector/scaling/) | Resource dimensions, durable regional queues, trace-ID routing for stateful processors. Generate RED metrics before tail sampling; sampled traces are not whole-traffic SLO denominators. |
| [React Flow](https://reactflow.dev/learn/advanced-use/performance) and [layout](https://reactflow.dev/learn/layouting/layouting)             | Read-only, memoized nodes/edges, zoom/pan/keyboard navigation; ELK for deterministic layered layout. Use equivalent numeric tables.                                                       |

Six pinned GitHub repositories and read-file hashes are recorded in [source manifest](review/request-flow-upstreams.json). Collector and Jaeger sources are Apache-2.0; Tempo is AGPL-3.0; SigNoz has directory-specific licensing; React Flow is MIT; ELK is EPL-2.0. We use patterns, not copied upstream product code. Installed visualization packages retain their licenses.

## Responsibility and call flow

Application OTel SERVER + CLIENT instrumentation → regional Collector (resource identity, redaction, batching, persistent queue) → TelemetryStore → SQL deduplication/pairing/nearest and entry SERVER ancestry → request-flow API → shared time/resource context → topology, latency distribution, customer-impact evidence → existing trace/log/alert/incident workflows.

Incoming spans count observed API requests. Outgoing spans count observed attempts. A matched receiver does not add a second edge count. Source-side latency includes transport/client wait and differs from receiver duration. An external node's success describes our call, not that provider's complete availability. CLIENT 4xx is a dependency failure by default; SERVER 4xx remains separate from server errors. 429, timeout and resend are visible separately.

Never infer client identity from IP or trust arbitrary headers. A low-cardinality caller group is explicitly assigned by an authenticated gateway/application as `signaldesk.caller`; otherwise show unknown caller. Propagate W3C context only to configured trusted origins in the manual SDK example; no credentials, body, query string or baggage collection. Third parties need not support propagation for caller-side measurement.

## Visual direction

- Canvas `#eef3f8`, paper `#ffffff`, ink `#15324c`, call `#197b8d`, request `#315cc8`, failure `#c23f57`, unobserved `#78899d`.
- Manrope for navigation and English identifiers; system Korean sans-serif; tabular metrics. Body ≥14px.
- Main visual is a layered request map with full service names, region/module subtitles and clear direction. Keep the surrounding workspace quiet. No endlessly animated traffic or random force movement.
- Selecting an edge opens adjacent outcome, timeout/retry, paired coverage and evidence. Heatmap uses logarithmic duration bins with counts; empty buckets stay empty. Table and keyboard paths remain first-class.
- Keep scope in URL. Graph shows a disclosed bounded subset; searches/tables expose additional edges. Unknown, sampled and truncated states cannot look healthy.

## Acceptance plan

1. Pure SQL SQLite and PostgreSQL parity: paired dedup, nested ancestry, cross-region identity, retries versus recovered customer responses, empty/missing counterpart, 4xx/429/timeouts, retention/window bounds and large spans beyond old samples.
2. Local executable caller → two services → simulated third-party API; prove W3C propagation and source-only external measurement without secrets.
3. Fresh desktop/mobile browser: map selection, latency heatmap, trace drilldown, search, history, keyboard and no overflow/error.
4. Full existing check, containers/distributed acceptance, exact pushed head CI. Geographic HA, actual provider failures, real-client coverage and high-volume performance remain distinct operational gates.

## Work state

Research, original implementation, local HTTP example and SQLite/PostgreSQL correctness are completed. Container/distributed and exact-head CI verification are recorded separately in VERIFICATION.md. Fresh desktop/mobile visual acceptance was completed after the host became accessible; browser-discovered ELK worker initialization and heatmap/table DOM reuse failures were repaired, and duplicate route rows now disclose region/module/environment. This document is not a production-readiness or upstream-parity claim.

## AI application review

Existing AI workload telemetry and evidence briefing stay available. The new flow can supply bounded facts such as dependency timeout/retry growth, nearest SERVER outcomes, unobserved counterpart counts and exact trace links to an investigation assistant. These are useful inputs for a hypothesis, not sufficient evidence to declare root cause. Flow-specific AI inference is planned, not shipped. No new external model call or automatic remedial action was added. Parallel child durations need a real critical-path/interval model; simply adding them is misleading.
