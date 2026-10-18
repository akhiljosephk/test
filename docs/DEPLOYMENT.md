# Java deployment and operations

## Local build and owner provisioning

Install a Java 21 JDK. Node.js is not required for the application; it is optional for Playwright checks. The Maven Wrapper downloads a checksum-pinned Maven distribution.

```sh
./mvnw verify
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -s -p 'Initial owner password (14+ characters): ' OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
java -jar target/mapledesk-1.0.0.jar --app.command=init
unset OWNER_EMAIL OWNER_PASSWORD
java -jar target/mapledesk-1.0.0.jar
```

Use `mvnw.cmd verify` on Windows and set owner environment values through a private terminal/IDE environment. The initializer creates a private `.env` and encryption key only if absent; existing `.env`, owners and data are preserved. There are no sample clients or default passwords. The application reads `.env` at startup, with actual environment variables taking precedence. Prefer APP_ENV; legacy NODE_ENV is accepted as a fallback.

Use mock delivery and synthetic records first. To reset an owner, set OWNER_EMAIL and a new OWNER_PASSWORD privately and run `java -jar target/mapledesk-1.0.0.jar --app.command=reset-owner`. It revokes all sessions. Changing OWNER_PASSWORD on an existing database during normal startup does not change the password. MFA recovery is an operator procedure: rotate OWNER_TOTP_SECRET securely, revoke sessions with the reset command, then restart. There is no public reset-email endpoint.

For restricted development environments, put MAVEN_USER_HOME and the Maven repository in writable workspace paths. Use a supported Maven proxy settings file and the legitimate trusted Java certificate store if needed. Do not disable TLS or checksum verification. No proxy credentials belong in the repository.

## Checks

```sh
./mvnw verify
# Optional browser checks, after packaging the jar:
npm ci
npx playwright install chromium  # if no existing Chromium is available
npm run check
npm test
```

Java tests use synthetic provider responses and temporary databases; browser tests launch the packaged Java app on temporary ports with test-only owners. No test requires real accounts. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH selects an existing browser. `npm run export` refreshes the original self-contained mockup, not the production app.

## AWS resources (not deployed yet)

Terraform creates a dedicated public subnet/VPC, a small x86 Ubuntu EC2 instance, encrypted gp3 storage, an Elastic IP, private S3 backups, scoped backup-write/SSM instance permissions, a health alarm, an operator-email subscription and a budget alert. There is no RDS, Redis, NAT gateway or load balancer. Port 22 is closed; use Systems Manager Session Manager.

Create a client-owned AWS account with MFA and a short-lived operator identity. Then:

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit recipient, region, budget and size, without credentials.
terraform init
terraform plan -out=reviewed.tfplan
# Review concrete resources and charges before applying.
terraform apply reviewed.tfplan
```

Do not commit Terraform state or plans. Configure an encrypted remote state backend with locking for a real deployment. Root EBS is deliberately retained on termination and continues to incur charges until securely retired. Budget alerts are not a spending cap. Confirm the SNS email subscription.

The single instance is a point of failure; backups do not provide high availability. Keep one Java process/replica on the local SQLite volume. Do not run the old Node runtime against the same database. See JAVA-MIGRATION.md before upgrading existing data.

## Application and HTTPS deployment

1. Point an owned DNS A record to the Terraform Elastic IP. Use a real hostname for public HTTPS.
2. Through Session Manager use an administrator shell, verify cloud-init completed, and verify Docker/Compose are installed. The deployment directory is `/opt/mapledesk`.
3. Transfer a reviewed release/commit to that directory. Use scoped HTTPS Git access or a verified release archive; do not embed credentials in clone URLs or images.
4. Create `.env`, owner-only mode 600, from `.env.example`. Set APP_DOMAIN (hostname), PUBLIC_URL (HTTPS origin), APP_ENV=production, a random 32-byte hex DATA_KEY, initial OWNER_EMAIL/OWNER_PASSWORD, and a securely enrolled base32 OWNER_TOTP_SECRET. Keep key/MFA recovery information independently in a password manager.
5. Initially set MESSAGING_MODE=mock and ALLOW_LIVE_SENDS=false. Set BACKUP_BUCKET to the Terraform output and AWS_REGION=ca-central-1. Keep BACKUP_PREFIX=mapledesk/. Use the instance role, not static AWS keys.
6. Run `docker compose up -d --build`. Maven builds the Java jar in a build stage; the final image contains a Java 21 JRE and no Node runtime. Caddy exposes HTTPS; the app's port is private to the Docker network. Data lives in a persistent Docker volume. Never use `docker compose down -v` on a live installation.
7. Check container health/logs, HTTPS, sign-in/MFA, record counts and jobs. Remove OWNER_PASSWORD from `.env` after owner creation and recreate the app container; the hash remains in the database. JAVA_OPTS can tune JVM memory if workload monitoring justifies it.
8. Configure Gmail and a WhatsApp test integration. MESSAGING_MODE=live with ALLOW_LIVE_SENDS=false allows inbound/mailbox validation without outbound API sends. Enable sends only after the supervised launch gates pass.

The image runs as non-root on a read-only root filesystem; `/data` persists and `/tmp` is writable. The SQLite native library is packaged in the read-only image so it does not need executable temporary storage. The included Java health probe checks HTTP readiness without adding Node/curl to the runtime. EBS/file permissions protect SQLite records; this is not SQLCipher. Google/Meta processing is not guaranteed to stay in Canada.

BuildKit secrets `maven_settings` and `java_truststore` are optional for trusted-proxy development environments. They are temporary mounts, not copied into the image. A normal AWS/GitHub build uses the default public trust store. Verification is never disabled.

## Encrypted backup and recovery

```sh
cd /opt/mapledesk
docker compose exec -T app java -jar /app/app.jar --app.command=backup
```

The Java command creates a consistent SQLite snapshot, encrypts the schema-1 snapshot envelope with AES-256-GCM before uploading, and requests S3 encryption. The role can write only the mapledesk/ prefix. Public access is blocked; default retention is 30 days. The existing encrypted-envelope format is preserved. The pilot snapshot is encoded in memory, so monitor database size before growth warrants streaming/managed storage.

Copy infra/backup.service and infra/backup.timer into `/etc/systemd/system/`; run `systemctl daemon-reload` and `systemctl enable --now backup.timer`. Inspect the timer and service journal. It runs at 06:00 UTC daily with catch-up after downtime. Configure/test an external missing-backup/failure alert; EC2 status alarms alone do not detect failed backups or app problems.

Restore rehearsal:

1. Use an authorized operator role with S3 read access to download a backup. The app role intentionally cannot read/delete backups.
2. Configure the original DATA_KEY privately, then run `java -jar target/mapledesk-1.0.0.jar --app.command=restore --source=backup.enc --destination=NEW-DATABASE-PATH`. It refuses an existing destination, validates authenticated decryption and checks SQLite integrity. Restore does not boot the web application or initialize the live DB.
3. Start an isolated test deployment in mock mode using the restored database; inspect owner sign-in, clients, policies, messages and jobs. Decryption alone is not a recovery rehearsal.
4. For actual recovery, stop the app, preserve the current/damaged DB plus WAL/SHM, then install the verified database on a fresh volume with owner-only permissions. Do not mix old WAL/SHM files with a restored database.
5. Revoke sessions, inspect queued/running jobs against provider history, and keep live sends disabled until unknown outcomes are reconciled. Reconnect Gmail if tokens were revoked.

Keep DATA_KEY and MFA recovery information independently protected. Losing the key loses access to encrypted integration credentials and backups. Rollback to Node requires a pre-migration snapshot because upgraded Java password hashes are not readable by the old runtime.

## Remaining pilot limitations

One owner/business only; no production billing, AI inference, insurer sync/amendments, attachment processing, WhatsApp app-history/echo sync, public signup or self-service password recovery. Request detection is rule-based and needs manual inbox review. Manual WhatsApp handoff requires sending in the phone app, then owner confirmation; that is not verified delivery.

Gmail polls approximately every five minutes. The initial import is at most 20 recent inbox/sent messages from seven days. Single-recipient externally sent mail is reconciled; multi-recipient outbound threads remain in Gmail. A cursor gap raises a persistent warning and requires mailbox review. External sends do not infer sales outcomes.

Unknown send outcomes require provider-history review, not automatic resending. Retention/deletion procedures, independent monitoring, real provider acceptance and off-instance recovery must be completed before a real-client launch. CI validates builds/tests, not production deployment. Patch JVM, images and dependencies routinely, with backups before updates.
