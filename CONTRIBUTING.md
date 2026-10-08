# Contributing

Use Node 24+, `npm ci`, then `npm run dev`. Run `npm run check` before proposing a change. Keep scope explicit: implemented runtime behavior, demo fixtures and planned integrations must remain distinguishable.

Shared ingest/domain schemas are in `packages/contracts/src`. Server boundaries validate inputs and enforce workspace/role access before querying or changing state. A new adapter must pass equivalent idempotency, scope, time, cursor and privacy tests. Worker changes need state-transition/recovery tests rather than implementation-mirroring snapshots.

For UI changes preserve the shared context, numeric units, data freshness, semantic keyboard controls and responsive layouts. Verify the actual screen. Use original fixtures; do not commit private hostnames, tokens, raw production logs or third-party product screenshots.

Pull requests should describe the user-visible problem, resulting behavior, validation and material limits. Don't advertise a provider as connected before its runtime integration is tested. Report security issues privately as described in SECURITY.md.
