# Operations

## Modes and secrets

Local: `npm start`, loopback port 4319. The Node entrypoint loads `.env` if present. The generated local channel key is in the SQLite settings table; local encryption does not protect a stolen database against a reader who can also read this key.

Token mode: generate a new `.env` with `npm run setup`, then `npm start`. For shared PostgreSQL use `docker compose --env-file .env -f deploy/compose.distributed.yaml up --build -d`; plain `docker compose up --build -d` is single-process SQLite evaluation. Generate credentials only for a new installation: overwriting an existing `.env` rotates tokens and the channel key. Token mode fails fast if there are no strong tokens or no 64-character hex CHANNEL_KEY. Do not print these values into logs, commit them, or place them in URLs. Store the key separately from production database backups. Changing it without migrating encrypted channel values makes existing channels unreadable.

ACCESS_TOKENS is a JSON array of `{token,role,workspaces,name}`. Provision distinct ingest, viewer and admin tokens. Redeploy/restart after rotation; browser clients enter the new token. The browser keeps it in sessionStorage, not permanent localStorage. HTTPS and a restrictive reverse proxy are required for remote clients. Local mode refuses non-loopback binding.

The container runs as node with no-new-privileges and dropped capabilities. Single-process Compose exposes 4320; shared PostgreSQL Compose exposes gateway 4321, both on host loopback. Mount/configure a TLS reverse proxy deliberately if you want network access. Docker is not deployed to an external host by this repository.

## Installation and runtime checks

`npm run setup` creates private new settings (`--output path` is optional). Exclusive creation prevents accidental token/channel-key rotation; existing files are never overwritten. No credentials are printed. The legacy `credentials` command still writes secrets to stdout for explicit advanced use and must not be redirected over an existing installation.

New settings use token mode, no Demo seeding, no local OS collection and strict producer identity. Demo can be enabled deliberately with `SEED_DEMO=true`. Configure each real producer and protect the ingress before opening access. An operator connects with a viewer or admin token; ingest tokens are rejected by the UI. The session identifies its allowed workspaces. Viewer controls are disabled and the backend independently rejects writes. Disconnect clears the tab token and query cache.

```bash
npm run doctor -- --url http://127.0.0.1:4321
npm run benchmark
```

Doctor loads the current private `.env`; alternatively configure `SIGNALDESK_OPERATOR_TOKEN` securely in the process environment. It only reads session, health, capabilities, Live resource inventory and connection state. It rejects credential/query-bearing URLs, remote cleartext and redirects. It prints safe check summaries rather than upstream responses, channel destinations, worker errors or tokens. Exit 1 denotes a failed check; 2 denotes unresolved manual evidence. It intentionally leaves notification recipient receipt and recovery/load certification unresolved. Loopback previews and missing non-example application producers remain warnings. The platform's own spans and example producers do not establish application coverage.

The benchmark creates a fresh temporary SQLite WAL database, inserts 100,000 synthetic events across five independent regions, reopens it and asserts complete global/regional flow counts. It measures five sequential HTTP handler queries per scenario and removes the fixture directory. It excludes concurrent ingress, PostgreSQL/WAN and real regional failover; results depend on the machine. SQLite performs bounded query-planner optimization on opening and before aggregate queries after 10,000 inserts or one hour, following [SQLite guidance](https://www.sqlite.org/pragma.html#pragma_optimize). Receiver ranks are materialized once and relevant CLIENT ancestry is narrowed before traversal, preserving missing-context and pairing semantics.

## Capacity, health and worker

Default telemetry retention: seven days. Default ceiling: 1,000,000 events; MAX_EVENTS accepts 10,000–10,000,000. Capacity is a deliberate safety bound, not a performance recommendation. Estimate actual producer volume. Exhaustion returns 507; queries continue, and collector failures are logged. Prune/expand/move storage based on measured needs. Auto-prune deletes expired telemetry, not incidents/audit history.

Each worker runs every 5 seconds without overlapping its own ticks; shared PostgreSQL session task locks coordinate replicas. Synthetic checks run every 60 seconds and use bounded network requests. The connection screen exposes storage occupancy, worker heartbeat/error, process ingest counts and deliveries. Check both worker heartbeat freshness and its reported error; `/health` checks database access; it does not certify ingestion completeness or worker health. API counters are process-local, while occupancy and worker heartbeat records are shared. Pending jobs persist and resume after restart; retry delivery is at-least-once.

Limits: 100 rules/workspace, 1,000 incidents/workspace, 500 entries/incident, 20 channels/workspace, 10 probes/Live. Delivery/audit views show their last 100 records. These are operational views, not deletion/retention controls for the control plane. Plan control-data archival before long-term/high-volume use.

Outbound requests require HTTPS port 443, valid TLS and no embedded URL credentials. Redirects are not followed. DNS is resolved with a bounded wait, checked for private/reserved addresses, and pinned in the request to avoid rebinding. Requests have 5-second timeouts and at most 64 KiB response data. `ALLOWED_DESTINATION_HOSTS` is an optional exact-host allowlist for intentional private destinations; use it together with network egress controls. Avoid putting secrets in synthetic-check URLs, which are visible to workspace readers.

## Backups and recovery

For the simplest consistent backup, stop the instance cleanly, copy the database and retain CHANNEL_KEY separately, then restart. SQLite WAL files can hold recent writes; do not copy only the main file while the app is writing. For online backups use SQLite's supported backup API/tooling and verify restore on a separate instance.

Restore to a separate data directory first. Verify sample telemetry, rules, incident timeline and scoped login before replacing a running instance. PostgreSQL workers may share the control database and coordinate by task locks. Never share SQLite between processes. Failed deliveries can be retried in the UI. No automatic rollback/remediation changes external infrastructure.

Demo reset: `npm run demo:reset` replaces only Demo fixture/control data and its clock. Live data is preserved. Stop the running app before resetting and restart/reload to avoid caching stale Demo records.

## Runtime configuration

| Setting                                                       | Behavior                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| STORAGE_BACKEND                                               | `sqlite` (local default) or `postgres`; DATABASE_URL auto-selects PostgreSQL                          |
| APP_ROLE                                                      | `all`, `api` or `worker`; split roles require PostgreSQL                                              |
| DATABASE_URL / PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD | Standard PostgreSQL connection configuration; use TLS and verify certificates remotely                |
| PG_POOL_SIZE                                                  | 2–50 per process, default 10; reserve DB admin headroom                                               |
| MODULE, REGION, ZONE, CLUSTER, NAMESPACE, INSTANCE_ID         | Platform process resource dimensions; do not substitute for producer identity                         |
| ENVIRONMENT                                                   | Local collector/self-span environment, default local                                                  |
| COLLECT_LOCAL                                                 | Set false for dedicated API nodes to avoid confusing container OS measurements with application hosts |
| REQUIRE_RESOURCE_IDENTITY                                     | true requires module, region and instanceId in every native event / OTLP resource                     |
| SEED_DEMO                                                     | false suppresses fixtures on production installations                                                 |
| MAX_RESOURCES                                                 | 100–1,000,000 per workspace, default 20,000; retired identities also count                            |

## Scale beyond one instance

Use shared PostgreSQL for API and worker replicas. Migrations are serialized automatically; changing schema across rolling versions still requires compatibility review. Session advisory locks require **direct DB connections or session pooling**, not PgBouncer transaction pooling. Control mutations and capacity accounting are correctness-first serialization points; they require contention measurements on real volume.

For PostgreSQL, use managed backups/PITR or consistent `pg_dump` and keep CHANNEL_KEY separately. Restore into a new database and verify telemetry, identities, group states, incident notes and pending deliveries before switching clients. A failover/restore may retry outbound deliveries, so receivers must deduplicate deliveryId. Verify TLS certificates on remote DB connections; never disable certificate verification as a shortcut.

Use [multi-region design](MULTI_REGION.md) for regional queues, UID/volume setup, failover responsibilities, pool budgets and volume estimates. Resource retirement preserves records and stops evaluation on the next successful worker tick. Registry is operator-managed; cloud discovery and auto-retirement are planned. Dashboard inventory/filter options cap at 10,000 and current alert snapshots at 1,000; narrowing a scope is required above those limits.

The API is not production load-certified. Local Docker tests prove shared-state and recovery behavior under their fixture conditions, not WAN/database-HA guarantees.

## v0.3 upgrade and notification policy

Back up telemetry/control storage and CHANNEL_KEY before upgrading. Stop all old workers/APIs for this schema transition, deploy one v0.3 process to migrate, verify the restored/scoped records, then start replicas. SQLite migration 3 rebuilds outbox while preserving v0.2 receipts; PostgreSQL adds event_key/event_type and replaces the old alert/channel unique constraint. Firing, repeat and recovery have separate idempotency keys. Old binaries are not a supported rollback against the migrated outbox: restore the matching backup into a separate database and verify before traffic cutover. No existing production database is upgraded by this development task.

New control kinds are capped at 1,000/workspace; dataset cases at 500 and linked incident alerts at 100. Configure routes before depending on them: no policies means legacy broadcast, any configured policy switches to explicit matches, and all disabled means no transmission. Preview owner/channel/maintenance selection before rollout. ACK, snooze, maintenance and incident state are separate. Delivery depth/age is queried across the entire outbox; the receipt list still shows 100 records. Demo destinations simulate preview only and never send.

## Trusted ingress and synthetic vantage

`TRUSTED_PROXIES` is a comma-separated exact IP/CIDR list, empty by default. It is passed to Fastify's trustProxy. Trust only your own ingress and sanitize forwarded headers there. `/health` bypasses application quota. The distributed example gives Nginx the fixed IP `172.31.240.10` on `172.31.240.0/24`; change both subnet/IP and trust setting together if that subnet conflicts. Arbitrary forwarded headers from a direct client cannot select its quota identity.

A probe's `vantageRegion` selects workers by their actual REGION. Leave it unset for the first eligible worker. Record the observed vantage/worker with each result; do not treat labels in a one-host Compose exercise as geographic availability. The default distributed workers carry Seoul and Virginia labels. If no eligible worker exists the check is stale; there is no implicit region failover.

## Durable Node producer

```js
import { DurableSignalDeskClient } from './packages/sdk/node.js';
const client = new DurableSignalDeskClient({
  endpoint: 'http://127.0.0.1:4319',
  token: process.env.SIGNALDESK_INGEST_TOKEN,
  queuePath: '/var/lib/orders/telemetry.json',
  workspace: 'live',
  resource: { module: 'api', region: 'ap-northeast-2', instanceId: process.env.INSTANCE_ID },
});
client.emit({
  service: 'orders',
  environment: 'production',
  kind: 'metric',
  name: 'error_pct',
  value: 0.4,
  timestamp: Date.now(),
});
await client.flush();
client.close();
```

The journal uses restrictive permissions, atomic rename, file/directory fsync and a PID single-writer lock. Reopening replays stable IDs; storage deduplicates them. Endpoint/workspace mismatch and corrupt journals fail closed. Token is not written to disk; sensitive attribute keys and credential patterns are redacted before persistence. Protect and encrypt its volume as needed: arbitrary sensitive log text is not universally detectable.

Call flush until queue empties during graceful shutdown, then close; close itself preserves unsent events. A stale PID lock is recoverable; a live owner or incomplete lock requires operator investigation. Capacity counts queued plus in-flight events; emit returns false and increments dropped when full. Monitor dropped and disk capacity. Journal rewrite is synchronous and proportional to bounded queue size, intended for a pilot producer, not a high-volume broker. Close/reopen replay is tested; power-loss/disk-corruption/whole-volume loss is not certified. Regional Collector traces remain a separate tested durable path.

## Optional diagnosis gateway

Default off. Set `AI_DIAGNOSIS_ENABLED=true`, `AI_DIAGNOSIS_URL` to an approved HTTPS endpoint and `AI_DIAGNOSIS_TOKEN` through secret management. The same DNS/egress/timeout/64 KiB response limits as other outbound calls apply. UI discloses the destination and requires per-request opt-in; external requests require admin. Counts, service identifiers and observation times may still be sensitive, so choose a destination authorized for them. Raw logs, prompts and tool bodies are excluded. Gateway contract is in API.md. No external model was called during acceptance and no automatic resource changes exist.
