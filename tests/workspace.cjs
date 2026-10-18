"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startJava } = require("./java-server.cjs");
(async () => {
  const server = await startJava();
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
    const state = async () => {
      const res = await page.request.get(server.base + "/api/state");
      assert.equal(res.status(), 200);
      return res.json();
    };
    const wait = async (predicate) => {
      for (let i = 0; i < 80; i++) {
        const s = await state();
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Expected database-backed state did not appear");
    };
    const action = async (a) =>
      page.locator(`[data-action="${a}"]`).first().click();
    const nav = async (p) => page.locator(`#nav [data-page="${p}"]`).click();
    const submit = async (f) =>
      page.locator(`#${f} button[type="submit"]`).click();
    const closed = async () =>
      page.locator("#dialog").waitFor({ state: "hidden" });
    await page.goto(server.base);
    await page.locator('#login-form [name="email"]').fill("owner@example.com");
    await page.locator('[name="password"]').fill("test-only-password-long!");
    await page.locator("#login-form button").click();
    await page
      .getByRole("heading", { name: "A little clarity. A better day." })
      .waitFor();
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
    await submit("lead-form");
    await closed();
    assert.equal((await state()).contacts.length, 1);
    console.log(
      "PASS Java owner sign-in and client creation with consent evidence",
    );
    await nav("leads");
    await action("followup");
    await page
      .locator('#send-form [name="text"]')
      .fill("Hi Joseph, happy to answer your Super Visa questions.");
    await submit("send-form");
    await closed();
    await wait((s) => s.messages.some((m) => m.status === "simulated"));
    await action("refresh");
    let s = await state();
    assert.equal(s.leads[0].due, "2026-10-22");
    await nav("inbox");
    await page
      .getByText("Hi Joseph, happy to answer your Super Visa questions.", {
        exact: true,
      })
      .waitFor();
    console.log(
      "PASS Java job processor sends mock Gmail follow-up and schedules next check-in",
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
    await submit("simulate-form");
    await closed();
    s = await wait((s) =>
      s.messages.some(
        (m) =>
          m.direction === "out" &&
          m.text.includes("not been changed") &&
          m.status === "simulated",
      ),
    );
    assert.equal(s.requests.length, 1);
    await action("refresh");
    await nav("requests");
    await page.locator('[data-action="task"][data-id]').click();
    await page.locator('[name="status"]').selectOption("Completed");
    await page
      .locator('[name="note"]')
      .fill("Reviewed with client and insurer in test.");
    await submit("task-form");
    await closed();
    assert.equal((await state()).requests[0].status, "Completed");
    console.log(
      "PASS Java incoming request, receipt-only acknowledgement and task resolution",
    );
    await nav("leads");
    await page.locator('[data-action="contact"]').click();
    await page.locator('#contact-form [name="email_consent"]').check();
    await page
      .locator('#contact-form [name="consent_note"]')
      .fill("Agreed during test call.");
    await submit("contact-form");
    await closed();
    assert.equal(
      (await state()).contacts.find((c) => c.email === "emma@example.com")
        .email_consent,
      1,
    );
    console.log("PASS inbox-only contact consent updates");
    await nav("policies");
    await action("policy");
    s = await state();
    const cid = s.contacts.find((c) => c.email === "joseph@example.com").id;
    await page.locator('[name="contact_id"]').selectOption(cid);
    await page.locator('[name="number"]').fill("TEST-123");
    await page.locator('[name="insurer"]').fill("Manulife");
    await page.locator('[name="effective"]').fill("2026-10-27");
    await page.locator('[name="expiry"]').fill("2026-11-19");
    await submit("policy-form");
    await closed();
    await wait(
      (s) =>
        s.jobs.filter((j) => j.type === "reminder" && j.status === "draft")
          .length === 2,
    );
    await action("refresh");
    await action("reminder");
    await submit("send-form");
    await closed();
    await wait((s) =>
      s.jobs.some((j) => j.type === "reminder" && j.status === "done"),
    );
    console.log("PASS Java policy milestones and reviewed reminder delivery");
    await action("import");
    await page
      .locator('[name="csv"]')
      .fill(
        "email,number,insurer,insurance_type,effective,expiry\njoseph@example.com,CSV-123,TuGo,Super Visa,2026-12-01,2027-12-01",
      );
    await submit("import-form");
    await page.getByText("1 valid policies · 0 errors").waitFor();
    await submit("import-form");
    await closed();
    assert.equal((await state()).policies.length, 2);
    console.log("PASS Java atomic CSV preview and import");
    await page.reload();
    await page
      .getByRole("heading", { name: "Dates worth remembering." })
      .waitFor();
    assert.equal(await page.locator("tbody tr").count(), 2);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("mapledesk-demo-v1")),
      null,
    );
    console.log("PASS database-backed reload without browser record storage");
    await nav("leads");
    await action("followup");
    await page.locator('#send-form [name="channel"]').selectOption("whatsapp");
    await action("handoff");
    await page.locator('a[href^="https://wa.me/14165550101"]').waitFor();
    assert.equal(
      (await state()).messages.filter((m) => m.status === "handoff").length,
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
      (await state()).messages.filter((m) => m.status === "manual_sent").length,
      1,
    );
    console.log(
      "PASS Java WhatsApp phone-app handoff and explicit manual confirmation",
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
    console.log("PASS mobile inbox and settings");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-action="logout"]').click();
    await page.locator("#login-form").waitFor();
    assert.equal(
      (await page.request.get(server.base + "/api/state")).status(),
      401,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS Java logout invalidates session; no browser JavaScript errors",
    );
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
