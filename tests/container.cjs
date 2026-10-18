"use strict";
const { execFileSync } = require("node:child_process"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const image = process.env.MAPLEDESK_IMAGE || "mapledesk:java";
const suffix = Date.now() + "-" + process.pid,
  name = "mapledesk-java-test-" + suffix,
  volume = name + "-data";
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
function totp(secret) {
  let buffer = 0,
    bits = 0;
  const bytes = [];
  for (const c of secret) {
    buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = crypto
      .createHmac("sha1", Buffer.from(bytes))
      .update(counter)
      .digest(),
    offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
(async () => {
  try {
    docker(["volume", "create", volume]);
    const env = [
      "APP_ENV=production",
      "PUBLIC_URL=https://broker.example",
      "OWNER_EMAIL=owner@example.com",
      "OWNER_PASSWORD=test-only-container-password!",
      "OWNER_TOTP_SECRET=JBSWY3DPEHPK3PXP",
      "DATA_KEY=" + "ab".repeat(32),
      "MESSAGING_MODE=mock",
      "ALLOW_LIVE_SENDS=false",
      "DB_PATH=/data/workspace.sqlite",
    ];
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--read-only",
      "--tmpfs",
      "/tmp:mode=1777",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "-p",
      "127.0.0.1::3000",
      "--mount",
      "type=volume,source=" + volume + ",target=/data",
      ...env.flatMap((v) => ["-e", v]),
      image,
    ]);
    const containerUrl = () =>
      "http://" + docker(["port", name, "3000"]).trim().split("\n")[0];
    let base = containerUrl();
    async function healthy() {
      for (let i = 0; i < 160; i++) {
        try {
          if (
            (
              await fetch(base + "/healthz", {
                signal: AbortSignal.timeout(1500),
              })
            ).ok
          )
            return;
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(
        "Java container readiness failed: " +
          docker(["logs", name]).split("\n").slice(-24).join("\n"),
      );
    }
    await healthy();
    docker([
      "exec",
      name,
      "java",
      "-Xmx32m",
      "-cp",
      "/app/health",
      "com.mapledesk.HealthProbe",
    ]);
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://broker.example",
    };
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "owner@example.com",
        password: "test-only-container-password!",
        code: totp("JBSWY3DPEHPK3PXP"),
      }),
    });
    assert.equal(login.status, 200);
    const data = await login.json();
    assert.match(login.headers.get("set-cookie"), /Secure/);
    headers.Cookie = login.headers.get("set-cookie").split(";")[0];
    headers["x-csrf-token"] = data.csrf;
    const created = await fetch(base + "/api/leads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contact: {
          name: "Container Test",
          email: "container@example.com",
          notes: "",
        },
        insurance_type: "Super Visa",
        due: "2026-11-01",
        interval_days: 2,
        channel: "email",
      }),
    });
    assert.equal(created.status, 201);
    console.log(
      "PASS Spring Boot production container: MFA sign-in and persisted client creation",
    );
    docker(["restart", name]);
    base = containerUrl();
    await healthy();
    const result = await fetch(base + "/api/state", { headers });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).leads.length, 1);
    assert.equal(
      docker(["inspect", "--format", "{{.Config.User}}", name]).trim(),
      "mapledesk",
    );
    console.log(
      "PASS Java non-root read-only container: records and session survive restart",
    );
  } finally {
    try {
      docker(["rm", "-f", name]);
    } catch {}
    try {
      docker(["volume", "rm", volume]);
    } catch {}
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
