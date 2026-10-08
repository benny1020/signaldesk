# Product brief

SignalDesk connects server and API telemetry to the operational decisions made during an incident. Primary users: engineers and small operations teams running services, with optional AI workloads. The default local runtime is a complete single-node workspace, not a distributed time-series database.

## Journeys and acceptance

1. Overview → unhealthy service → correlated logs → trace waterfall → create incident, preserving environment, service and time in the URL.
2. Ingest real telemetry → threshold rule pending/firing → acknowledge or snooze → notification delivery history → metric recovers → resolved alert.
3. Incident → inspect evidence → assign owner, change status, add timeline note → persisted audit history.
4. AI workload → latency, token usage, reported cost and score provenance → original trace. Missing cost and evaluations remain unknown.
5. Fresh installation → demo clearly identified → switch to live → real local host/API data → integration instructions for external services.

## Information architecture

Overview, Services & APIs, Infrastructure, Logs, Traces, Alerts, Incidents, Analytics, AI workloads, Connections. Alerts includes rules and delivery history. Connections includes token setup and ingest health.

## Scope

Implemented baseline: native JSON telemetry API, local host/API collector, SQLite persistence, scope-aware queries, duration/no-data alert evaluator, persisted notification outbox, HTTPS webhook delivery with bounded retries, HTTPS synthetic checks, incident timeline, role tokens, bounded queries, retention, evidence summaries, AI span ingestion with content stripping.

Later: distributed storage adapters, full OTLP protobuf/gRPC interoperability, on-call rotations, bidirectional external incident systems, autonomous remediation, model-driven diagnosis, evaluation runners. These must not be shown as connected or successful in the UI.

## Design tokens and review

Color: Ink #12283f, Canvas #f3f6fa, Surface #ffffff, Ocean #2869d8, Teal #087f8c, Fault #c84646, Warning #a96a12. Color encodes state; icons and words repeat the meaning.

Type: bundled Manrope for product text, system Korean sans fallback, system monospace only for trace IDs/log content. 13px table/body, 22px page heading, 30px key measurement. Layout: 216px navigation, shared context bar, charts paired with actionable service rows, right-side evidence drawer. Compact tables keep comparisons aligned. Charts are not decorative card backgrounds.

```
navigation | workspace / environment / service / time / pause
           | current incident strip
           | request and latency chart | service health rows
           | error chart               | infrastructure
           | recent events            | actionable alerts
```

Review against brief: use a light reading canvas and muted navy navigation for long operations sessions; avoid a glowing sci-fi dashboard. Reserve blue for selection/actions and multiple distinct series colors for signals. Charts expose units, time and a table fallback. Responsive layout, keyboard focus, reduced motion, meaningful empty/error states are required.
