# Verification record

Executed 2026-10-09. This record distinguishes observed acceptance from future production guarantees.

| Check                                      | Observed result                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formatting / TypeScript / production build | Passed locally with Node 26.4.0; dependency versions fixed in lockfile                                                                                                               |
| Automated integration suite                | 16 tests passed: ingestion, privacy, auth/scope, duration/no-data/recovery, outbox, cursor, persistence, async adapter, exact trace, OTLP JSON and producer queue                    |
| Dependency audit                           | 0 reported vulnerabilities at verification time                                                                                                                                      |
| Browser errors                             | Numeric-view switching exposed a React/ECharts DOM reuse issue. Distinct container keys fixed it; repeated graph/table switching in a fresh tab produced no error/warning entries.   |
| Correlated navigation                      | Overview → checkout service → scoped logs → exact trace; 4 spans and DB failure waterfall observed                                                                                   |
| Alert actions                              | Acknowledgment persisted independently of firing state; 30-minute snooze exposed its own expiry                                                                                      |
| Rule                                       | Preview showed 96 samples / 26 threshold violations; create reflected in rules table                                                                                                 |
| Incident                                   | Investigation note and status change reflected in persisted timeline                                                                                                                 |
| Live ingestion                             | Sample producer accepted 5 server/API events and 1 AI span; missing AI cost remained null                                                                                            |
| Real local signals                         | Local host appeared with actual measurements; self-instrumented API spans appeared in Live                                                                                           |
| Mobile                                     | 390×844 viewport rendered dashboard with no document horizontal overflow; charts and pause/resume worked; viewport override reset                                                    |
| Outbound HTTPS                             | Read-only request to example.com returned 200 using the pinned DNS sender; no real webhook destination was configured                                                                |
| Container build                            | Node 24 official image build passed; Docker Desktop credential helper initially hung, recovered with task-scoped anonymous public-registry configuration                             |
| Container runtime / restart                | Passed with Node v24.21.0: unauthorized read denied, six demo services, Live alert fired/recovered, incident note survived restart. Temporary container/volume removed.              |
| GitHub CI                                  | [Implementation CI](https://github.com/benny1020/signaldesk/actions/runs/37808761107) passed verify and container jobs; final metric-semantics update is revalidated in the next run |

## Local bounded query measurement

`npx tsx scripts/benchmark.ts` seeded 100,000 events into an in-memory SQLite store: 60,000 metrics, 30,000 logs and 10,000 spans. Twenty dashboard iterations used the actual capped query/aggregation code. Node 26.4.0 on the development host reported median **11.79 ms**, p95 **17.07 ms**, fixture insertion **422 ms**. This excludes disk I/O, HTTP, remote storage, browser rendering and concurrent ingestion. It is not a production throughput/latency guarantee. Re-run on intended hardware and workloads.

Production web bundles at the verification build: application approximately 135 kB gzip, lazy chart chunk approximately 203 kB gzip, stylesheet approximately 11 kB gzip. Font assets are bundled locally. These are build artifacts, not an end-user render benchmark.

## Unperformed boundaries

No existing production server was instrumented; no external deployment, real alert channel, real AI provider, distributed failover, SSO, full OTLP protobuf/gRPC or production load certification was exercised. Browser checks are recorded manual acceptance, not a committed browser automation suite. Model-generated root-cause diagnosis is not implemented.

Synthetic checks record `probe_duration_ms`; a single probe is never labelled as a population p95. A regression test covers non-2xx responses with measured duration.
