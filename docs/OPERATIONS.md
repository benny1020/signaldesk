# Operations

## Modes and secrets

Local: `npm start`, loopback port 4319. The Node entrypoint loads `.env` if present. The generated local channel key is in the SQLite settings table; local encryption does not protect a stolen database against a reader who can also read this key.

Token mode: generate a new `.env` with `npm run --silent credentials > .env`, then `npm start`. For shared PostgreSQL use `docker compose --env-file .env -f deploy/compose.distributed.yaml up --build -d`; plain `docker compose up --build -d` is single-process SQLite evaluation. Generate credentials only for a new installation: overwriting an existing `.env` rotates tokens and the channel key. Token mode fails fast if there are no strong tokens or no 64-character hex CHANNEL_KEY. Do not print these values into logs, commit them, or place them in URLs. Store the key separately from production database backups. Changing it without migrating encrypted channel values makes existing channels unreadable.

ACCESS_TOKENS is a JSON array of `{token,role,workspaces,name}`. Provision distinct ingest, viewer and admin tokens. Redeploy/restart after rotation; browser clients enter the new token. The browser keeps it in sessionStorage, not permanent localStorage. HTTPS and a restrictive reverse proxy are required for remote clients. Local mode refuses non-loopback binding.

The container runs as node with no-new-privileges and dropped capabilities. Single-process Compose exposes 4320; shared PostgreSQL Compose exposes gateway 4321, both on host loopback. Mount/configure a TLS reverse proxy deliberately if you want network access. Docker is not deployed to an external host by this repository.

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
