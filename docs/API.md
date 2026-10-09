# API reference

Version 0.2. Native contract: `packages/contracts/src/index.ts`. Content-Type: `application/json`. No CORS is enabled; serve the UI and API from the same origin. In local mode loopback Host and Origin are enforced. In token mode use an Authorization bearer token.

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

Lists return `{items,nextCursor,truncated}` for telemetry. Cursor order is timestamp and event ID descending. Treat cursors as opaque. HTTP 400 indicates invalid input, 401 missing/invalid token, 403 scope/role denial, 404 missing item, 429 rate limit and 507 storage/cardinality capacity, 503 operational database/worker availability errors. The API has a 1 MiB expanded request body limit (gzip supported) and a default 240 requests/minute per client IP. Behind a proxy configure an explicit trusted-client strategy before changing this limiter.

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

Metric names: `request_rate` (req/s), `error_pct` (%), `latency_p95_ms` (ms), `cpu_pct` (%), `memory_pct` (%), `probe_up` (0/1), `probe_duration_ms` (one synthetic request duration, not p95), `ai_cost_usd` (USD measurement supplied by producer). Values are finite/nonnegative; percentages are ≤100. Include `host` for host resource metrics. Rates and percentiles are producer-calculated gauges, not raw counters or histograms. Do not send a cumulative count under `request_rate`.

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

Create incident: title, service, environment, optional deployment identity, severity, owner and optional scoped alertId. Patch: investigating/identified/monitoring/resolved status, owner and/or note. Timeline entries record actor/time. An incident is not automatically closed when its alert recovers.

The generic webhook body is `{source:"signaldesk",deliveryId,alert}`. New Live alert creation and outbox insertion are one control transaction. Pending delivery may be deferred by snooze or cancelled on recovery/channel disable. HTTP 2xx succeeds; redirects do not. Failures retry with bounded exponential delay, five attempts total. Crash after remote success can redeliver: deduplicate deliveryId. Acknowledge is independent from delivery and incident state.
