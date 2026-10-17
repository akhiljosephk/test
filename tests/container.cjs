"use strict";
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const tag = process.env.MAPLEDESK_IMAGE || "mapledesk:pilot";
const suffix = Date.now() + "-" + process.pid,
  name = "mapledesk-test-" + suffix,
  volume = name + "-data";
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
async function healthy() {
  for (let n = 0; n < 40; n++) {
    try {
      docker([
        "exec",
        name,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("Container failed its readiness check");
}
(async () => {
  try {
    docker(["volume", "create", volume]);
    const env = [
      "NODE_ENV=production",
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
      "--mount",
      "type=volume,source=" + volume + ",target=/data",
      ...env.flatMap((e) => ["-e", e]),
      tag,
    ]);
    await healthy();
    const result = docker([
      "exec",
      name,
      "node",
      "-e",
      `(async()=>{const OTPAuth=require('otpauth');const code=new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(process.env.OWNER_TOTP_SECRET)}).generate();const headers={'Content-Type':'application/json',Origin:'https://broker.example'};const login=await fetch('http://127.0.0.1:3000/api/login',{method:'POST',headers,body:JSON.stringify({email:'owner@example.com',password:process.env.OWNER_PASSWORD,code})});if(!login.ok)throw new Error('Sign-in status '+login.status);const body=await login.json();headers.Cookie=login.headers.get('set-cookie').split(';')[0];headers['x-csrf-token']=body.csrf;const response=await fetch('http://127.0.0.1:3000/api/leads',{method:'POST',headers,body:JSON.stringify({contact:{name:'Container Test',email:'container@example.com',notes:''},insurance_type:'Super Visa',due:'2026-11-01',interval_days:2,channel:'email'})});if(response.status!==201)throw new Error('Create status '+response.status);console.log('created');})().catch(e=>{console.error(e.message);process.exit(1)})`,
    ]);
    assert.equal(result.trim(), "created");
    console.log(
      "PASS production-mode container: MFA sign-in and database-backed client creation",
    );
    docker(["restart", name]);
    await healthy();
    const count = docker([
      "exec",
      name,
      "node",
      "-e",
      "const db=new(require('better-sqlite3'))('/data/workspace.sqlite',{readonly:true});console.log(db.prepare('SELECT count(*) n FROM leads').get().n);db.close();",
    ]);
    assert.equal(count.trim(), "1");
    console.log(
      "PASS read-only non-root container: persistent data survives restart",
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
