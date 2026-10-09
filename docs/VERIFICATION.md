# Verification record

Executed 2026-10-09 for v0.2. Local acceptance establishes these conditions, not a geographically distributed production certification.

| Check                                      | Observed result                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting / TypeScript / production build | Passed locally on Node 26.4.0; exact dependencies and lockfile                                                                                                                                                                                                                    |
| Local automated suite                      | 28 tests passed, zero skipped: resource isolation, weighted aggregates, independent duration/recovery/no-data, retirement/resume, historical latest values, cardinality rollback, strict identity, gzip expanded limit, original auth/privacy/outbox/paging/persistence/SDK tests |
| Real PostgreSQL integration                | Parent + three subtests passed (four reported): atomic duplicate/history/capacity across pools, competing evaluators and multiple-rule isolation, concurrent acknowledgment/notes, session lock exclusion and backend termination fencing                                         |
| Four application processes                 | API 2 + worker 2 on shared PostgreSQL: 4 resources across 2 region labels and 2 modules, identical Pod names isolated, global error 0.8% while the affected resource's 8% fired independently                                                                                     |
| Shared execution recovery                  | Worker A killed, surviving worker processed the new alert; incident notes from both APIs persisted through API restart; retirement stopped the active resource alert                                                                                                              |
| Load balancer                              | Real Nginx with repository config accepted ingestion; a gateway read succeeded after API A stopped, using remaining API B                                                                                                                                                         |
| Regional Collector                         | Official contrib 0.162.0 image validated config and exported real JSON/gzip; a trace accepted during API outage survived Collector restart on the same persistent volume, replayed once and preserved region/cluster/instance                                                     |
| SQLite container                           | Node v24.21.0: unauthorized access denied, six demo services, Live alert firing/recovery and incident note persistence after restart                                                                                                                                              |
| Deployment configuration                   | Shared Compose validated with generated temporary credentials; two APIs/two workers share PostgreSQL and separate roles                                                                                                                                                           |
| Browser, 1280×720                          | 3 regions / 45 resources visible; region+checkout filter yielded two replicas; retirement/resume preserved history; instance-to-log drilldown preserved all resource fields                                                                                                       |
| Cross-region request                       | Demo error → trace showed four spans across two regions, including payment child; exact trace API isolation also tested                                                                                                                                                           |
| Visualization                              | Regional graph/numeric-table switching worked; three readable region series, explicit request units and maximum-instance p95; screenshots use Demo only                                                                                                                           |
| Worker UI                                  | Live connection screen displayed individual worker identities, current heartbeat and stale previous-process records                                                                                                                                                               |
| Mobile, 390×844                            | Six resource filters wrapped without document overflow; deployment tables scroll locally (340px container, 500/1030px content); navigation labels remain accessible; viewport restored                                                                                            |
| Browser console                            | Fresh verification tab returned no warning/error entries during chart/view/navigation checks                                                                                                                                                                                      |
| Dependency audit                           | Zero reported vulnerabilities at audit time                                                                                                                                                                                                                                       |

The authenticated SQLite smoke, real PostgreSQL tests, Nginx and Collector outage acceptance run in GitHub Actions. The v0.2 run is linked from the repository's [CI history](https://github.com/benny1020/signaldesk/actions/workflows/ci.yml); confirm the commit shown by the run. Earlier v0.1 checks are historical, not evidence of shared execution.

## Reproduction

```bash
npm ci
npm run check
npm audit --audit-level=high
docker build -t signaldesk:local .
node scripts/container-smoke.mjs signaldesk:local
npm run test:distributed
```

Distributed acceptance creates its own database, network, application/Collector/Nginx containers, queue volume and temporary credentials, then removes them. Manual browser checks are documented acceptance, not a committed browser automation suite. No real webhook destination or external LLM provider is configured.

## Bounded local query measurement

`npx tsx scripts/benchmark.ts` inserted 100,000 fixture events into in-memory SQLite: 60,000 metrics, 30,000 logs, 10,000 spans. Twenty capped dashboard queries on Node 26.4.0 reported median **17.66 ms**, p95 **19.17 ms**, fixture insertion **2,180 ms** during v0.2 verification. This fixture has low resource cardinality; it excludes disk I/O, HTTP, PostgreSQL/WAN, concurrent ingest and browser rendering. It is not an ingestion throughput or production latency guarantee.

Final production bundles: app about 138 kB gzip, lazy ECharts chunk about 203 kB gzip, CSS about 12 kB gzip. Fonts are local assets. These are compressed artifact sizes, not render measurements.

## Unperformed boundaries

No existing production server was instrumented, no external deployment provisioned, no actual geographic WAN outage or managed PostgreSQL primary failover/PITR rehearsed. No native external alert delivery, SSO, full OTLP protobuf/gRPC/log/metric transport or high-volume certification. Model-generated root-cause diagnosis and automatic remediation remain unimplemented. Native metric/log SDK retry is in memory; only the tested Collector trace path has a persistent queue.

Synthetic checks report `probe_duration_ms`, never a population p95. Observed trace success/AI cost remain capped evidence rather than complete traffic/SLO or financial accounting. See [production gates](MULTI_REGION.md#production-acceptance-gates).

## 2026-10-09 review counterexamples

The [OSS comparison review](OSS_COMPARISON_REVIEW.md) inspected eight pinned repositories and 33 selected source/license files, public UX references and the actual SignalDesk desktop UI. The exact base `fbfbdeec79417d4d9ab5759f9a7b9c5042920c0d` CI run [37878061092](https://github.com/benny1020/signaldesk/actions/runs/37878061092) was rechecked as successful.

Seven open findings were identified: incomplete long-window heatmaps; cross-region child service context loss; trace-only host-labelled services missing from the service list; shared gateway IP quotas including health; log filter/history mismatch; child-only traces hidden; and cross-service error grouping. The first, second and fifth were reproduced in the browser; the third, fourth and sixth use actual isolated server functions; the seventh uses source algorithm replay. See [reproduction evidence](review/reproduction-evidence.json) and [source manifest](review/upstream-sources.json).

These cases are not covered by the existing acceptance claims and have not been repaired in this review. No production telemetry was reset and no external alert/model was called. The existing mobile screenshot was inspected, but the current browser viewport override returned 1280px after a requested 390px, so a fresh mobile acceptance is unperformed. Upstream deployments, comparative load benchmarks and new production failover exercises were not run.
