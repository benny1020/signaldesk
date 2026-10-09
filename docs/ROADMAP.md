# Roadmap and acceptance gates

The [2026-10-09 comparison review](OSS_COMPARISON_REVIEW.md) leaves seven findings open. Implemented stages below describe the delivered baseline, not feature parity or production certification. Correctness repairs take precedence over additional features.

| Stage                            | State                 | Acceptance / next gate                                                                                         |
| -------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| v0.1 local baseline              | Implemented           | Native telemetry, correlated UI, alerts/incidents, AI evidence                                                 |
| v0.2 multi-deployment            | Implemented           | Full resource identity, regional comparison, scoped drilldown, independent alert groups and retirement         |
| v0.2 shared execution            | Implemented           | PostgreSQL, split API/worker roles, session task locks, concurrency and worker-loss tests                      |
| Regional trace queue             | Implemented reference | Real pinned Collector JSON/gzip + persisted queue replay after outage/restart                                  |
| Production regional availability | Deployment exercise   | Managed DB failover/PITR, WAN partitions, actual ingress recovery, load/volume budgets                         |
| High-volume telemetry            | Planned               | ClickHouse/Prometheus/Loki/Tempo adapters, rollups/partitions, real engine conformance and measured throughput |
| Service lifecycle/ingestion      | Partial               | Auto discovery/retirement, durable native log/metric path, full OTLP protobuf/metrics/logs and gRPC            |
| Operations integrations          | Planned               | Native Slack/Telegram/PagerDuty payloads, escalation/on-call/status pages, real delivery receipts              |
| AI assistance                    | Planned               | Opt-in provider, sanitized evidence, model/version audit, source-linked hypotheses and evaluation corpus       |
| AI quality                       | Partial               | Supplied evaluation provenance implemented; evaluation runners/datasets/budget workflows planned               |
| Enterprise access                | Planned               | SSO, org/project membership, managed tokens, independent role review                                           |

| Review-driven next stage  | State   | Acceptance / next gate                                                                                                                                     |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1–R7 correctness         | Open    | Full-window heatmap, cross-region drilldown scope, host/service discovery, proxy/health quotas, URL back/forward, partial traces and error identity        |
| Investigation UX          | Planned | Absolute time/timezone, URL selection, searchable facets, saved views, log histogram/context, configurable tables, trace search/sort and endpoint analysis |
| Chart investigation       | Partial | Shared cursor/window, missing-data gaps, deployment/alert annotations, accessible zoom controls and chart data export                                      |
| Notification operations   | Partial | Rule edit/version and group state; label routing, maintenance/inhibition, recovery/repeat delivery, real on-call escalation                                |
| SLO and server aggregates | Planned | Traffic-based SLI, histogram aggregation, budget/burn-rate and backend-wide aggregates rather than capped client samples                                   |
| AI evaluation operations  | Planned | Multiple versioned scores, dataset/experiment baseline, evaluation coverage and privacy-compatible runners                                                 |

No external remediation, production failover or high-volume certification is inferred from local acceptance. See [multi-region responsibilities](MULTI_REGION.md).
