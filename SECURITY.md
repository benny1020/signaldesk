# Security

This is a v0.1 self-hosted baseline. Local mode must remain loopback-only. Remote binding requires token mode, strong workspace-scoped tokens and a stable 32-byte channel encryption key. Put remote access behind HTTPS; do not expose the Node port directly on the internet.

Tokens live in environment configuration; browser tokens are session-scoped. This is not SSO or managed user provisioning. Encrypted channel URLs require a separately protected key in token mode. Local mode stores its generated key in the local database, providing a convenience baseline rather than protection against database theft.

Outbound requests enforce HTTPS, public/reserved address checks, pinned DNS resolution, no redirects, timeouts and a 64 KiB response ceiling. Explicit private destination allowlists are operator-controlled. These checks do not replace network egress policy. Channel delivery errors do not expose stored destination URLs through the public connection representation.

AI content attributes and common credential attributes are stripped. Log strings redact common bearer/password/API-key forms. Arbitrary PII can still appear in free-form logs; redact at source and control access/retention. No telemetry is sent to a model provider by this release.

For a vulnerability, use GitHub's private vulnerability reporting if enabled, or contact the repository owner privately through GitHub. Avoid including live credentials or telemetry in public issues. Rotate exposed credentials and protect database/key backups.
