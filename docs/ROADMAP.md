# Roadmap and acceptance gates

| Stage                   | Work                                                                                          | Gate                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| v0.1 baseline           | Native events, local store, correlated UI, operational alerts/incidents, AI workload evidence | Unit/integration/browser/container acceptance; scope and implemented-state documentation                  |
| Remote telemetry        | Prometheus query adapter, Loki log adapter, Tempo trace adapter or ClickHouse store           | Real engine fixture tests, scope/time/paging/idempotency and metric semantics; no fake connected badges   |
| Service ingestion       | Collector deployments, full OTLP protobuf/metrics/logs, host agent, rate/cardinality guards   | Real SDK/exporter interoperability and restart/backpressure tests                                         |
| Operations integrations | Native Slack/Telegram/PagerDuty adapters, escalation, on-call schedule, status pages          | Delivered vs acknowledged/resolved semantics, retry receipts, consent and destination tests               |
| Availability            | Shared control DB, scheduler leases, external queue, distributed query and migrations         | Duplicate-worker fault tests, backup/restore, rolling upgrade and failover exercises                      |
| AI assistance           | Opt-in provider, sanitized evidence bundles, source-linked hypotheses and model/version audit | No invented evidence, no automatic close/remediation, user-approved external data flow, evaluation corpus |
| AI quality              | Evaluation ingestion integrations, dataset/version comparison, drift and cost budgets         | Provenance, known population coverage, trusted pricing versions and human/model score separation          |
| Enterprise access       | SSO, org/project membership, managed tokens and audit retention                               | Independent role/tenant review and real integration tests                                                 |

Feature stages describe planned work. Dates and large-scale performance guarantees are intentionally not invented.
