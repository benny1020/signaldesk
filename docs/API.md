# API reference

Version 0.3. Native contract: `packages/contracts/src/index.ts`. Content-Type: `application/json`. No CORS is enabled; serve the UI and API from the same origin. In local mode loopback Host and Origin are enforced. In token mode use an Authorization bearer token.

## Scope and roles

Queries use `workspace=demo|live`, optional `environment`, `service`, `module`, `region`, `zone`, `cluster`, `namespace`, `instanceId`, `from`, `to` (Unix ms) and `rangeMinutes` (default 60). Ranges are ordered and at most seven days. Demo defaults to its fixed fixture clock; Live defaults to current time. Rules and incidents are control records and are filtered by service/environment/deployment identity, not hidden just because their creation time is outside a chart window.

| Role   | Scope                                                           |
| ------ | --------------------------------------------------------------- |
| admin  | Read, ingestion and control mutations within allowed workspaces |
| viewer | Read within allowed workspaces; no ingestion or mutations       |
| ingest | Ingestion only, within allowed workspaces                       |

Local mode is equivalent to a local operator and is never allowed on a non-loopback bind.

## Endpoints

| Method       | Path                        | Behavior / role                                                                                                                    |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET          | `/health`                   | Unauthenticated process + database health                                                                                          |
| GET          | `/api/bootstrap`            | Runtime mode, demo clock, capability flags / read                                                                                  |
| GET          | `/api/dashboard`            | Bounded correlated service/host/chart/AI view / read                                                                               |
| GET / PATCH  | `/api/resources[/:id]`      | Scoped inventory / explicit `{retired:boolean}` lifecycle, read / admin                                                            |
| POST         | `/api/ingest`               | Atomic native events / ingest                                                                                                      |
| POST         | `/api/v1/traces`            | Bounded OTLP HTTP JSON trace bridge / ingest                                                                                       |
| GET          | `/api/logs`                 | Message `search`, `level`, `limit`, keyset `cursor` / read                                                                         |
| GET          | `/api/spans`                | Paged spans / read                                                                                                                 |
| GET          | `/api/traces/:traceId`      | Indexed exact trace, expands service/deployment filters to include cross-region children; honors workspace/environment/time / read |
| GET          | `/api/export`               | JSON log page, max 10,000, truncation flag / read                                                                                  |
| GET          | `/api/briefing`             | Deterministic evidence summary and hypotheses / read                                                                               |
| POST         | `/api/rules/preview`        | Latest resource/region/service group threshold comparison / read                                                                   |
| POST / PATCH | `/api/rules[/:id]`          | Create/update scoped rule / admin                                                                                                  |
| PATCH        | `/api/alerts/:id`           | `acknowledged`, `snoozeMinutes` 0–1440 / admin                                                                                     |
| POST / PATCH | `/api/incidents[/:id]`      | Create, status/owner/note changes / admin                                                                                          |
| GET          | `/api/connections`          | Health, channel metadata, probes, last 100 deliveries/audit / read                                                                 |
| POST / PATCH | `/api/channels[/:id]`       | Create HTTPS destination, toggle enabled; Live only / admin                                                                        |
| POST / PATCH | `/api/probes[/:id]`         | Create HTTPS GET check, toggle enabled; Live only / admin                                                                          |
| POST         | `/api/deliveries/:id/retry` | Reset failed delivery attempt budget / admin                                                                                       |

Lists return `{items,nextCursor,truncated}` for telemetry. Cursor order is timestamp and event ID descending. Treat cursors as opaque. HTTP 400 indicates invalid input, 401 missing/invalid token, 403 scope/role denial, 404 missing item, 429 rate limit and 507 storage/cardinality capacity, 503 operational database/worker availability errors. The API has a 1 MiB expanded request body limit (gzip supported) and a default 240 requests/minute per client IP. `/health` bypasses the application quota. Set `TRUSTED_PROXIES` to exact trusted ingress addresses; forwarded headers are ignored by default.

## Events

Common resource fields: optional `module`, `region`, `zone`, `cluster`, `namespace`, `instanceId` (each 1–128 characters), and `host`. All event kinds support them. Missing legacy fields normalize to `unknown`; instanceId falls back to host. `REQUIRE_RESOURCE_IDENTITY=true` rejects incomplete module/region/instance identities atomically. Resource selectors are exact-match.

Other common fields: optional stable `id` (max 128), `timestamp`, nonempty `service`, `environment` (defaults production). Unknown object keys are stripped; message attributes have scalar values. Producer IDs deduplicate within a workspace. Do not reuse an ID for a different event.

```json
{
  "kind": "metric",
  "timestamp": 1791475200000,
  "service": "orders-api",
  "environment": "production",
  "module": "api",
  "region": "ap-northeast-2",
  "cluster": "commerce-prod",
  "namespace": "orders",
  "instanceId": "orders-pod-1",
  "name": "error_pct",
  "value": 0.4
}
```

Metric names: `request_rate` (req/s), `error_pct` (%), `latency_p95_ms` (ms), `cpu_pct` (%), `memory_pct` (%), `probe_up` (0/1), `probe_duration_ms` (one synthetic request duration, not p95), `ai_cost_usd` (USD measurement supplied by producer). Built-in operational values are finite/nonnegative; percentages are ≤100. Custom metric names match `^[a-zA-Z_:][a-zA-Z0-9_.:]*$` and accept finite signed gauges. Monotonic counters are nonnegative. Include `host` for host resource metrics. Operational rates and p95 remain producer-calculated gauges. Custom metrics may include `metricType`, `unit`, `temporality`, `startTimestamp` and `histogram:{count,sum,bounds,bucketCounts}`. Bounds are strictly ordered and bucket counts must sum to count. Distribution metadata is retained; the platform does not merge it into a population p95. Do not send a cumulative count under `request_rate`.

```json
{
  "kind": "log",
  "timestamp": 1791475200000,
  "service": "orders-api",
  "level": "error",
  "message": "Pool acquire timeout",
  "traceId": "trace-01",
  "attributes": { "http.route": "/orders" }
}
```

Log levels: debug/info/warn/error. Messages up to 4,000 characters; attribute strings up to 2,000. Credential patterns are redacted. Arbitrary private text must be redacted by the producer.

```json
{
  "kind": "span",
  "timestamp": 1791475200000,
  "service": "ai-service",
  "environment": "production",
  "traceId": "trace-01",
  "spanId": "span-01",
  "name": "chat completion",
  "durationMs": 1400,
  "status": "ok",
  "attributes": {},
  "ai": {
    "provider": "example",
    "model": "example-model",
    "inputTokens": 800,
    "outputTokens": 200,
    "ttftMs": 260,
    "costUsd": 0.001,
    "costSource": "producer rate card v1",
    "evaluation": { "name": "schema-valid", "score": 1, "source": "rule", "evaluator": "schema-v1" }
  }
}
```

Span status is ok/error; parentSpanId links children within the trace. Cost requires a nonempty provenance string; no provider prices are inferred. Evaluation score is 0–1 with human/rule/model source and named evaluator. Prompt/message/tool-argument attributes are removed before storage. AI input/output token values are required in the native AI object; omit AI until measured rather than guessing zeros.

## OTLP HTTP JSON trace subset

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [{ "key": "service.name", "value": { "stringValue": "orders-api" } }]
      },
      "scopeSpans": [
        {
          "spans": [
            {
              "traceId": "trace-01",
              "spanId": "span-01",
              "name": "GET /orders",
              "startTimeUnixNano": "1791475200000000000",
              "endTimeUnixNano": "1791475200025000000",
              "status": { "code": 1 },
              "attributes": []
            }
          ]
        }
      ]
    }
  ]
}
```

Resource `service.name` and `deployment.environment.name` map to service/environment. `service.namespace` maps to module (`signaldesk.module` overrides); `cloud.region`, `cloud.availability_zone`, `k8s.cluster.name`, `k8s.namespace.name`, `service.instance.id` (fallback `k8s.pod.uid`) and `host.id`/`host.name` preserve deployment identity. The Collector reference explicitly sets JSON export and was tested with real gzip delivery; default protobuf is not supported. Nanosecond strings map to millisecond timestamps and duration. Scalar attributes are supported; content bodies are stripped. Error status code 2 maps to error. `gen_ai.provider.name`, request.model and usage.input_tokens/output_tokens map to AI fields only when both measured token attributes exist. Otherwise the span remains a normal span with model metadata attributes. Up to 1,000 spans in one request after flattening. This is not a full OTel collector/exporter.

## Rules

```json
{
  "name": "Orders errors >2%",
  "service": "orders-api",
  "environment": "production",
  "metric": "error_pct",
  "operator": "gt",
  "threshold": 2,
  "durationSec": 60,
  "severity": "critical",
  "noData": "alert",
  "enabled": true,
  "groupBy": "resource"
}
```

Worker checks every 5 seconds. `groupBy` is `resource` (default), `region`, or `service`; rules can narrow deployment fields. It selects latest gauges per matching identity within two minutes, with independent durable pending/firing/recovery per group. Region/service request rates sum; error percentage requires same-resource request weights; latency/CPU/memory/probe duration use maximum, and probe_up uses minimum. Maximum p95 is not population p95. Missing aggregate weights produce no-data. Retired resources are excluded; absent known active resources remain expected and can trigger no-data. Empty new scopes use an unknown placeholder until resources appear.

Sustained violation holds group pendingSince. Clearing resolves that group's active alert; disabling resolves all its active groups. Editing a rule resets pending duration through configuration revision. No-data is explicit rather than zero. Query bounds cause evaluator failure rather than treating partial input as complete. Demo rules are editable samples but only Live rules are background-evaluated.

`/api/rules/preview` returns `samples` (history points), `groupCount`, `violations` (currently violating groups), `noDataGroups` and `latest` (maximum current group value). This is a latest-snapshot preview, not historical duration simulation. Dashboard alert/incident state is current control state alongside the selected chart window. Inventory is known identities first observed before window end, not just resources reporting inside the window.

## Incident and notification semantics

Create incident: title, service, environment, optional deployment identity, severity, owner and optional scoped alertId and alertIds (up to 100). Patch: investigating/identified/monitoring/resolved status, owner, linked alertIds and/or note. Timeline entries record actor/time. An incident is not automatically closed when its alert recovers.

The generic webhook body includes `source`, `deliveryId`, `event` (`firing|repeat|recovery`), `alert`, owner and absolute investigation context. See notification policies below. New Live alert creation and outbox insertion are one control transaction. Pending delivery may be deferred by snooze or cancelled on recovery/channel disable. HTTP 2xx succeeds; redirects do not. Failures retry with bounded exponential delay, five attempts total. Crash after remote success can redeliver: deduplicate deliveryId. Acknowledge is independent from delivery and incident state.

## v0.3 investigation and operations

| Method             | Path                               | Contract                                                                                                                                     |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                | `/api/events/log/:id`              | Exact log ID within workspace, environment, time and resource scope; read                                                                    |
| GET                | `/api/analysis/:kind`              | `logBuckets`, `errorGroups`, `apis`, `relations`, `ai`, `metricSeries`, `traces`; retained SQL, up to 1,000 groups; read                     |
| GET                | `/api/catalog`                     | Catalog services, teams, owner and unowned observed names; read                                                                              |
| GET / POST / PATCH | `/api/teams[/:id]`                 | Team name/contact; writes admin                                                                                                              |
| GET / POST / PATCH | `/api/catalog/services[/:id]`      | Name/aliases/teamId/repository/runbook/criticality/regions/description; writes admin                                                         |
| GET / POST / PATCH | `/api/notification-routes[/:id]`   | Service/team/environment/severity/resource match, channelIds, repeatMinutes, notifyRecovery, enabled; writes admin                           |
| POST               | `/api/notification-routes/preview` | `{alertId,at?}` returns owner, matchedRouteIds, selected channelIds, suppressedBy; current time unless at is supplied; read, no transmission |
| GET / POST / PATCH | `/api/maintenance[/:id]`           | Name, service/environment/resource scope, ordered `from`/`to` ≤7 days, reason; writes admin, actor recorded                                  |
| GET / POST / PATCH | `/api/slos[/:id]`                  | Shared success/latency objective and resource/route scope; writes admin                                                                      |
| GET                | `/api/slos/status`                 | Full observed server-span denominator, bad count, success, budget remaining, burn rate and insufficient-data state; read                     |
| GET / POST / PATCH | `/api/evaluation/datasets[/:id]`   | Named version, ≤500 unique-ID cases with scalar expected/actual fields; writes admin                                                         |
| GET / POST         | `/api/evaluation/runs`             | Dataset, model/prompt versions, baseline ID and optional candidate `actuals`; run/persist admin                                              |
| POST               | `/api/diagnosis`                   | `{external:false}` local read, `{external:true}` explicit admin request + configured gateway; bounded evidence only                          |
| POST               | `/api/v1/logs`, `/api/v1/metrics`  | OTLP HTTP JSON subsets, gzip, ingest role                                                                                                    |

Control PATCH requests contain the **complete definition**; responses preserve ID/createdAt and increment revision. Up to 1,000 of each new entity kind per workspace. Catalog links allow HTTP(S) only; team/channel references must exist within the workspace. Entity revisions and audit are stored; full historical definition snapshots are not provided.

`route` narrows API/trace/SLI server-span lookup using `http.route` (fallback span name). Trace groups include child-only partial traces, with root_count and explicit truncation. Analysis is over retained telemetry; sampled traces cannot prove a whole-traffic denominator. API latency is average/max, not an invented percentile. Error groups include service/environment/exception/code/exact message; digits are never blindly erased.

### Notifications

If no policy exists, legacy enabled-channel broadcast remains. Once any policy exists, only enabled matching routes select destinations; disabling all routes stops delivery. Maintenance suppresses transmission, not alert detection. Recipient policy is rechecked before sending. ACK stops repeats, snooze defers firing/repeats, recovery is separate, and incident resolution is independent. `snoozeReason`, actor and expiry are recorded by alert PATCH. Receivers deduplicate `deliveryId` because remote delivery remains at-least-once. Demo receipts are always cancelled before network transmission.

### SLO

Example: `{name:"Orders availability",service:"orders",environment:"production",objective:99.9,indicator:"availability",windowMinutes:60,minimumRequests:100,alertBurnRate:2,enabled:true}`. Optional route and all resource fields select the denominator. `indicator:"latency"` uses `latencyMs`. Shared SQL drives both the status API and background evaluator. Below minimumRequests is insufficient, not healthy. Burn rate above alertBurnRate creates a warning; a later healthy evaluation resolves it. Stopping an SLO resolves its active warning. The worker evaluates Live definitions; Demo is a fixed-time evaluation workspace. This is single-window observed-span SLI, not multi-window Prometheus burn-rate rules or merged histogram SLO.

### Evaluation and diagnosis

Run `{datasetId,modelVersion,promptVersion,baselineId?,actuals?:{caseId:{field:value}}}`. The runner compares fields exactly, persists failed fields, coverage and score-minus-baseline. If `actuals` is supplied, missing cases/fields lower coverage and score. Omitting it evaluates the dataset's supplied actual fixtures. Baseline must use the same dataset ID/version; changing cases requires a new dataset version. This runner never calls an LLM and does not establish semantic response correctness.

Diagnosis returns `mode`, version, authorized evidence, hypotheses with supporting/counter evidence IDs, missingEvidence and nextCheck. Unknown evidence IDs reject the response. An HTTPS gateway receives counts/service identifiers/timestamps, never raw messages/prompts/tool arguments. It returns `{hypotheses:[{hypothesis,supportingEvidence,counterEvidence,missingEvidence,nextCheck}]}`. Configuration, explicit UI consent and an admin request are required for transmission. Provider quality remains unverified and there is no remediation action.

### OTLP JSON limits and probe vantage

Logs map resourceLogs/scopeLogs/logRecords, scalar body/severity/timestamps and trace IDs. Metrics map gauge/sum/explicit-bucket histogram; preserve name/unit/start/temporality/distribution. Nonmonotonic sums are represented as signed gauges, monotonic sums as counters. Exponential histograms, protobuf/gRPC and arbitrary point-label series aggregation are unsupported. JSON parser/key/batch/expanded body/resource limits apply to all signals.

Probes may set `vantageRegion`; only a worker with that REGION executes them. Result metadata records `lastVantageRegion` and `lastWorkerId`. Target resource region and executing vantage are separate. There is no automatic substitute region when the selected worker region is unavailable.

## Request flow (v0.4)

`GET /api/request-flow?workspace=live&from=<unix-ms>&to=<unix-ms>` accepts the shared environment/service/resource selectors and optional `route`. Optional `edge` is a 24-character lowercase hexadecimal connection ID returned by a previous response. Bad syntax returns 400; an ID outside the current scope returns 404 with a clear-selection message. Read access is required; workspace authorization is unchanged.

Response `source` is always `retained-observed-spans`. `nodes` carry type (`caller`, `workload`, `dependency`), service/host name, environment, region, module and catalog owner. `edges` carry source/target IDs, method/route/protocol/direction, count/errors/clientErrors/throttled/timeouts/retries/paired, parentRequests/impactedRequests/recoveredRequests and observed average/p50/p95/maximum latency in milliseconds. `firstSeen`/`lastSeen` and response `from`/`to` are Unix milliseconds.

CLIENT→SERVER pairs count one attempt, measured at CLIENT. Unpaired SERVER spans describe entry requests. `parentRequests` counts distinct nearest ancestor SERVER requests; `impactedRequests` counts those with a failed child and failed SERVER; `recoveredRequests` counts those with a failed child and successful SERVER. These are correlated outcomes and are not a root-cause or business-success claim. Retries counts attempts whose resend ordinal is greater than zero; malformed resend values contribute zero.

`selectedEdge` defaults to a high-failure outbound connection. `buckets` contain its time-series counts/errors/observed p95. `histogram` contains sparse `{timestamp, bin, count}` rows with non-overlapping bins: ≤10ms, (10,25], (25,50], (50,100], (100,250], (250,500], (500,1000], (1000,2500], (2500,5000], (5000,10000], >10000ms. Empty cells are absent. `durationBounds` exposes the boundaries; `stepMs` is at least one minute and targets at most 48 buckets. `evidence` contains at most 12 failed/slow attempts with trace/span IDs and optional parent response facts. Up to 1,000 connections are returned; `truncated` discloses result caps. The frontend graph has its own 50-node/60-pair cap.

Native spans may specify `spanKind` (`internal`, `server`, `client`, `producer`, `consumer`). OTLP JSON uses numeric kinds 0–5; absent/unspecified kind stays unknown and is not fabricated as SERVER. Existing legacy root spans remain eligible for older API/SLI views; explicit CLIENT roots do not enter their server-request denominator.

### Dependency monitors

`GET /api/dependency-monitors?workspace=live` returns `{items, statuses, observedAt}` (server observation time). Each evaluation status carries `at`, configuration `revision`, `status` (`unknown`, `healthy`, `violated`) and per-connection observations. A missing or mismatched-revision evaluation means pending; an old timestamp means stale. Status is current control evidence, independent of the historical investigation window.

Write access supports `POST /api/dependency-monitors` and `PATCH /api/dependency-monitors/:id`. PATCH uses a full definition, matching other control APIs. Body:

```json
{
  "name": "Orders → payment provider",
  "service": "orders-api",
  "environment": "production",
  "region": "ap-northeast-2",
  "module": "api",
  "dependency": "payment-provider",
  "route": "/charge",
  "method": "POST",
  "indicator": "error_pct",
  "threshold": 5,
  "minimumRequests": 20,
  "windowMinutes": 5,
  "enabled": true
}
```

`indicator` is `error_pct` or `p95_ms`. Threshold must be positive; percentage ≤100, latency ≤86,400,000ms. Minimum count is 1–1,000,000; window is 1–1,440 minutes. At most 50 monitors per workspace. Optional deployment selectors scope the source. Rules match outgoing source/target/route/method, evaluate each region/module connection and use a revision check within a short control transaction. Multiple workers take a per-monitor database lock. Missing/insufficient observations hold an existing active alert rather than announcing recovery. Healthy observations resolve it; disabling resolves active monitor alerts through the recovery pipeline. Notification policies, maintenance, acknowledgment, snooze and repeats use existing delivery semantics. Demo rules do not cause external network delivery. These rules observe retained attempts; they are not unsampled service-level objectives.
