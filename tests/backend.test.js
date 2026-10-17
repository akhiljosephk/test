"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { config } = require("../backend/config");
const { openDb, setting } = require("../backend/db");
const { createApp } = require("../backend/app");
const {
  inbound,
  schedule,
  today,
  plusDays,
  classify,
} = require("../backend/domain");
const { queueMessage, work } = require("../backend/worker");
const { encrypt, decrypt, sha } = require("../backend/security");
const {
  googleAuth,
  googleCallback,
  syncGmail,
  integration,
  storeIntegration,
} = require("../backend/integrations");
const PASSWORD = "test-only-long-password!";
async function fixture(t, extra = {}) {
  const cfg = {
    ...config({
      OWNER_EMAIL: "owner@example.com",
      OWNER_PASSWORD: PASSWORD,
      DATA_KEY: "ab".repeat(32),
      MESSAGING_MODE: "mock",
    }),
    now: () => new Date("2026-10-20T14:00:00Z"),
    ...extra,
  };
  const db = openDb(":memory:");
  const server = createApp(db, cfg).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  cfg.publicUrl = "http://127.0.0.1:" + server.address().port;
  let cookie = "",
    csrf = "";
  async function req(url, method = "GET", body, auth = true, headers = {}) {
    const res = await fetch(cfg.publicUrl + "/api" + url, {
      method,
      headers: {
        Origin: cfg.publicUrl,
        "Content-Type": "application/json",
        ...(auth ? { Cookie: cookie, "x-csrf-token": csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  const login = await req(
    "/login",
    "POST",
    { email: "owner@example.com", password: PASSWORD },
    false,
  );
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  csrf = login.body.csrf;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    db.close();
  });
  return { cfg, db, req, cookie, csrf };
}
const lead = (changes = {}) => ({
  contact: {
    name: "Joseph Mathew",
    email: "joseph@example.com",
    phone: "+14165550101",
    notes: "Parents visiting in December.",
    email_consent: true,
    whatsapp_consent: true,
    consent_note: "Recorded with client during test enquiry",
  },
  insurance_type: "Super Visa",
  status: "Quote sent",
  due: "2026-10-20",
  interval_days: 2,
  channel: "email",
  ...changes,
});
async function add(f, input = lead()) {
  const result = await f.req("/leads", "POST", input);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return f.db.prepare("SELECT * FROM leads WHERE id=?").get(result.body.id);
}

test("authentication, CSRF, origin checks and secret-free state", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req("/state", "GET", undefined, false)).status, 401);
  assert.equal(
    (
      await f.req(
        "/settings",
        "PATCH",
        { autoAck: true, reminders: true },
        true,
        { "x-csrf-token": "bad" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        "/settings",
        "PATCH",
        { autoAck: true, reminders: true },
        true,
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const result = await f.req("/state");
  assert.equal(result.status, 200);
  assert.equal(result.body.contacts.length, 0);
  assert.equal(JSON.stringify(result.body).includes(f.cfg.key), false);
  assert.equal((await f.req("/logout", "POST", {})).status, 200);
  assert.equal((await f.req("/state")).status, 401);
});

test("login throttles repeated invalid credentials", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await f.req(
          "/login",
          "POST",
          { email: "owner@example.com", password: "bad" },
          false,
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await f.req(
        "/login",
        "POST",
        { email: "owner@example.com", password: PASSWORD },
        false,
      )
    ).status,
    429,
  );
});

test("validated leads, durable consent evidence and cross-month scheduling", async (t) => {
  const f = await fixture(t);
  const l = await add(f);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM consent_events").get().n,
    2,
  );
  const bad = lead({ due: "2026-02-30" });
  assert.equal((await f.req("/leads", "POST", bad)).status, 400);
  assert.equal((await f.req("/leads", "PUT", bad)).status, 404);
  assert.equal(
    (
      await f.req(
        "/leads/" + l.id,
        "PUT",
        lead({ due: "2026-11-03", interval_days: 4 }),
      )
    ).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT due FROM leads WHERE id=?").get(l.id).due,
    "2026-11-03",
  );
  assert.equal((await f.req("/leads", "POST", lead())).status, 409);
});

test("new outbound consent requires a recorded source", async (t) => {
  const f = await fixture(t);
  const p = lead();
  p.contact.consent_note = "";
  assert.equal((await f.req("/leads", "POST", p)).status, 400);
  assert.equal(f.db.prepare("SELECT count(*) n FROM contacts").get().n, 0);
});

test("duplicate sends are idempotent and accepted follow-up moves due date", async (t) => {
  const f = await fixture(t);
  const l = await add(f),
    key = crypto.randomUUID(),
    body = {
      contactId: l.contact_id,
      channel: "email",
      text: "Hi Joseph, can I help with the quote?",
      purpose: "followup",
      leadId: l.id,
      key,
    };
  assert.equal((await f.req("/messages", "POST", body)).status, 202);
  assert.equal((await f.req("/messages", "POST", body)).status, 202);
  assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get().n, 1);
  await work(f.db, f.cfg);
  const saved = f.db.prepare("SELECT * FROM leads WHERE id=?").get(l.id);
  assert.equal(saved.due, "2026-10-22");
  assert.equal(saved.status, "Awaiting reply");
  assert.equal(
    f.db.prepare("SELECT status FROM messages").get().status,
    "simulated",
  );
  assert.equal(await work(f.db, f.cfg), false);
});

test("closing a lead or opting out after queueing blocks the send", async (t) => {
  const f = await fixture(t);
  const l = await add(f);
  queueMessage(f.db, f.cfg, {
    contactId: l.contact_id,
    channel: "email",
    text: "Check-in",
    purpose: "followup",
    leadId: l.id,
    key: "close-test",
  });
  f.db.prepare("UPDATE leads SET status='Won' WHERE id=?").run(l.id);
  await work(f.db, f.cfg);
  assert.equal(f.db.prepare("SELECT status FROM jobs").get().status, "failed");
  assert.equal(f.db.prepare("SELECT due FROM leads").get().due, "2026-10-20");
  assert.throws(
    () =>
      queueMessage(f.db, f.cfg, {
        contactId: l.contact_id,
        channel: "email",
        text: "Check-in",
        purpose: "followup",
        leadId: l.id,
        key: "blocked",
      }),
    /closed/,
  );
  f.db.prepare("UPDATE leads SET status='Quote sent'").run();
  queueMessage(f.db, f.cfg, {
    contactId: l.contact_id,
    channel: "email",
    text: "Check-in",
    key: "optout-test",
  });
  inbound(f.db, f.cfg, {
    channel: "email",
    address: "joseph@example.com",
    eventId: "stop-1",
    text: "Please stop messaging me.",
  });
  await work(f.db, f.cfg);
  assert.equal(
    f.db.prepare("SELECT status FROM jobs WHERE dedupe_key='optout-test'").get()
      .status,
    "failed",
  );
});

test("incoming change detection deduplicates events and creates receipt-only acknowledgement", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE settings SET value='true' WHERE key='autoAck'").run();
  const p = {
    channel: "email",
    address: "emma@example.com",
    name: "Emma Wilson",
    eventId: "gmail:in-1",
    text: "My DOB needs a correction.",
  };
  const r = inbound(f.db, f.cfg, p);
  assert.ok(r.requestId);
  assert.equal(inbound(f.db, f.cfg, p).duplicate, true);
  assert.equal(f.db.prepare("SELECT count(*) n FROM requests").get().n, 1);
  await work(f.db, f.cfg);
  const m = f.db.prepare("SELECT * FROM messages WHERE direction='out'").get();
  assert.match(m.text, /not been changed/);
  assert.equal(m.status, "simulated");
});

test("historical and automated emails never trigger an automatic reply", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE settings SET value='true' WHERE key='autoAck'").run();
  inbound(f.db, f.cfg, {
    channel: "email",
    address: "old@example.com",
    eventId: "old",
    text: "Please update my address",
    historical: true,
  });
  inbound(f.db, f.cfg, {
    channel: "email",
    address: "robot@example.com",
    eventId: "auto",
    text: "Please update my address",
    automated: true,
  });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM messages WHERE direction='out'").get()
      .n,
    0,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM requests").get().n, 1);
});

test("WhatsApp signature and phone-number scope are enforced", async (t) => {
  const f = await fixture(t, {
    waAppSecret: "test-webhook-secret",
    waPhoneId: "123",
    waVerifyToken: "test-verify-token",
  });
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "123" },
              contacts: [{ wa_id: "14165550101", profile: { name: "Joseph" } }],
              messages: [
                {
                  id: "wa-in-1",
                  from: "14165550101",
                  timestamp: String(f.cfg.now().getTime() / 1000),
                  type: "text",
                  text: { body: "Please change my address" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload),
    signature =
      "sha256=" +
      crypto.createHmac("sha256", f.cfg.waAppSecret).update(raw).digest("hex");
  let res = await fetch(f.cfg.publicUrl + "/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": "bad",
    },
    body: raw,
  });
  assert.equal(res.status, 403);
  res = await fetch(f.cfg.publicUrl + "/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": signature,
    },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal(f.db.prepare("SELECT count(*) n FROM requests").get().n, 1);
  res = await fetch(
    f.cfg.publicUrl +
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=hello",
  );
  assert.equal(await res.text(), "hello");
});

test("WhatsApp outside service window requires approved template with matching preview", async (t) => {
  const f = await fixture(t, {
    templates: [
      {
        name: "renewal",
        language: "en",
        body: "Hi {{1}}, renewal is due {{2}}.",
        parameters: ["Name", "Date"],
      },
    ],
  });
  const l = await add(f);
  assert.throws(
    () =>
      queueMessage(f.db, f.cfg, {
        contactId: l.contact_id,
        channel: "whatsapp",
        text: "Hello",
        key: "no-template",
      }),
    /template/,
  );
  const template = {
    name: "renewal",
    language: "en",
    parameters: ["Joseph", "Nov 19"],
  };
  const r = queueMessage(f.db, f.cfg, {
    contactId: l.contact_id,
    channel: "whatsapp",
    text: "Hi Joseph, renewal is due Nov 19.",
    template,
    key: "template",
  });
  await work(f.db, f.cfg);
  assert.equal(
    f.db.prepare("SELECT status FROM messages WHERE id=?").get(r.messageId)
      .status,
    "simulated",
  );
});

test("policy reminders are unique, dates validated, and stale policy drafts cancelled", async (t) => {
  const f = await fixture(t);
  const l = await add(f);
  const body = {
    contact_id: l.contact_id,
    number: "ML-100",
    insurer: "Manulife",
    insurance_type: "Super Visa",
    effective: "2026-10-27",
    expiry: "2026-11-19",
  };
  assert.equal((await f.req("/policies", "POST", body)).status, 201);
  assert.equal(schedule(f.db, f.cfg), 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM jobs").get().n, 2);
  f.db.prepare("UPDATE policies SET expiry='2026-12-01'").run();
  await work(f.db, f.cfg);
  await work(f.db, f.cfg);
  const jobs = f.db.prepare("SELECT * FROM jobs").all();
  assert.equal(jobs.filter((j) => j.status === "draft").length, 1);
  assert.equal(jobs.filter((j) => j.status === "cancelled").length, 1);
  assert.equal(
    (
      await f.req("/policies", "POST", {
        ...body,
        number: "bad",
        expiry: "2026-01-01",
      })
    ).status,
    400,
  );
});

test("CSV import previews errors and commits all-or-nothing", async (t) => {
  const f = await fixture(t);
  await add(f);
  const header = "email,number,insurer,insurance_type,effective,expiry\n";
  const valid =
    "joseph@example.com,CSV-1,Manulife,Super Visa,2026-10-20,2027-10-20\n";
  const bad =
    "unknown@example.com,CSV-2,Manulife,Super Visa,2026-10-20,2027-10-20\n";
  let r = await f.req("/policies/import", "POST", {
    csv: header + valid + bad,
    confirm: false,
  });
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.errors.length, 1);
  r = await f.req("/policies/import", "POST", {
    csv: header + valid + bad,
    confirm: true,
  });
  assert.equal(r.status, 400);
  assert.equal(f.db.prepare("SELECT count(*) n FROM policies").get().n, 0);
  r = await f.req("/policies/import", "POST", {
    csv: header + valid,
    confirm: true,
  });
  assert.equal(r.body.imported, 1);
  r = await f.req("/policies/import", "POST", {
    csv: header + valid,
    confirm: false,
  });
  assert.equal(r.body.errors.length, 1);
});

test("live mode cannot simulate or send until credentials and send switch are ready", async (t) => {
  const f = await fixture(t, { mode: "live", liveSends: false });
  const l = await add(f);
  assert.equal((await f.req("/simulate", "POST", {})).status, 404);
  const r = await f.req("/messages", "POST", {
    contactId: l.contact_id,
    channel: "email",
    text: "Hello",
    key: crypto.randomUUID(),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /disabled/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get().n, 0);
});

test("ambiguous provider outcomes are held for review, not retried", async (t) => {
  const f = await fixture(t);
  const l = await add(f);
  queueMessage(f.db, f.cfg, {
    contactId: l.contact_id,
    channel: "email",
    text: "Hello",
    key: "ambiguous",
  });
  f.cfg.mode = "live";
  f.cfg.liveSends = true;
  f.cfg.gmailAddress = "owner@example.com";
  storeIntegration(
    f.db,
    f.cfg,
    "gmail",
    {
      access_token: "test-access-token",
      expires_at: Date.now() + 3600000,
      refresh_token: "test-refresh-token",
    },
    { address: "owner@example.com" },
  );
  let calls = 0;
  f.cfg.fetch = async () => {
    calls++;
    throw new Error("socket disconnected");
  };
  await work(f.db, f.cfg);
  assert.equal(
    f.db.prepare("SELECT status FROM jobs").get().status,
    "needs_review",
  );
  assert.equal(await work(f.db, f.cfg), false);
  assert.equal(calls, 1);
});

test("Gmail OAuth state is session-bound, single-use, PKCE-protected and encrypted", async (t) => {
  const f = await fixture(t, {
    googleClientId: "test-client",
    googleClientSecret: "test-secret",
    gmailAddress: "owner@gmail.com",
  });
  const url = new URL(googleAuth(f.db, f.cfg, "session-one"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state");
  await assert.rejects(
    () =>
      googleCallback(f.db, f.cfg, {
        code: "test-code",
        state,
        sessionHash: "wrong-session",
      }),
    /expired|invalid/,
  );
  f.cfg.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("/token")
          ? {
              access_token: "test-access",
              refresh_token: "test-refresh",
              expires_in: 3600,
            }
          : { emailAddress: "owner@gmail.com", historyId: "100" },
      ),
      { status: 200 },
    );
  await googleCallback(f.db, f.cfg, {
    code: "test-code",
    state,
    sessionHash: "session-one",
  });
  const stored = f.db
    .prepare("SELECT secret FROM integrations WHERE name='gmail'")
    .get().secret;
  assert.equal(stored.includes("test-refresh"), false);
  assert.equal(
    integration(f.db, f.cfg, "gmail").metadata.address,
    "owner@gmail.com",
  );
  await assert.rejects(
    () =>
      googleCallback(f.db, f.cfg, {
        code: "test-code",
        state,
        sessionHash: "session-one",
      }),
    /expired|invalid/,
  );
});

test("Gmail sync imports historical messages without auto-reply and advances incremental cursor", async (t) => {
  const f = await fixture(t, { gmailAddress: "owner@gmail.com" });
  storeIntegration(
    f.db,
    f.cfg,
    "gmail",
    {
      access_token: "test-access",
      expires_at: Date.now() + 3600000,
      refresh_token: "test-refresh",
    },
    { address: "owner@gmail.com", historyId: "100", initialSync: true },
  );
  f.db.prepare("UPDATE settings SET value='true' WHERE key='autoAck'").run();
  f.cfg.fetch = async (url) => {
    const s = String(url);
    let result;
    if (s.includes("/messages?")) result = { messages: [{ id: "one" }] };
    else if (s.includes("/messages/"))
      result = {
        id: s.includes("/two?") ? "two" : "one",
        threadId: "thread-1",
        internalDate: String(f.cfg.now().getTime()),
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Emma <emma@example.com>" },
            { name: "Subject", value: "Address change" },
            { name: "Message-Id", value: "<test@example.com>" },
          ],
          body: {
            data: Buffer.from("Please update my address").toString("base64url"),
          },
        },
      };
    else
      result = {
        historyId: "102",
        history: [{ messagesAdded: [{ message: { id: "two" } }] }],
      };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await syncGmail(f.db, f.cfg);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM messages WHERE direction='out'").get()
      .n,
    0,
  );
  await syncGmail(f.db, f.cfg);
  assert.equal(integration(f.db, f.cfg, "gmail").metadata.historyId, "102");
  assert.equal(f.db.prepare("SELECT count(*) n FROM requests").get().n, 2);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM messages WHERE direction='out'").get()
      .n,
    1,
  );
  await syncGmail(f.db, f.cfg);
  assert.equal(f.db.prepare("SELECT count(*) n FROM requests").get().n, 2);
});

test("encryption detects tampering; snapshots reopen with durable records", async () => {
  const key = "ab".repeat(32),
    encrypted = encrypt({ token: "test-token" }, key);
  assert.equal(decrypt(encrypted, key).token, "test-token");
  assert.throws(() => decrypt(encrypted.slice(0, -2) + "ff", key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-test-"));
  try {
    const file = path.join(dir, "db.sqlite"),
      backup = path.join(dir, "backup.sqlite");
    let db = openDb(file);
    db.prepare("UPDATE settings SET value='true' WHERE key='autoAck'").run();
    await db.backup(backup);
    db.close();
    db = openDb(backup);
    assert.equal(setting(db, "autoAck"), true);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Toronto dates and request rules are deterministic", () => {
  const cfg = {
    timezone: "America/Toronto",
    now: () => new Date("2026-11-01T03:30:00Z"),
  };
  assert.equal(today(cfg), "2026-10-31");
  assert.equal(plusDays(today(cfg), 2), "2026-11-02");
  assert.equal(
    classify("Can you change my policy date?"),
    "Policy date change",
  );
  assert.equal(
    classify("Please correct my phone number"),
    "Phone number update",
  );
  assert.equal(classify("Thanks for the quote!"), null);
});

test("a scheduled reminder cannot be sent twice with different browser request keys", async (t) => {
  const f = await fixture(t);
  const l = await add(f);
  const r = await f.req("/policies", "POST", {
    contact_id: l.contact_id,
    number: "UNIQUE-REMINDER",
    insurer: "Manulife",
    insurance_type: "Super Visa",
    effective: "2025-11-19",
    expiry: "2026-11-19",
  });
  assert.equal(r.status, 201);
  await work(f.db, f.cfg);
  const job = f.db.prepare("SELECT * FROM jobs WHERE type='reminder'").get();
  const body = {
    contactId: l.contact_id,
    channel: "email",
    text: "A reminder about your renewal.",
    purpose: "reminder",
    policyId: r.body.id,
    event: "expiry",
    reminderJobId: job.id,
    key: crypto.randomUUID(),
  };
  assert.equal((await f.req("/messages", "POST", body)).status, 202);
  assert.equal(
    (await f.req("/messages", "POST", { ...body, key: crypto.randomUUID() }))
      .status,
    202,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get().n, 1);
  await work(f.db, f.cfg);
  assert.equal(
    f.db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "done",
  );
});

test("production sign-in requires MFA, rejects replay, and sets secure session cookies", async (t) => {
  const secret = "JBSWY3DPEHPK3PXP",
    OTPAuth = require("otpauth");
  const f = await fixture(t);
  f.cfg.production = true;
  f.cfg.totpSecret = secret;
  const token = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  let r = await f.req(
    "/login",
    "POST",
    { email: "owner@example.com", password: PASSWORD, code: token },
    false,
  );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /Secure/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Lax/);
  r = await f.req(
    "/login",
    "POST",
    { email: "owner@example.com", password: PASSWORD, code: token },
    false,
  );
  assert.equal(r.status, 401);
});

test("restore command verifies encrypted snapshot and refuses an existing destination", async () => {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-restore-"));
  try {
    const source = path.join(dir, "source.sqlite"),
      snapshot = path.join(dir, "snapshot.sqlite"),
      encrypted = path.join(dir, "backup.enc"),
      restored = path.join(dir, "restored.sqlite"),
      key = "ab".repeat(32);
    const db = openDb(source);
    db.prepare("UPDATE settings SET value='true' WHERE key='autoAck'").run();
    await db.backup(snapshot);
    db.close();
    fs.writeFileSync(
      encrypted,
      encrypt(
        { sqlite: fs.readFileSync(snapshot).toString("base64"), schema: 1 },
        key,
      ),
    );
    const options = {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, NODE_ENV: "development", DATA_KEY: key },
      stdio: "pipe",
    };
    execFileSync(
      process.execPath,
      ["scripts/restore.js", encrypted, restored],
      options,
    );
    const out = openDb(restored);
    assert.equal(setting(out, "autoAck"), true);
    out.close();
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["scripts/restore.js", encrypted, restored],
        options,
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manual WhatsApp handoff preserves the phone workflow without pretending to deliver", async (t) => {
  const f = await fixture(t, { mode: "live", liveSends: false });
  const l = await add(f);
  const body = {
    contactId: l.contact_id,
    channel: "whatsapp",
    text: "Hi Joseph, happy to help with your Super Visa options.",
    purpose: "followup",
    leadId: l.id,
    key: crypto.randomUUID(),
  };
  const r = await f.req("/whatsapp/handoff", "POST", body);
  assert.equal(r.status, 201);
  assert.match(r.body.url, /^https:\/\/wa.me\/14165550101\?text=/);
  assert.equal(
    f.db.prepare("SELECT status FROM messages").get().status,
    "handoff",
  );
  assert.equal(f.db.prepare("SELECT due FROM leads").get().due, "2026-10-20");
  assert.equal(await work(f.db, f.cfg), false);
  assert.equal(
    (
      await f.req(
        "/messages/" + r.body.messageId + "/confirm-manual",
        "POST",
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT status FROM messages").get().status,
    "manual_sent",
  );
  assert.equal(f.db.prepare("SELECT due FROM leads").get().due, "2026-10-22");
  assert.equal(
    (
      await f.req(
        "/messages/" + r.body.messageId + "/confirm-manual",
        "POST",
        {},
      )
    ).status,
    400,
  );
  f.db.prepare("UPDATE contacts SET opted_out=1").run();
  assert.equal(
    (
      await f.req("/whatsapp/handoff", "POST", {
        ...body,
        key: crypto.randomUUID(),
      })
    ).status,
    400,
  );
});

test("Gmail replies sent outside the CRM sync once without creating tasks or sending replies", async (t) => {
  const f = await fixture(t, { gmailAddress: "owner@gmail.com" });
  storeIntegration(
    f.db,
    f.cfg,
    "gmail",
    {
      access_token: "test-access",
      expires_at: Date.now() + 3600000,
      refresh_token: "test-refresh",
    },
    { address: "owner@gmail.com", historyId: "100", initialSync: true },
  );
  f.cfg.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("/messages?")
          ? { messages: [{ id: "external" }] }
          : String(url).includes("/history?")
            ? {
                historyId: "101",
                history: [{ messagesAdded: [{ message: { id: "external" } }] }],
              }
            : {
                id: "external",
                threadId: "gmail-thread",
                internalDate: String(f.cfg.now().getTime()),
                labelIds: ["SENT"],
                payload: {
                  mimeType: "text/plain",
                  headers: [
                    { name: "From", value: "Owner <owner@gmail.com>" },
                    { name: "To", value: "Joseph <joseph@example.com>" },
                    { name: "Subject", value: "Your coverage options" },
                  ],
                  body: {
                    data: Buffer.from(
                      "Hi Joseph, here are the options we discussed.",
                    ).toString("base64url"),
                  },
                },
              },
      ),
      { status: 200 },
    );
  await syncGmail(f.db, f.cfg);
  await syncGmail(f.db, f.cfg);
  assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get().n, 1);
  assert.equal(
    f.db.prepare("SELECT status FROM messages").get().status,
    "sent_external",
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM requests").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM jobs").get().n, 0);
});
