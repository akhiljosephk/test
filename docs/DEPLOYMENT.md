# Deployment and operations runbook

## Local development (Node.js 24+)

```sh
npm ci
# In Bash, read the initial password without putting it in shell history:
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -s -p 'Initial owner password (14+ characters): ' OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
npm run setup:local
unset OWNER_PASSWORD OWNER_EMAIL
npm start
```

The setup command creates a private `.env` with a generated encryption key and an owner password hash in `data/mapledesk.sqlite`. It refuses to overwrite an existing environment or owner. The initial workspace is empty. Use mock delivery and synthetic records first. Linux source builds of SQLite may require Python 3, make and a C++ compiler; the Docker build includes its own build toolchain. In restricted cloud workspaces, set XDG_CACHE_HOME and npm_package_config_node_gyp_devdir to writable paths before npm ci. No account credentials are needed for local workflows. Keep `.env` and database files private; neither belongs in Git.

The password in the OWNER_PASSWORD environment variable is for initial provisioning only. On an existing database changing this variable does not change the password. To reset an owner password, set OWNER_EMAIL/OWNER_PASSWORD privately and run `node --env-file-if-exists=.env scripts/reset-owner.js`; all sessions are revoked. MFA recovery is an operator procedure: rotate OWNER_TOTP_SECRET securely, revoke sessions using the reset command, and restart the application. There is no public password-reset email endpoint.

Tests:

```sh
npm run check
npx playwright install chromium  # when no existing Chromium is available
npm test
npm run export                 # refresh the original self-contained visual prototype only
```

The backend and workspace tests use temporary databases, known test-only credentials, and simulated provider responses. They never need real Gmail, Meta or AWS accounts. Existing Chromium can be selected through PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.

## AWS resources (not yet deployed)

The Terraform configuration creates a dedicated VPC/public subnet, one small x86 Ubuntu EC2 instance, encrypted gp3 storage, an Elastic IP, a private backup bucket, minimal S3-write/SSM instance permissions, an instance-health alarm, an email topic subscription, and a budget alert. It does not create a load balancer, NAT gateway, RDS, or Redis. Port 22 is closed; administration is through AWS Systems Manager Session Manager. Outbound internet is available for Google/Meta and package updates.

Create the AWS account with MFA, choose a billing alert recipient, authenticate with an appropriate short-lived operator role, and use:

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit recipient, region, budget and instance size; never put credentials here.
terraform init
terraform plan -out=reviewed.tfplan
# Review resources and charges before applying the concrete plan.
terraform apply reviewed.tfplan
```

Terraform state is sensitive operational information; do not commit it or plan files. For a real deployment use a secured encrypted remote backend with locking and restricted access. The provider lock file is committed. The root EBS volume is deliberately retained on termination; it continues to incur charges until you securely retire it. Do not run `terraform destroy` as a backup or routine update procedure. Budget alerts do not cap spend. Confirm the SNS email subscription for health alarms.

The application server is a single point of failure. Backups and monitoring reduce recovery effort but provide no high-availability guarantee. Do not run multiple independent SQLite replicas. Avoid Docker volumes on network filesystems.

## Install application and HTTPS

1. Point an owned DNS A record at the Terraform Elastic IP. Configure a supported production domain, not a localhost URL.
2. Through Session Manager, use an administrator shell (for example, `sudo -i`) for provisioning and verify cloud-init completed (`cloud-init status --wait`), Docker/Compose are installed, and `/opt/mapledesk` exists.
3. Transfer a reviewed release from GitHub to `/opt/mapledesk`. Use a scoped HTTPS Git credential or a release archive; never bake credentials into the Docker image or clone URL. Verify the commit before deployment.
4. Create `/opt/mapledesk/.env`, owned by the administrator with mode 600, using `.env.example` as a guide. Set APP_DOMAIN to the DNS hostname, PUBLIC_URL to its HTTPS origin, NODE_ENV=production, a random 32-byte hex DATA_KEY, the initial OWNER_EMAIL/OWNER_PASSWORD, and a base32 OWNER_TOTP_SECRET enrolled into the owner's authenticator securely. Production refuses to boot without MFA configuration. Record the MFA seed, encryption key and recovery procedure in a secure password manager independent of the instance.
5. Set MESSAGING_MODE=mock and ALLOW_LIVE_SENDS=false initially. Set BACKUP_BUCKET to the Terraform output and AWS_REGION=ca-central-1. Leave the default BACKUP_PREFIX=mapledesk/. Do not set static AWS keys: backups use the instance role via IMDSv2.
6. Run `docker compose up -d --build`. The app port is private to the Docker network; Caddy exposes 80/443 and obtains a TLS certificate after DNS is valid. Application data is a persistent Docker volume. Do not use `docker compose down -v` on a live installation.
7. Check `docker compose ps`, `docker compose logs --tail=50 app`, the HTTPS health endpoint, login/MFA, and the empty workspace. After owner creation, remove OWNER_PASSWORD from `.env` and recreate the app container. Existing database users are retained.
8. Connect Gmail and configure a test WhatsApp API number. Switch MESSAGING_MODE=live to test inbound/sync while ALLOW_LIVE_SENDS=false prevents sends. Enable outgoing sends only after the supervised checks in SINGLE-BROKER-LAUNCH.md.

Do not paste secrets into commands saved in shell history, GitHub issues or chat. DATA_KEY encrypts stored Google tokens and backups; changing it without migrating encrypted data loses access to both. SQLite records themselves rely on host/EBS encryption and file permissions, not SQLCipher. AWS hosting does not keep Google/Meta processing exclusively in Canada.

The optional Docker BuildKit `proxy_ca` secret is only for development environments with an existing trusted enterprise proxy. Supply the legitimate CA using a secret mount if needed; it is not copied into the image. No TLS, checksum or package-signature verification is disabled.

## Backups and recovery

After BACKUP_BUCKET is configured:

```sh
cd /opt/mapledesk
docker compose exec -T app node scripts/backup.js
```

This uses SQLite's online backup API to create a consistent snapshot, encrypts it with AES-256-GCM before upload, and requests S3 server-side encryption. The instance can write only the mapledesk/ prefix. The bucket blocks public access and has a 30-day retention rule by default. There is no DB attachment storage in this release. Backups currently encode the small pilot snapshot in memory; monitor database size and upgrade to streaming backup/managed database before growth threatens instance memory.

Copy infra/backup.service and infra/backup.timer to `/etc/systemd/system/` and run `systemctl daemon-reload` followed by `systemctl enable --now backup.timer`. Check `systemctl list-timers backup.timer` and `journalctl -u backup.service`. The files assume `/opt/mapledesk` is the deployment directory. The timer schedules 06:00 UTC daily and catches up after downtime. Configure an external check/alert for failed or missing backups; the provided EC2 health alarm alone does not detect failed backups or application-level failures.

Restore rehearsal, using an operator role with separate read access (the application role intentionally cannot download/delete backups):

1. Download one encrypted backup using authorized S3 access and copy it to a secure local/server location.
2. With the original DATA_KEY configured securely, run `node --env-file=.env scripts/restore.js backup.enc NEW-DATABASE-PATH`. The command refuses to overwrite a destination and verifies SQLite integrity.
3. Start a separate test instance/database in mock mode with no provider sending and verify contacts, policies, audit records and sign-in. Successful decryption alone is not a full recovery test.
4. For an actual recovery, stop the application, preserve the damaged/current database and its WAL/SHM files, install the verified restored database with owner-only permissions, and remove stale WAL/SHM from the destination only while stopped. Prefer a new volume to avoid mixing histories.
5. Revoke existing sessions, inspect queued/running send jobs against provider history, and keep live sends disabled until unknown outcomes are reconciled. Reconnect Gmail if restored tokens have been revoked.

Keep at least one independently protected copy of DATA_KEY and the MFA recovery information. The instance and an encrypted backup without the key are insufficient for recovery.

## Known operating limits

- The workspace is for one brokerage/owner. It is not ready to host multiple independent businesses in one database.
- There is no production subscription billing, AI inference, insurer login/sync, automatic policy amendment, attachment processing or WhatsApp phone-app history/echo synchronization.
- A manual WhatsApp handoff is available without an API account: prepare the draft, send it in the existing phone app, then confirm the manual send in the inbox. That confirmation is not provider verification. Most API sends are reviewed by the broker. Enabled acknowledgements can run automatically, but confirm receipt only. Rule-based request detection can miss messages; keep an inbox-review routine.
- There is no automatic retry button for unknown send outcomes. Inspect provider history, reconcile, then consciously compose a replacement if required. Explicit rate-limit responses get bounded backoff; ambiguous operations require review.
- Automatic Gmail sync polls every five minutes. Initial import is intentionally limited; cursor expiry raises a gap warning. Manual sync is also available.
- Public signup, self-service password recovery, contact deletion/retention automation and comprehensive operator alerting need further work before a broader commercial rollout. Define the broker's retention/deletion procedure before real-client use.
- Dependencies and images need routine patching; the CI workflow checks builds/tests but does not deploy automatically. After updates take a backup, rebuild, and verify the release before allowing live sends.
