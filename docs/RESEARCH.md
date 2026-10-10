# Research and decisions · 2026-10-09

> v0.3 follow-through (2026-10-10): R1–R7 are repaired and the service/notification/SLI/AI redesign is implemented within documented bounds. The report below preserves its original research-time findings. Current state: [redesign](REDESIGN.md), [verification](VERIFICATION.md), [roadmap](ROADMAP.md).

## Korean engineering practice review · 2026-10-10

[Daangn and Toss research](DAANGN_TOSS_RESEARCH.md) examines official monitoring, AlertDelivery, service ownership, multi-cluster, SLI, log-pipeline, service-relationship, UX and AI operations material. The report separates historical team-specific evidence from proposed SignalDesk requirements. Seven official presentation PDFs and six pinned GitHub repositories are tracked in the [source registry](research/company-sources.json). These are research additions; runtime changes and the seven open correctness findings are not resolved by this review.

## Product references

| Reference                                                                                                 | Applied pattern                                              | License boundary                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| [SigNoz](https://github.com/SigNoz/signoz)                                                                | analysis filters, results and correlated evidence drawer     | MIT core, enterprise folders separate  |
| [Grafana](https://github.com/grafana/grafana)                                                             | shared time context, chart drilldown, data-source boundaries | AGPL-3.0                               |
| [OpenObserve](https://github.com/openobserve/openobserve)                                                 | log search and explicit rule preview                         | AGPL-3.0                               |
| [Keep](https://github.com/keephq/keep)                                                                    | alert inbox and grouping into incidents                      | MIT outside enterprise                 |
| [OneUptime](https://github.com/OneUptime/oneuptime)                                                       | incident timeline and broad operations feature map           | Apache-2.0 outside enterprise          |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma)                                                    | clear freshness/status history                               | MIT                                    |
| [Alertmanager](https://github.com/prometheus/alertmanager)                                                | silences, routing and notification separation                | Apache-2.0                             |
| [Sentry](https://github.com/getsentry/sentry)                                                             | grouped errors with trace evidence                           | source-available FSL, not ordinary OSS |
| [Netdata](https://github.com/netdata/netdata)                                                             | readable host signal density                                 | agent GPL; UI has separate NCUL terms  |
| [Zabbix](https://github.com/zabbix/zabbix) / [Healthchecks](https://github.com/healthchecks/healthchecks) | infrastructure/no-data states and future batch heartbeat     | AGPL / BSD                             |

Reviewed official screenshots and repository UI source in the preceding research. No third-party UI source or screenshot is shipped as SignalDesk UI. Product recommendations are our interpretation, not endorsements.

## Visualization technology decision

| Option                                                                    | Evaluation                                                                                         | Decision                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Apache ECharts 6.1](https://echarts.apache.org/en/changelog.html)        | Canvas/SVG, time-series, zoom, heatmap, modular components, ARIA and data-view ecosystem           | Adopt modular line/bar/heatmap; lazy-load; bounded series; accessible numeric table        |
| [uPlot](https://github.com/leeoniya/uPlot)                                | small Canvas time-series library; vendor benchmarks are hardware-specific and not our measurements | Keep as future high-frequency specialization; not required for 5-second operations refresh |
| [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction) | headless virtualization permits dense log rows without mounting the full result                    | Adopt for logs, paired with server-side keyset paging                                      |
| [React Flow](https://reactflow.dev/learn/advanced-use/performance)        | interactive node graph, useful for editing/large topology, needs careful memoization               | Defer; small trace-derived topology can be readable SVG without another graph runtime      |
| [Recharts](https://recharts.org/)                                         | straightforward React SVG charts                                                                   | Considered; richer linked analysis and heatmap needs favor ECharts                         |

The registry and official changelog were checked live. ECharts 6.1.0 was released 2026-05-18. The deployed lockfile fixes exact versions. Selection prioritizes units, correlations, sampling limits and accessibility over animated novelty. Vendor performance claims are not platform performance evidence.

## AI observability vs AIOps

| Reference                                                                                                                 | Useful scope                                           | License checked                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| [Langfuse](https://github.com/langfuse/langfuse), [observability guide](https://langfuse.com/docs/observability/overview) | trace lineage, token/cost accounting, score provenance | MIT except enterprise folders                                       |
| [Opik](https://github.com/comet-ml/opik)                                                                                  | agent/tool spans, evaluation workflows and datasets    | Apache-2.0                                                          |
| [Phoenix](https://github.com/Arize-ai/phoenix)                                                                            | trace/evaluation investigation                         | current repo ELv2, source-available; do not label Apache/MIT        |
| [OTel GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)                                             | portable attributes and operations                     | conventions moved to a separate GenAI repository; evolving contract |

AI monitoring has two different responsibilities. **Observe AI services:** provider/model, tokens, latency, tool failures, explicit cost provenance and evaluations. SignalDesk implements these in spans and an AI workspace. Quality scores are supplied measurements with evaluator/source labels; missing scores stay unknown. Prompt/response/tool argument bodies are stripped on ingestion, not merely hidden in the browser.

**Use AI to operate services:** summarize evidence, propose testable hypotheses and link sources. This release implements a local deterministic evidence briefing, labelled as such. It does not call a model, claim a root cause or send incident data to an external AI provider. A future provider must require explicit opt-in, redaction, bounded evidence, model/prompt/version audit and source-linked hypotheses. It must not close incidents or remediate infrastructure autonomously. A model-generated confident paragraph is not root-cause evidence.

OTel interoperability is intentionally bounded: this release exposes a native JSON contract and an OTLP/HTTP JSON trace bridge, not protobuf or gRPC. Schema mapping is versioned locally rather than promising indefinite alignment with evolving GenAI conventions.

## Multiple deployments and platform replicas

[OpenTelemetry service resources](https://opentelemetry.io/docs/specs/semconv/resource/service/) and [cloud resources](https://opentelemetry.io/docs/specs/semconv/resource/cloud/) establish service instance and region/zone identities. Adopt the identity across metrics/logs/spans rather than placing region only in a UI label. Preserve Kubernetes cluster/namespace separately. Default alert grouping must isolate faulty replicas rather than hiding them in service averages.

[PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) provide session ownership; short transaction locks serialize control changes. Implemented connection-loss fencing was tested with real backend termination. This choice requires direct connections/session pooling and is not compatible with transaction pooling.

[Collector OTLP HTTP config at 0.162.0](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.162.0/exporter/otlphttpexporter/config.go) supplies explicit JSON encoding; current component metadata uses `otlp_http`. The default exporter sends gzip, so API decompression and expanded body limits were tested. [Fastify compression](https://github.com/fastify/fastify-compress) supports Fastify 5 request decompression independently of response compression.

[Collector file storage](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.162.0/extension/storage/filestorage/README.md) is beta at this release. Adopt as a pinned regional trace queue reference with persistent writable volume and recovery acceptance, not a zero-loss guarantee. Native logs/metrics still need a durable ingestion path. See [the actual topology and volume limits](MULTI_REGION.md).
