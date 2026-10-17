"use strict";
process.umask(0o077);
const { config } = require("./backend/config");
const { openDb } = require("./backend/db");
const { createApp } = require("./backend/app");
const { startWorker } = require("./backend/worker");
const cfg = config(),
  db = openDb(cfg.dbPath),
  app = createApp(db, cfg);
const worker = startWorker(db, cfg);
const server = app.listen(cfg.port, "0.0.0.0", () =>
  console.log(
    `MapleDesk listening on port ${cfg.port}; messaging mode: ${cfg.mode}`,
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    worker.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
