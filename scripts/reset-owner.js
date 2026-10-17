"use strict";
const { config } = require("../backend/config"),
  { openDb } = require("../backend/db"),
  { hashPassword } = require("../backend/security");
const cfg = config();
if (!cfg.ownerEmail || cfg.ownerPassword.length < 14)
  throw new Error(
    "Set OWNER_EMAIL and a new OWNER_PASSWORD of at least 14 characters privately before running this command",
  );
const db = openDb(cfg.dbPath);
try {
  db.transaction(() => {
    const r = db
      .prepare("UPDATE users SET password_hash=?,last_totp=-1 WHERE email=?")
      .run(hashPassword(cfg.ownerPassword), cfg.ownerEmail);
    if (!r.changes) throw new Error("Owner not found");
    db.prepare("DELETE FROM sessions").run();
  })();
  console.log("Owner password reset and all sessions revoked.");
} finally {
  db.close();
}
