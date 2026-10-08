# Operations

## Modes and secrets

Local: `npm start`, loopback port 4319. The Node entrypoint loads `.env` if present. The generated local channel key is in the SQLite settings table; local encryption does not protect a stolen database against a reader who can also read this key.

Token mode: generate a new `.env` with `npm run --silent credentials > .env`, then `npm start`. For a container use `docker compose up --build -d`. Token mode fails fast if there are no strong tokens or no 64-character hex CHANNEL_KEY. Do not print these values into logs, commit them, or place them in URLs. Store the key separately from production database backups. Changing it without migrating encrypted channel values makes existing channels unreadable.

ACCESS_TOKENS is a JSON array of `{token,role,workspaces,name}`. Provision distinct ingest, viewer and admin tokens. Redeploy/restart after rotation; browser clients enter the new token. The browser keeps it in sessionStorage, not permanent localStorage. HTTPS and a restrictive reverse proxy are required for remote clients. Local mode refuses non-loopback binding.

The container runs as node with no-new-privileges and dropped capabilities. Compose exposes 4320 only on the host loopback. Mount/configure a TLS reverse proxy deliberately if you want network access. Docker is not deployed to an external host by this repository.

## Capacity, health and worker

Default telemetry retention: seven days. Default ceiling: 1,000,000 events; MAX_EVENTS accepts 10,000–10,000,000. Capacity is a deliberate local safety bound, not a performance recommendation. Estimate actual producer volume. Exhaustion returns 507; queries continue, and collector failures are logged. Prune/expand/move storage based on measured needs. Auto-prune deletes expired telemetry, not incidents/audit history.

The worker runs every 5 seconds without overlapping ticks. Synthetic checks run every 60 seconds and use bounded network requests. The connection screen exposes storage occupancy, worker heartbeat/error, process ingest counts and deliveries. Check both worker heartbeat freshness and its reported error; `/health` is only process liveness. Pending jobs persist and resume after restart; retry delivery is at-least-once.

Limits: 100 rules/workspace, 1,000 incidents/workspace, 500 entries/incident, 20 channels/workspace, 10 probes/Live. Delivery/audit views show their last 100 records. These are operational views, not deletion/retention controls for the control plane. Plan control-data archival before long-term/high-volume use.

Outbound requests require HTTPS port 443, valid TLS and no embedded URL credentials. Redirects are not followed. DNS is resolved with a bounded wait, checked for private/reserved addresses, and pinned in the request to avoid rebinding. Requests have 5-second timeouts and at most 64 KiB response data. `ALLOWED_DESTINATION_HOSTS` is an optional exact-host allowlist for intentional private destinations; use it together with network egress controls. Avoid putting secrets in synthetic-check URLs, which are visible to workspace readers.

## Backups and recovery

For the simplest consistent backup, stop the instance cleanly, copy the database and retain CHANNEL_KEY separately, then restart. SQLite WAL files can hold recent writes; do not copy only the main file while the app is writing. For online backups use SQLite's supported backup API/tooling and verify restore on a separate instance.

Restore to a separate data directory first. Verify sample telemetry, rules, incident timeline and scoped login before replacing a running instance. Do not run two workers against one restored/shared control database. Failed deliveries can be retried in the UI. No automatic rollback/remediation changes external infrastructure.

Demo reset: `npm run demo:reset` replaces only Demo fixture/control data and its clock. Live data is preserved. Stop the running app before resetting and restart/reload to avoid caching stale Demo records.

## Scale beyond one instance

The TelemetryStore port supports async append/query/occupancy/prune. Implement actual remote query semantics, scope checks, stable cursors, ingest idempotency and privacy before connecting a remote engine. Keep the control database separate. A horizontal deployment also needs transactional shared control storage, worker leases, a durable queue, idempotent event keys and distributed aggregates. SQLite volume sharing and simply adding replicas are unsupported.

Use the [roadmap](ROADMAP.md) for staged integrations. The API is not production load-certified. Observed local benchmark numbers and smoke tests establish only their measured conditions.
