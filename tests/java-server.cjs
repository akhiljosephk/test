"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  net = require("node:net");
const java =
  process.env.JAVA_BIN ||
  (process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", "java")
    : "java");
async function startJava() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapledesk-java-browser-"));
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const base = "http://127.0.0.1:" + port,
    log = path.join(dir, "server.log"),
    fd = fs.openSync(log, "w");
  const child = spawn(
    java,
    [
      "-Xmx384m",
      "-jar",
      path.resolve(__dirname, "../target/mapledesk-1.0.0.jar"),
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        APP_ENV: "development",
        PORT: String(port),
        PUBLIC_URL: base,
        OWNER_EMAIL: "owner@example.com",
        OWNER_PASSWORD: "test-only-password-long!",
        DATA_KEY: "ab".repeat(32),
        OWNER_TOTP_SECRET: "",
        DB_PATH: path.join(dir, "test.sqlite"),
        MESSAGING_MODE: "mock",
        ALLOW_LIVE_SENDS: "false",
        APP_TEST_NOW: "2026-10-20T14:00:00Z",
        WORKER_DELAY_MS: "100",
      },
      stdio: ["ignore", fd, fd],
    },
  );
  fs.closeSync(fd);
  process.once("exit", () => child.kill());
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(base + "/healthz")).ok)
        return { base, child, dir, stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const output = fs.readFileSync(log, "utf8").split("\n").slice(-18).join("\n");
  await stop();
  throw new Error("Java application did not become ready:\n" + output);
}
module.exports = { startJava };
