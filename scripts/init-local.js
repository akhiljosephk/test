"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { config } = require("../backend/config");
const { openDb } = require("../backend/db");
const { bootstrapOwner } = require("../backend/security");
if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD)
  throw new Error(
    "Set OWNER_EMAIL and OWNER_PASSWORD privately in the terminal first",
  );
if (fs.existsSync(".env"))
  throw new Error(
    ".env already exists; refusing to replace it. Use existing environment settings.",
  );
const key = crypto.randomBytes(32).toString("hex");
const cfg = config({ ...process.env, DATA_KEY: key });
const db = openDb(cfg.dbPath);
try {
  if (db.prepare("SELECT count(*) n FROM users").get().n)
    throw new Error("Owner already exists; refusing to change credentials");
  bootstrapOwner(db, cfg);
  fs.writeFileSync(
    ".env",
    `NODE_ENV=development\nPORT=3000\nPUBLIC_URL=http://localhost:3000\nDATA_KEY=${key}\nMESSAGING_MODE=mock\nALLOW_LIVE_SENDS=false\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Owner provisioned and .env created. No sample clients were added. Start with npm start.",
  );
} finally {
  db.close();
}
