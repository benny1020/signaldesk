# Security

This is a v0.4 self-hosted beta. Local mode must remain loopback-only. Remote binding requires token mode, strong workspace-scoped tokens and a stable 32-byte channel encryption key. Put remote access behind HTTPS; do not expose the Node port directly on the internet.

Tokens live in environment configuration; browser tokens are session-scoped. This is not SSO or managed user provisioning. Encrypted channel URLs require a separately protected key in token mode. Local mode stores its generated key in the local database, providing a convenience baseline rather than protection against database theft.

`npm run setup` uses exclusive file creation and owner-only permissions. It never replaces a channel key or prints generated credentials. `/api/session` exposes only the current role, actor and authorized workspaces; ingest tokens cannot open the UI. Bearer comparisons use fixed-length SHA-256 digests and timing-safe equality. UI controls reflect viewer permissions; server checks remain authoritative. Disconnect removes the tab token and clears cached queries; rotation/revocation still requires a configuration restart.

API/health responses use `Cache-Control: no-store`. The browser policy restricts scripts, fonts, connections and workers to the application origin (worker blobs allowed), denies framing and disables camera/microphone/geolocation. Inline styles remain allowed for chart/layout libraries. Verify response headers at the final HTTPS ingress; a proxy can change them. Avoid third-party scripts on the operator origin. Follow the [launch checklist](docs/LAUNCH_READINESS.md) before opening access.

Outbound requests enforce HTTPS, public/reserved address checks, pinned DNS resolution, no redirects, timeouts and a 64 KiB response ceiling. Explicit private destination allowlists are operator-controlled. These checks do not replace network egress policy. Channel delivery errors do not expose stored destination URLs through the public connection representation.

AI content attributes and common credential attributes are stripped. Log strings redact common bearer/password/API-key forms. Arbitrary PII can still appear in free-form logs; redact at source and control access/retention. Model calls are off by default. A separately configured diagnosis gateway receives bounded aggregate evidence only after explicit administrator opt-in; model accuracy and the recipient's privacy policy need separate acceptance.

For a vulnerability, use GitHub's private vulnerability reporting if enabled, or contact the repository owner privately through GitHub. Avoid including live credentials or telemetry in public issues. Rotate exposed credentials and protect database/key backups.

Shared PostgreSQL requires trusted TLS and consistent credentials across replicas. Session ownership requires direct connections or session pooling; transaction pooling invalidates worker-lock assumptions. Regional Collector receivers must remain private or gain explicit authentication/TLS. Persistent volumes and database snapshots may contain telemetry; enforce deployment access policy.
