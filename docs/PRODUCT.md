# Product brief

SignalDesk connects server and API telemetry to the operational decisions made during an incident. Primary users: engineers and small operations teams running services, with optional AI workloads. Local SQLite supports evaluation; shared PostgreSQL supports multiple API/worker processes. Managed regional infrastructure and high-volume time-series storage remain separate deployment responsibilities.

## Journeys and acceptance

1. Overview → unhealthy service → correlated logs → trace waterfall → create incident, preserving environment, service and time in the URL.
2. Ingest real telemetry → threshold rule pending/firing → acknowledge or snooze → notification delivery history → metric recovers → resolved alert.
3. Incident → inspect evidence → assign owner, change status, add timeline note → persisted audit history.
4. AI workload → latency, token usage, reported cost and score provenance → original trace. Missing cost and evaluations remain unknown.
5. Region comparison → module/instance → scoped logs → cross-region exact trace, keeping filters in URL. Explicitly retire drained resources without deleting history.
6. Fresh installation → demo clearly identified → switch to live → real local host/API data → integration instructions for external services.

## Information architecture

Overview, Deployments & instances, Services & APIs, Infrastructure, Logs, Traces, Alerts, Incidents, Analytics, AI workloads, Connections. Alerts includes rules and delivery history. Connections includes token setup and ingest health.

## Scope

Implemented baseline: native JSON telemetry API, local host/API collector, SQLite/PostgreSQL persistence, full deployment-scoped queries, resource/region/service group duration/no-data evaluator, persisted notification outbox, HTTPS webhook delivery with bounded retries, HTTPS synthetic checks, incident timeline, role tokens, bounded queries, retention, evidence summaries, AI span ingestion with content stripping.

Later: columnar/time-series adapters, managed DB/geographic failover certification, automatic deployment discovery, full OTLP protobuf/gRPC interoperability, on-call rotations, bidirectional external incident systems, autonomous remediation, production-certified model diagnosis and semantic evaluation runners. Configured evidence-gateway diagnosis and deterministic structured evaluation are delivered in v0.3. These must not be shown as connected or successful in the UI.

## Design tokens and review

Color: Ink #12283f, Canvas #f3f6fa, Surface #ffffff, Ocean #2869d8, Teal #087f8c, Fault #c84646, Warning #a96a12. Color encodes state; icons and words repeat the meaning.

Type: bundled Manrope for product text, system Korean sans fallback, system monospace only for trace IDs/log content. 14px table/body, 22px page heading, 30px key measurement. Layout: 216px navigation, shared context bar, charts paired with actionable service rows, right-side evidence drawer. Compact tables keep comparisons aligned. Charts are not decorative card backgrounds.

```
navigation | workspace / environment / service / time / pause
           | current incident strip
           | request and latency chart | service health rows
           | error chart               | infrastructure
           | recent events            | actionable alerts
```

Review against brief: use a light reading canvas and muted navy navigation for long operations sessions; avoid a glowing sci-fi dashboard. Reserve blue for selection/actions and multiple distinct series colors for signals. Charts expose units, time and a table fallback. Responsive layout, keyboard focus, reduced motion, meaningful empty/error states are required.

## Multi-deployment visual semantics

The shared deployment bar keeps region visible and collapses module/cluster/namespace/zone/instance until needed. Facets respect other active selectors. Regional rows align request rate, weighted errors, worst-instance p95 and stale-resource counts; the inventory identifies equal Pod names by full tuple. Resource drilldown preserves all dimensions. Exact trace opens the whole request across regions, while logs remain scoped. Missing identities are labelled unknown. Worker health shows each platform process separately from application instances.

## v0.3 investigation contracts

Operators can identify a service owner/runbook, compare API failure groups, open correlated log/trace evidence, switch to the exact child resource, manage delivery policy and minimum-coverage SLOs, and evaluate candidate AI versions. Absolute UTC bounds and KST/UTC display are separate; detail URLs freeze their time window. Saved views persist locally and do not include the token. Sidebar scrolls to the active menu; long tables scroll inside their panels on narrow screens.

AI version summaries and candidate evaluation are primary. Individual token/call evidence is revealed on demand rather than duplicating an uncapped-looking summary. External analysis is a configured explicit opt-in operation; local facts, supporting/counter/missing evidence and next checks remain the default. Relationships show observed edges and equivalent tables; an absent edge is unknown, not proof of no dependency.

[Redesign](REDESIGN.md) and [verification](VERIFICATION.md) track implemented acceptance. Browser checks establish task behavior under Demo fixtures; real operators and measured completion time/error rates remain a product gate.

## v0.4 request investigation

The default workspace follows caller → our API → internal/external dependency. Selecting a connection answers: how many attempts were observed, how slow were they, what failed or was throttled/timed out, were both sides instrumented, and what did the nearest parent API return? A latency distribution and ranked trace evidence lead into existing log/trace/alert/incident actions. Dependencies without counterpart telemetry are visually distinct and have no asserted provider-wide health. Service grouping and region expansion preserve the underlying route/regional numbers.

A dependency rule starts from the selected outgoing connection, with minimum observations, revision, status freshness and existing notification lifecycle. The numeric connection list is a parallel investigation path. Graph caps, sample limits, missing data and maximum-route p95 labels are visible. Fresh desktop/mobile usability and accessibility acceptance is pending host unlock; implementation and automated backend correctness do not prove visual acceptance.
