# Validation evidence

Validated in the development environment with synthetic data. This describes the tested implementation, not a production deployment or independent security audit.

## Passed

- Java 21 / Spring Boot compilation, packaged-jar startup and optional browser-script syntax checks.
- **30 Java backend/API tests** covering sign-in, CSRF/origin checks, throttling, MFA/replay rejection, secure cookies, validation, consent evidence, opt-outs, message idempotency, closed-lead suppression, request detection/acknowledgements, historical/automated-email suppression, WhatsApp signature verification/window/templates, reminder uniqueness/stale-policy cancellation, atomic CSV import, disabled-live-send safeguards, interrupted/ambiguous outcomes, Gmail OAuth state/PKCE/encryption, incremental sync, sent-folder reconciliation, encrypted snapshot/restore integrity, Toronto dates, and manual WhatsApp handoff/confirmation.
- **10 database-backed browser workflow groups**: owner login, client creation/consent, follow-ups, incoming requests, acknowledgements/tasks, inbox-only contacts, policies, reminder sends, CSV preview/confirmation, server persistence after reload, phone-app handoff, mobile navigation, and logout. No browser JavaScript errors were observed.
- **13 original visual-prototype browser check groups** retained separately.
- Java Docker production image build and **2 container smoke checks**: production-mode owner MFA sign-in, client creation, non-root/read-only container operation and database persistence across a container restart.
- Terraform formatting and provider/schema validation. No Terraform plan/apply against an AWS account has occurred.
- The production runtime has no npm dependencies. Browser tooling is development-only. Dependency/image patching and independent security review remain operational responsibilities.

The development environment's Docker build used its existing trusted Java certificate store, Maven proxy settings and host-resolved proxy address. TLS/package verification remained enabled. Normal deployment instructions do not disable verification or hard-code these environment-specific addresses.

## Not yet validated

- Actual broker Gmail OAuth consent, Gmail production verification eligibility, refresh-token longevity, and delivery to real agreed test recipients.
- Meta business/number ownership, phone-app coexistence eligibility/provider event formats, approved templates, and real WhatsApp inbound/outbound/status behavior.
- AWS account permissions, actual regional resource prices, Terraform plan/apply, DNS and public TLS issuance.
- S3 backup upload through the actual instance role, scheduled backup alerting, and a full off-instance recovery rehearsal. Snapshot encryption and Java restore commands passed controlled tests, including compatibility with Node-generated password/token fixtures.
- External uptime/backup-failure alerting, broader production security/privacy review, retention/deletion procedures, or multi-business access isolation.

Live messaging defaults to off. Production launch requires the gates in SINGLE-BROKER-LAUNCH.md; passing local tests alone does not authorize real-client operation.
