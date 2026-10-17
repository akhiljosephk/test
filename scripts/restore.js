"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { decrypt } = require("../backend/security");
const { config } = require("../backend/config");
const cfg = config(),
  [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    "Usage: node --env-file=.env scripts/restore.js encrypted-backup.enc NEW-DATABASE-PATH",
  );
if (fs.existsSync(destination) || fs.existsSync(destination + "-wal"))
  throw new Error(
    "Destination must be a new path. Stop the application before swapping databases.",
  );
const value = decrypt(fs.readFileSync(source, "utf8"), cfg.key);
if (value.schema !== 1) throw new Error("Unsupported backup schema");
fs.mkdirSync(path.dirname(path.resolve(destination)), {
  recursive: true,
  mode: 0o700,
});
fs.writeFileSync(destination, Buffer.from(value.sqlite, "base64"), {
  mode: 0o600,
  flag: "wx",
});
const db = new Database(destination, { readonly: true });
try {
  if (db.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("Restored database integrity check failed");
} finally {
  db.close();
}
console.log(
  "Restored database verified. Review the runbook before replacing the live database.",
);
