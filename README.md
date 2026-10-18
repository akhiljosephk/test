# MapleDesk · Java / Spring Boot

A single-broker insurance workspace built with **Java 21, Spring Boot 3.5, Spring Security, Spring JDBC and SQLite**. The existing browser interface remains JavaScript; **Node.js is not required to build or run the application**. It is optional for Playwright browser tests and visual-mockup exports.

**Status:** locally validated implementation; no real accounts connected or AWS resources deployed. Gmail/WhatsApp acceptance tests, phone-app coexistence verification, and an AWS backup/restore rehearsal are still launch gates.

## Get started

Install a Java 21 **JDK**, then build using the checked-in Maven Wrapper:

```sh
./mvnw verify
# On Windows: mvnw.cmd verify
```

Provision the owner with a privately entered password:

```sh
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -s -p 'Initial owner password (14+ characters): ' OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
java -jar target/mapledesk-1.0.0.jar --app.command=init
unset OWNER_EMAIL OWNER_PASSWORD
java -jar target/mapledesk-1.0.0.jar
```

The initializer creates a private `.env` with an encryption key if none exists, provisions an owner if needed, and preserves existing files/owners. No sample clients or default password are created. You can alternatively run `./mvnw spring-boot:run` after provisioning. The private workspace is at `/`; the original visual demo remains at `/demo`.

## Features

- Private owner sign-in, server sessions, session-bound CSRF/origin checks, login throttling and production MFA.
- Persistent clients, consent evidence, opt-outs, notes, lead statuses, monthly filters and 2/4-day follow-up dates.
- Gmail OAuth with PKCE, encrypted tokens, incremental inbox/sent sync, conversation replies and queued sending.
- Official WhatsApp webhook verification, inbound/status events, service-window enforcement and approved templates.
- Manual WhatsApp phone-app handoff with explicit owner confirmation, separate from verified delivery.
- Policy entry/updates, CSV preview/import, and reviewed 30/7-day reminder drafts.
- Receipt-only acknowledgements, rule-detected change requests, manual tasks, audit events and durable jobs.
- Java backup/restore commands, Docker/Caddy HTTPS deployment, Terraform and CI.

## Code organization

| Component | Responsibility |
|---|---|
| `ApiController` | HTTP contract used by the interface |
| `DomainService` and `Input` records | Clients, leads, policies, imports and requests |
| `Database` | Spring JDBC, transactions and SQLite schema compatibility |
| `AuthService`, `SecurityConfig`, `Crypto` | Authentication, MFA, request protections and encryption |
| `JobService` | Persistent scheduling, retries and send safeguards |
| `IntegrationService`, `ProviderTransport` | Gmail and official WhatsApp adapters |
| `Cli` | Owner provisioning/reset, encrypted backup and restore |
| `src/main/resources/static` | Existing browser application and original demo |

## Validation

`./mvnw verify` runs Java integration/security tests and packages the application. Browser checks are separate and optional:

```sh
npm ci
npx playwright install chromium  # or use existing Chromium
npm run check
npm test                        # starts the packaged Java application
```

For container checks: `docker build -t mapledesk:java .`, then `npm run test:container`. Browser tools contain no production backend dependencies. `npm run export` refreshes the self-contained original mockup.

## Guides

- [Java migration and existing-data compatibility](docs/JAVA-MIGRATION.md)
- [Current single-broker scope, architecture and costs](docs/SINGLE-BROKER-LAUNCH.md)
- [Account setup before cloud spending](docs/ACCOUNT-SETUP.md)
- [Deployment, backups and recovery](docs/DEPLOYMENT.md)
- [Validation evidence and launch gates](docs/VALIDATION.md)

Keep `.env`, databases, backups and Terraform state private. This pilot is not multi-business SaaS and does not include insurer portal automation, paid AI or subscription billing.
