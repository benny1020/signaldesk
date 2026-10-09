# Roadmap and acceptance gates

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

No external remediation, production failover or high-volume certification is inferred from local acceptance. See [multi-region responsibilities](MULTI_REGION.md).
