# Launch readiness

2026-10-13. **v0.4 is a self-hosted beta for an operator-controlled installation.** Product checks and infrastructure acceptance are separate gates. This document does not certify an unconfigured production deployment.

The same application is deployed independently in Europe, North America, Japan, Singapore and Seoul. There are no inter-region business calls. Central telemetry comparison preserves each environment, region, module and instance identity. External API latency and failures describe the calling side; the provider's internal health and location remain unknown unless separately instrumented.

## Product release gates

| Gate                           | Implementation and evidence                                                                                                                                                                                                                                                                  | Result                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Access                         | Authenticated session identity; authorized workspace list; Live landing; viewer controls; denied ingest UI access; logout cancels queries and clears credentials/cache. Server permissions remain authoritative. Unit/API tests and desktop browser acceptance.                              | Implemented and checked                                        |
| Installation                   | `npm run setup` exclusively creates a mode-0600 file with distinct operator, viewer and producer tokens. It refuses to overwrite an installation. `npm run doctor` performs authenticated runtime reads without printing secrets.                                                            | Implemented and checked                                        |
| Investigation                  | Five-region comparison leads into a region's request map. CLIENT/SERVER pairing links provider attempts, intermediate API responses, entry responses, traces and logs. Readable count labels, route-level distributions and numeric chart alternatives. Desktop and 390px mobile acceptance. | Implemented and checked                                        |
| Browser security               | Same-origin script/connect policy, worker allowance for ELK, denied framing, non-cacheable API responses and fixed-length token-digest comparisons. Invalid tokens, workspace denial and viewer mutation denial have regression coverage.                                                    | Implemented and checked                                        |
| Retained query workload        | Temporary on-disk SQLite WAL database with 100,000 events; close/reopen; five independent regions, 100 order services and 1,000 order instances. Five dashboard/global/Seoul HTTP-handler queries with asserted totals and regional identity.                                                | Measured local fixture; production load unverified             |
| Container and shared execution | CI builds the release container, authenticates and restarts SQLite, checks shared PostgreSQL, two APIs/two workers, worker/API loss, Nginx and Collector persistent trace-queue replay.                                                                                                      | Required CI gate; inspect the run for the exact release commit |

[Verification](VERIFICATION.md) records measurements and their limits. [CI](https://github.com/benny1020/signaldesk/actions/workflows/ci.yml) must pass for the commit being installed. A previous commit's green run is not the release gate.

## Operator gates before opening access

Start with a protected operator installation and connect one real regional producer. Expand only after the relevant evidence is recorded.

| Owner                        | Gate and artifact                                                                           | Pass condition                                                                                                                                                    | Failure or recovery                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure operator      | HTTPS ingress, trusted proxy configuration, network exposure and database TLS record        | Browser and `doctor` validate the intended HTTPS endpoint; backend ports are protected; PostgreSQL certificates are checked                                       | Keep access restricted; repair ingress/proxy/DB configuration and repeat the check                                                    |
| Platform operator            | Private `.env`, role/workspace allocation and separate `CHANNEL_KEY` recovery               | UI and producer tokens are distinct; intended viewers cannot mutate; private files are excluded from source and logs                                              | Revoke compromised tokens; rotate credentials deliberately; encrypted destinations require the correct recoverable key                |
| Regional service owner       | Expected deployment inventory plus one inbound, internal and external-call trace per region | Real application observations retain environment/region/module/instance identity; expected deployments are represented; sampling and missing spans are understood | Repair instrumentation or Collector routes; missing telemetry is an unknown state, not healthy                                        |
| Platform operator            | Doctor JSON and worker/outbox checks                                                        | No runtime failures; worker heartbeat is current; capacity and blocked deliveries are investigated                                                                | Restore the worker/database; fix destination failures before retrying; re-run doctor                                                  |
| On-call/service owner        | Controlled firing and recovery alert, destination receipt and incident timeline             | The actual recipient confirms both intended messages; routing, maintenance and deduplication match the scenario                                                   | Correct destination/policy; retry safely and preserve evidence; a stored HTTP receipt alone does not pass                             |
| Infrastructure operator      | Backup restore rehearsal and Collector outage/replay artifact                               | Database plus separately stored channel key restore successfully; each regional Collector has tested persistent queues for its enabled signals                    | Use [operations](OPERATIONS.md) recovery steps; keep public access restricted until restoration/replay succeeds                       |
| Performance owner            | Measured peak ingest, query concurrency, retention and disk budget                          | Intended production volume fits the selected backend and limits without data loss or unacceptable investigation delay                                             | Reduce query scope, tune limits from measurements or move shared execution to PostgreSQL; do not extrapolate the local fixture        |
| AI feature owner, if enabled | Opt-in provider configuration, privacy review and pinned evaluation results                 | External inference is authorized and its output remains evidence/hypotheses; measured accuracy meets the intended use                                             | Disable the provider; retain local evidence briefing and evaluation; never use model output to assert recovery or execute remediation |

`npm run doctor` exits **1** for runtime failures and **2** for unresolved evidence. Manual receipt and recovery/load checks intentionally remain warnings: health reads cannot verify them. Keep the environment-specific evidence with the release commit, config revision, responsible operator and check time.

## Installation and supported boundaries

```bash
npm ci
npm run setup
npm run build
npm start
# In another terminal, after the server is listening:
npm run doctor
```

Retrieve tokens privately from `.env`. A new installation starts in token mode, with Demo seeding and local host collection off and resource identity required. Do not regenerate `.env` or `CHANNEL_KEY` when upgrading; follow [operations](OPERATIONS.md). Demo is opt-in preview data and never proof of a connected production service.

The reference containers run on one host. They do not provision physical regions or establish geographic HA. Organizational SaaS tenancy, SSO, native on-call scheduling, full OTLP protobuf/gRPC and managed database failover/PITR remain separate work. See the [five-region model](FIVE_REGION_OPERATIONS.md), [instrumentation contract](REQUEST_FLOW_INSTRUMENTATION.md) and [roadmap](ROADMAP.md).
