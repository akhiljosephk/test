"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { config } = require("../backend/config");
const { openDb } = require("../backend/db");
const { encrypt } = require("../backend/security");
async function backup(cfg) {
  if (!cfg.key || !cfg.backupBucket)
    throw new Error("DATA_KEY and BACKUP_BUCKET are required");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mapledesk-backup-"));
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, "snapshot.sqlite");
  const db = openDb(cfg.dbPath);
  try {
    await db.backup(file);
    const raw = await fs.readFile(file);
    const encrypted = Buffer.from(
      encrypt({ sqlite: raw.toString("base64"), schema: 1 }, cfg.key),
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key =
      cfg.backupPrefix +
      stamp +
      "-" +
      crypto.randomBytes(4).toString("hex") +
      ".enc";
    await new S3Client({ region: cfg.awsRegion }).send(
      new PutObjectCommand({
        Bucket: cfg.backupBucket,
        Key: key,
        Body: encrypted,
        ContentType: "application/octet-stream",
        ServerSideEncryption: "AES256",
      }),
    );
    console.log("Encrypted backup uploaded successfully.");
    return key;
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
if (require.main === module)
  backup(config()).catch((e) => {
    console.error("Backup failed: " + e.name);
    process.exitCode = 1;
  });
module.exports = { backup };
