# MapleDesk · Single-broker workspace

A client-first insurance workspace for a broker using Gmail and WhatsApp Business. It keeps client names unchanged and organizes follow-ups, policies, conversations and change tasks in one place.

**Status:** implemented and locally tested; no real accounts connected and no AWS resources deployed. Provider acceptance tests, phone-app coexistence validation and an AWS recovery rehearsal are still required before production use.

## Start here

- [Current scope, architecture and estimated operating costs](docs/SINGLE-BROKER-LAUNCH.md)
- [Account setup: test locally before buying cloud infrastructure](docs/ACCOUNT-SETUP.md)
- [Development, deployment, backups and recovery](docs/DEPLOYMENT.md)
- [Validation evidence and remaining launch gates](docs/VALIDATION.md)
- [Original interactive visual prototype](mockups/MapleDesk-Interactive.html)

## What it does

- Private owner sign-in, secure server sessions, authenticator MFA in production, and login throttling.
- Server-backed contacts, consent evidence, opt-outs, client notes, lead statuses, monthly filters and 2/4-day follow-up dates.
- Gmail OAuth, recent inbox/sent synchronization, incremental polling, conversation replies and queued sending adapters.
- Official WhatsApp API webhook verification, inbound messages/statuses, approved templates and service-window checks.
- A **manual WhatsApp alternative**: open a draft in the existing phone app and explicitly confirm sending. It does not claim automatic delivery or synchronize app history.
- Policy entry/updates, CSV preview/import, daily 30/7-day reminder drafts and broker approval.
- Rule-detected client change requests, optional receipt-only acknowledgements, manual task creation and internal review notes.
- Durable jobs, duplicate protection, stale-policy checks, audit activity, encrypted credential storage and encrypted backup/restore tooling.

The pilot uses Node.js 24, Express and SQLite on one server. It has no subscription billing, AI fees, insurer portal automation or multi-business hosting. Scaling to other businesses needs a reviewed data/access migration.

## Local setup

```sh
npm ci
# Provision the owner with a password entered privately; see the runbook:
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -s -p 'Initial owner password (14+ characters): ' OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
npm run setup:local
unset OWNER_EMAIL OWNER_PASSWORD
npm start
```

The workspace is at `/`; the original demo is at `/demo`. The setup command creates an empty database and a private `.env`; no default owner or sample clients are created. Messaging defaults to mock delivery. Keep `.env`, databases, backups and Terraform state out of Git.

```sh
npm run check
npm test
```

Browser tests need Chromium: `npx playwright install chromium`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing binary. Tests use temporary databases and synthetic provider responses. For container checks, build `mapledesk:pilot` and run `npm run test:container`. No tests require real client accounts.

The self-contained visual mockup in `mockups/` still works offline: use GitHub's **Download raw file**, then open the HTML. It is separate from the database-backed application and its subscription screens remain illustrative.
