"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { config } = require("../backend/config"),
  { openDb } = require("../backend/db"),
  { createApp } = require("../backend/app"),
  { startWorker } = require("../backend/worker");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapledesk-ui-"));
  const cfg = {
    ...config({
      OWNER_EMAIL: "owner@example.com",
      OWNER_PASSWORD: "test-only-password-long!",
      DATA_KEY: "ab".repeat(32),
      MESSAGING_MODE: "mock",
    }),
    dbPath: path.join(dir, "test.sqlite"),
    now: () => new Date("2026-10-20T14:00:00Z"),
  };
  const db = openDb(cfg.dbPath),
    server = createApp(db, cfg).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  cfg.publicUrl = "http://127.0.0.1:" + server.address().port;
  const worker = startWorker(db, cfg);
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(cfg.publicUrl);
    await page.locator('#login-form [name="email"]').fill("owner@example.com");
    await page.locator('[name="password"]').fill("test-only-password-long!");
    await page.locator("#login-form button").click();
    await page
      .getByRole("heading", { name: "A little clarity. A better day." })
      .waitFor();
    const action = async (a) =>
      page.locator(`[data-action="${a}"]`).first().click();
    const nav = async (p) => page.locator(`#nav [data-page="${p}"]`).click();
    const formSubmit = async (f) =>
      page.locator(`#${f} button[type="submit"]`).click();
    await action("lead");
    await page.locator('[name="name"]').fill("Joseph Mathew");
    await page.locator('[name="email"]').fill("joseph@example.com");
    await page.locator('[name="phone"]').fill("+14165550101");
    await page.locator('[name="notes"]').fill("Parents visiting in December.");
    await page.locator('[name="email_consent"]').check();
    await page.locator('[name="whatsapp_consent"]').check();
    await page
      .locator('[name="consent_note"]')
      .fill("Client agreed by email on October 20.");
    await formSubmit("lead-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(db.prepare("SELECT count(*) n FROM contacts").get().n, 1);
    console.log(
      "PASS owner login and persistent client creation with consent evidence",
    );
    await nav("leads");
    await action("followup");
    await page
      .locator('#send-form [name="text"]')
      .fill("Hi Joseph, happy to answer your Super Visa questions.");
    await formSubmit("send-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await worker.tick();
    await action("refresh");
    assert.equal(db.prepare("SELECT due FROM leads").get().due, "2026-10-22");
    await nav("inbox");
    await page
      .getByText("Hi Joseph, happy to answer your Super Visa questions.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      db.prepare("SELECT status FROM messages").get().status,
      "simulated",
    );
    console.log(
      "PASS UI queues simulated Gmail follow-up and worker schedules next action",
    );
    await nav("settings");
    await page.locator('[name="autoAck"]').check();
    await page.locator("#settings-form button").click();
    await page
      .getByText("Automation settings saved.", { exact: true })
      .waitFor();
    await nav("inbox");
    await action("simulate");
    await page.locator('[name="name"]').fill("Emma Wilson");
    await page.locator('[name="address"]').fill("emma@example.com");
    await page
      .locator('[name="text"]')
      .fill("My date of birth needs a correction.");
    await formSubmit("simulate-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await worker.tick();
    await action("refresh");
    assert.equal(db.prepare("SELECT count(*) n FROM requests").get().n, 1);
    assert.match(
      db
        .prepare(
          "SELECT text FROM messages WHERE direction='out' ORDER BY created_at DESC",
        )
        .all()
        .find((m) => m.text.includes("not been changed")).text,
      /not been changed/,
    );
    await nav("requests");
    await page.locator('[data-action="task"][data-id]').click();
    await page.locator('[name="status"]').selectOption("Completed");
    await page
      .locator('[name="note"]')
      .fill("Reviewed with client and insurer in this test.");
    await formSubmit("task-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(
      db.prepare("SELECT status FROM requests").get().status,
      "Completed",
    );
    console.log(
      "PASS simulated incoming Gmail creates task and receipt-only acknowledgement; owner resolves task",
    );
    await nav("leads");
    await page.locator('[data-action="contact"]').click();
    await page.locator('#contact-form [name="email_consent"]').check();
    await page
      .locator('#contact-form [name="consent_note"]')
      .fill("Client gave consent during test call.");
    await formSubmit("contact-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(
      db
        .prepare(
          "SELECT email_consent FROM contacts WHERE email='emma@example.com'",
        )
        .get().email_consent,
      1,
    );
    console.log(
      "PASS inbox-only client contact can be reviewed and consent recorded",
    );
    await nav("policies");
    await action("policy");
    const cid = db
      .prepare("SELECT id FROM contacts WHERE email='joseph@example.com'")
      .get().id;
    await page.locator('[name="contact_id"]').selectOption(cid);
    await page.locator('[name="number"]').fill("TEST-123");
    await page.locator('[name="insurer"]').fill("Manulife");
    await page.locator('[name="effective"]').fill("2026-10-27");
    await page.locator('[name="expiry"]').fill("2026-11-19");
    await formSubmit("policy-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await worker.tick();
    await action("refresh");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM jobs WHERE type='reminder' AND status='draft'",
        )
        .get().n,
      2,
    );
    await action("reminder");
    await formSubmit("send-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    await worker.tick();
    console.log(
      "PASS policy entry, milestone drafts, and reviewed reminder send",
    );
    await action("import");
    await page
      .locator('[name="csv"]')
      .fill(
        "email,number,insurer,insurance_type,effective,expiry\njoseph@example.com,CSV-123,TuGo,Super Visa,2026-12-01,2027-12-01",
      );
    await formSubmit("import-form");
    await page.getByText("1 valid policies · 0 errors").waitFor();
    await formSubmit("import-form");
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(db.prepare("SELECT count(*) n FROM policies").get().n, 2);
    console.log("PASS two-step policy CSV preview and confirmation");
    await page.reload();
    await page
      .getByRole("heading", { name: "Dates worth remembering." })
      .waitFor();
    assert.equal(await page.locator("tbody tr").count(), 2);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("mapledesk-demo-v1")),
      null,
    );
    console.log(
      "PASS server-backed reload persistence without browser record storage",
    );
    await nav("leads");
    await action("followup");
    await page.locator('#send-form [name="channel"]').selectOption("whatsapp");
    await action("handoff");
    await page.locator('a[href^="https://wa.me/14165550101"]').waitFor();
    assert.equal(
      db.prepare("SELECT count(*) n FROM messages WHERE status='handoff'").get()
        .n,
      1,
    );
    await action("close");
    await nav("inbox");
    await page
      .locator('[data-action="inbox-filter"][data-channel="whatsapp"]')
      .click();
    page.once("dialog", (d) => d.accept());
    await action("confirm-manual");
    await page.getByText("Manual send recorded.", { exact: true }).waitFor();
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM messages WHERE status='manual_sent'")
        .get().n,
      1,
    );
    console.log(
      "PASS WhatsApp phone-app draft handoff and explicit manual-send confirmation",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#mobile-menu").click();
    await nav("inbox");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator("#mobile-menu").click();
    await nav("settings");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    console.log("PASS mobile inbox and settings layout");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-action="logout"]').click();
    await page.locator("#login-form").waitFor();
    assert.equal(
      (await page.request.get(cfg.publicUrl + "/api/state")).status(),
      401,
    );
    assert.deepEqual(errors, []);
    console.log("PASS logout revokes session; no browser JavaScript errors");
  } finally {
    worker.stop();
    await browser.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
