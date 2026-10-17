"use strict";
const express = require("express");
const helmet = require("helmet");
const crypto = require("node:crypto");
const path = require("node:path");
const { z } = require("zod");
const { id, audit, setting } = require("./db");
const {
  sha,
  random,
  verifyPassword,
  bootstrapOwner,
  cookieToken,
  session,
  totpCounter,
} = require("./security");
const {
  leadSchema,
  policySchema,
  contactSchema,
  today,
  saveContact,
  inbound,
  parsePolicies,
  schedule,
  plusDays,
} = require("./domain");
const { queueMessage } = require("./worker");
const {
  integration,
  googleReady,
  whatsappReady,
  googleAuth,
  googleCallback,
  syncGmail,
  testWhatsapp,
  templateText,
  request,
} = require("./integrations");
const fail = (status, message) =>
  Object.assign(new Error(message), { httpStatus: status });
const sendSchema = z.object({
  contactId: z.string().uuid(),
  channel: z.enum(["email", "whatsapp"]),
  text: z.string().trim().min(1).max(4000),
  subject: z.string().max(200).default("Your insurance enquiry"),
  purpose: z.enum(["reply", "followup", "reminder"]).default("reply"),
  leadId: z.string().uuid().optional(),
  policyId: z.string().uuid().optional(),
  reminderJobId: z.string().uuid().optional(),
  event: z.enum(["effective", "expiry"]).optional(),
  template: z
    .object({
      name: z.string(),
      language: z.string(),
      parameters: z.array(z.string()),
    })
    .optional(),
  key: z.string().uuid(),
});
function createApp(db, cfg) {
  bootstrapOwner(db, cfg);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.production ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: cfg.production ? [] : null,
        },
      },
      strictTransportSecurity: cfg.production ? undefined : false,
    }),
  );
  app.get("/healthz", (req, res) => res.json({ status: "ok" }));
  app.get("/webhooks/whatsapp", (req, res) => {
    if (
      !cfg.waVerifyToken ||
      req.query["hub.mode"] !== "subscribe" ||
      req.query["hub.verify_token"] !== cfg.waVerifyToken
    )
      return res.sendStatus(403);
    res.type("text").send(String(req.query["hub.challenge"] || ""));
  });
  app.post(
    "/webhooks/whatsapp",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, res, next) => {
      try {
        if (!cfg.waAppSecret || !Buffer.isBuffer(req.body))
          throw fail(403, "Webhook verification unavailable");
        const expected =
            "sha256=" +
            crypto
              .createHmac("sha256", cfg.waAppSecret)
              .update(req.body)
              .digest("hex"),
          received = req.get("x-hub-signature-256") || "";
        if (
          received.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
        )
          throw fail(403, "Invalid webhook signature");
        const data = JSON.parse(req.body.toString());
        if (data.object !== "whatsapp_business_account")
          throw fail(400, "Unexpected webhook object");
        for (const entry of data.entry || [])
          for (const change of entry.changes || []) {
            const v = change.value;
            if (v?.metadata?.phone_number_id !== cfg.waPhoneId) continue;
            for (const m of v.messages || []) {
              if (!/^\d{8,15}$/.test(m.from) || !m.id) continue;
              const at = Number(m.timestamp) * 1000;
              if (!Number.isFinite(at)) continue;
              inbound(db, cfg, {
                channel: "whatsapp",
                eventId: m.id,
                address: "+" + m.from,
                name:
                  v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ||
                  "+" + m.from,
                text:
                  m.text?.body ||
                  `[${m.type || "Non-text"} message — review in WhatsApp]`,
                at: new Date(at).toISOString(),
              });
            }
            for (const s of v.statuses || []) {
              if (!["sent", "delivered", "read", "failed"].includes(s.status))
                continue;
              const current = db
                .prepare("SELECT id,status FROM messages WHERE provider_id=?")
                .get(s.id);
              if (!current) continue;
              const rank = {
                queued: 0,
                sending: 1,
                sent: 2,
                delivered: 3,
                read: 4,
                failed: 5,
              };
              if (
                current.status === "read" ||
                rank[s.status] < rank[current.status]
              )
                continue;
              db.prepare("UPDATE messages SET status=? WHERE id=?").run(
                s.status,
                current.id,
              );
            }
          }
        res.sendStatus(200);
      } catch (e) {
        next(e);
      }
    },
  );
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== cfg.publicUrl
    )
      return next(fail(403, "Request origin is not allowed"));
    next();
  });
  app.post("/api/login", (req, res, next) => {
    try {
      const input = z
        .object({
          email: z.string().email().max(254),
          password: z.string().min(1).max(500),
          code: z.string().max(10).optional(),
        })
        .parse(req.body);
      const key = sha(req.ip || "unknown"),
        now = Date.now();
      db.prepare("DELETE FROM login_limits WHERE expires_at<?").run(now);
      const limit = db
        .prepare("SELECT * FROM login_limits WHERE key=?")
        .get(key);
      if (limit?.count >= 10)
        throw fail(429, "Too many attempts. Try again in 15 minutes.");
      db.prepare(
        "INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      ).run(key, now + 900000);
      const user = db
        .prepare("SELECT * FROM users WHERE email=?")
        .get(input.email.toLowerCase());
      const valid = verifyPassword(
        input.password,
        user?.password_hash || "0".repeat(32) + ":" + "0".repeat(128),
      );
      let counter = null;
      if (cfg.totpSecret)
        counter = totpCounter(input.code || "", cfg.totpSecret);
      if (
        !user ||
        !valid ||
        (cfg.totpSecret && (counter === null || counter <= user.last_totp))
      )
        throw fail(
          401,
          "Sign-in failed. Check email, password and authenticator code.",
        );
      const token = random(),
        csrf = random();
      db.transaction(() => {
        db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
        if (counter !== null)
          db.prepare("UPDATE users SET last_totp=? WHERE id=?").run(
            counter,
            user.id,
          );
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
          sha(token),
          user.id,
          csrf,
          now + 12 * 3600000,
        );
        db.prepare("DELETE FROM login_limits WHERE key=?").run(key);
        audit(db, "Owner signed in", user.id);
      })();
      res
        .cookie("md_session", token, {
          httpOnly: true,
          secure: cfg.production,
          sameSite: "lax",
          maxAge: 12 * 3600000,
          path: "/",
        })
        .json({ csrf, email: user.email });
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", (req, res, next) => {
    const user = session(db, req);
    if (!user) return next(fail(401, "Sign in to continue"));
    req.user = user;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("x-csrf-token") !== user.csrf
    )
      return next(fail(403, "Security token expired. Reload and try again."));
    next();
  });
  app.get("/api/session", (req, res) =>
    res.json({ email: req.user.email, csrf: req.user.csrf }),
  );
  app.post("/api/logout", (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
      sha(cookieToken(req)),
    );
    res.clearCookie("md_session", { path: "/" }).json({ ok: true });
  });
  app.get("/api/state", (req, res) => {
    const gmail = cfg.key ? integration(db, cfg, "gmail") : null;
    res.json({
      business: cfg.business,
      today: today(cfg),
      timezone: cfg.timezone,
      mode: cfg.mode,
      liveSends: cfg.liveSends,
      owner: req.user.email,
      contacts: db
        .prepare("SELECT * FROM contacts ORDER BY created_at DESC")
        .all(),
      leads: db.prepare("SELECT * FROM leads ORDER BY due").all(),
      policies: db.prepare("SELECT * FROM policies ORDER BY expiry").all(),
      threads: db.prepare("SELECT * FROM threads").all(),
      messages: db.prepare("SELECT * FROM messages ORDER BY created_at").all(),
      requests: db
        .prepare("SELECT * FROM requests ORDER BY created_at DESC")
        .all(),
      jobs: db
        .prepare(
          "SELECT id,type,status,payload,last_error,created_at FROM jobs ORDER BY created_at DESC LIMIT 200",
        )
        .all()
        .map((j) => ({ ...j, payload: JSON.parse(j.payload) })),
      audit: db
        .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT 100")
        .all(),
      settings: {
        autoAck: setting(db, "autoAck"),
        reminders: setting(db, "reminders"),
      },
      integrations: {
        gmail: {
          configured: googleReady(cfg),
          connected: Boolean(gmail),
          address: gmail?.metadata.address,
          lastSync: gmail?.metadata.lastSync,
          error: gmail?.metadata.lastError || gmail?.metadata.gapWarning,
        },
        whatsapp: { configured: whatsappReady(cfg), templates: cfg.templates },
      },
    });
  });
  app.post("/api/leads", (req, res, next) => {
    try {
      const input = leadSchema.parse(req.body);
      const lid = id();
      db.transaction(() => {
        const cid = saveContact(db, input.contact);
        db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?)").run(
          lid,
          cid,
          input.insurance_type,
          input.status,
          input.due,
          input.interval_days,
          input.channel,
        );
        audit(db, "Lead created", lid);
      })();
      res.status(201).json({ id: lid });
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/leads/:id", (req, res, next) => {
    try {
      const input = leadSchema.parse(req.body),
        lead = db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);
      if (!lead) throw fail(404, "Lead not found");
      db.transaction(() => {
        saveContact(db, input.contact, lead.contact_id);
        db.prepare(
          "UPDATE leads SET insurance_type=?,status=?,due=?,interval_days=?,channel=? WHERE id=?",
        ).run(
          input.insurance_type,
          input.status,
          input.due,
          input.interval_days,
          input.channel,
          lead.id,
        );
        audit(db, "Lead updated", lead.id);
      })();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/contacts/:id", (req, res, next) => {
    try {
      const c = contactSchema.parse(req.body);
      if (!db.prepare("SELECT id FROM contacts WHERE id=?").get(req.params.id))
        throw fail(404, "Client not found");
      db.transaction(() => {
        saveContact(db, c, req.params.id);
        audit(db, "Client contact details and consent updated", req.params.id);
      })();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/policies", (req, res, next) => {
    try {
      const p = policySchema.parse(req.body);
      if (!db.prepare("SELECT id FROM contacts WHERE id=?").get(p.contact_id))
        throw fail(400, "Client not found");
      const pid = id();
      db.prepare("INSERT INTO policies VALUES(?,?,?,?,?,?,?,?,?)").run(
        pid,
        p.contact_id,
        p.number,
        p.insurer,
        p.insurance_type,
        p.effective,
        p.expiry,
        p.status,
        cfg.now().toISOString(),
      );
      audit(db, "Policy created", pid);
      schedule(db, cfg);
      res.status(201).json({ id: pid });
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/policies/:id", (req, res, next) => {
    try {
      const p = policySchema.parse(req.body);
      const old = db
        .prepare("SELECT * FROM policies WHERE id=?")
        .get(req.params.id);
      if (!old) throw fail(404, "Policy not found");
      db.prepare(
        "UPDATE policies SET contact_id=?,number=?,insurer=?,insurance_type=?,effective=?,expiry=?,status=?,verified_at=? WHERE id=?",
      ).run(
        p.contact_id,
        p.number,
        p.insurer,
        p.insurance_type,
        p.effective,
        p.expiry,
        p.status,
        cfg.now().toISOString(),
        old.id,
      );
      audit(db, "Policy updated; obsolete reminders will be cancelled", old.id);
      schedule(db, cfg);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/policies/import", (req, res, next) => {
    try {
      const { csv, confirm } = z
        .object({
          csv: z.string().max(800000),
          confirm: z.boolean().default(false),
        })
        .parse(req.body);
      let result;
      try {
        result = parsePolicies(db, csv);
      } catch {
        throw fail(400, "Invalid CSV. Check header names and quoting.");
      }
      if (confirm) {
        if (result.errors.length)
          throw fail(400, "Correct all preview errors before importing");
        db.transaction(() => {
          for (const p of result.items)
            db.prepare("INSERT INTO policies VALUES(?,?,?,?,?,?,?,?,?)").run(
              id(),
              p.contact_id,
              p.number,
              p.insurer,
              p.insurance_type,
              p.effective,
              p.expiry,
              p.status,
              cfg.now().toISOString(),
            );
          audit(db, "Policy CSV imported");
        })();
        schedule(db, cfg);
      }
      res.json({ ...result, imported: confirm ? result.items.length : 0 });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/messages", (req, res, next) => {
    try {
      const p = sendSchema.parse(req.body);
      const c = db
        .prepare("SELECT * FROM contacts WHERE id=?")
        .get(p.contactId);
      if (!c) throw fail(404, "Client not found");
      if (p.purpose === "followup") {
        const l = db
          .prepare("SELECT * FROM leads WHERE id=? AND contact_id=?")
          .get(p.leadId, c.id);
        if (!l) throw fail(400, "Follow-up lead does not match this client");
      }
      let policyDate;
      if (p.purpose === "reminder") {
        const policy = db
          .prepare("SELECT * FROM policies WHERE id=? AND contact_id=?")
          .get(p.policyId, c.id);
        if (!policy || !p.event)
          throw fail(400, "Reminder requires a matching policy and date type");
        policyDate = policy[p.event];
        if (!setting(db, "reminders"))
          throw fail(400, "Reminders are disabled");
      }
      if (p.reminderJobId) {
        const job = db
          .prepare("SELECT * FROM jobs WHERE id=? AND type='reminder'")
          .get(p.reminderJobId);
        if (!job) throw fail(400, "Reminder draft not found");
        const r = JSON.parse(job.payload);
        if (
          r.policyId !== p.policyId ||
          r.event !== p.event ||
          r.date !== policyDate
        )
          throw fail(400, "Reminder draft no longer matches the policy");
      }
      const text = p.template ? templateText(cfg, p.template) : p.text;
      const result = queueMessage(db, cfg, {
        ...p,
        text,
        policyDate,
        key: p.reminderJobId
          ? "reminder-send:" + p.reminderJobId
          : "owner:" + p.key,
      });
      res.status(202).json(result);
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/whatsapp/handoff", (req, res, next) => {
    try {
      const p = sendSchema.parse(req.body);
      if (p.channel !== "whatsapp")
        throw fail(400, "Handoff is for WhatsApp only");
      const c = db
        .prepare("SELECT * FROM contacts WHERE id=?")
        .get(p.contactId);
      if (!c || !c.phone) throw fail(400, "Client WhatsApp phone is missing");
      if (c.opted_out || !c.whatsapp_consent)
        throw fail(
          400,
          "Client consent is required and opt-outs must be respected",
        );
      let policyDate;
      if (p.purpose === "followup") {
        const l = db
          .prepare("SELECT * FROM leads WHERE id=? AND contact_id=?")
          .get(p.leadId, c.id);
        if (!l || ["Won", "Lost"].includes(l.status))
          throw fail(400, "Follow-up lead is closed or invalid");
      }
      if (p.purpose === "reminder") {
        const policy = db
          .prepare("SELECT * FROM policies WHERE id=? AND contact_id=?")
          .get(p.policyId, c.id);
        if (
          !policy ||
          policy.status !== "Active" ||
          !p.event ||
          !setting(db, "reminders")
        )
          throw fail(400, "Policy reminder is invalid or disabled");
        policyDate = policy[p.event];
      }
      let source;
      if (p.reminderJobId) {
        source = db
          .prepare("SELECT * FROM jobs WHERE id=? AND type='reminder'")
          .get(p.reminderJobId);
        if (!source) throw fail(400, "Reminder draft not found");
        const r = JSON.parse(source.payload);
        if (
          r.policyId !== p.policyId ||
          r.event !== p.event ||
          r.date !== policyDate
        )
          throw fail(400, "Reminder draft no longer matches the policy");
      }
      const key = p.reminderJobId
        ? "reminder-handoff:" + p.reminderJobId
        : "handoff:" + p.key;
      let result;
      db.transaction(() => {
        const old = db
          .prepare("SELECT * FROM jobs WHERE dedupe_key=?")
          .get(key);
        if (old) {
          const message = db
            .prepare(
              "SELECT messages.*,threads.contact_id FROM messages JOIN threads ON threads.id=messages.thread_id WHERE messages.id=?",
            )
            .get(JSON.parse(old.payload).messageId);
          if (
            !message ||
            message.contact_id !== c.id ||
            message.text !== p.text
          )
            throw fail(
              409,
              "This request key was already used for a different draft",
            );
          result = { messageId: JSON.parse(old.payload).messageId };
          return;
        }
        if (source && source.status !== "draft")
          throw fail(409, "This reminder is already being handled");
        const thread = require("./domain").threadFor(db, c.id, "whatsapp"),
          mid = id();
        db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
          mid,
          thread.id,
          "out",
          p.text,
          "handoff",
          null,
          null,
          cfg.now().toISOString(),
        );
        db.prepare(
          "INSERT INTO jobs(id,dedupe_key,type,payload,status,available_at,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id(),
          key,
          "manual",
          JSON.stringify({
            messageId: mid,
            purpose: p.purpose,
            leadId: p.leadId,
            policyId: p.policyId,
            event: p.event,
            policyDate,
            reminderJobId: p.reminderJobId,
          }),
          "awaiting_owner",
          cfg.now().toISOString(),
          cfg.now().toISOString(),
        );
        if (p.reminderJobId)
          db.prepare("UPDATE jobs SET status='awaiting_owner' WHERE id=?").run(
            p.reminderJobId,
          );
        audit(db, "WhatsApp draft handed off; not marked sent", mid);
        result = { messageId: mid };
      })();
      res.status(201).json({
        ...result,
        url:
          "https://wa.me/" +
          c.phone.slice(1) +
          "?text=" +
          encodeURIComponent(p.text),
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/messages/:id/confirm-manual", (req, res, next) => {
    try {
      db.transaction(() => {
        const message = db
          .prepare("SELECT * FROM messages WHERE id=? AND status='handoff'")
          .get(req.params.id);
        if (!message)
          throw fail(400, "Message is not awaiting manual confirmation");
        const job = db
            .prepare(
              "SELECT * FROM jobs WHERE type='manual' AND json_extract(payload,'$.messageId')=?",
            )
            .get(message.id),
          p = JSON.parse(job.payload);
        db.prepare("UPDATE messages SET status='manual_sent' WHERE id=?").run(
          message.id,
        );
        db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(job.id);
        if (p.reminderJobId) {
          const policy = db
            .prepare("SELECT * FROM policies WHERE id=?")
            .get(p.policyId);
          const current =
            policy?.status === "Active" && policy[p.event] === p.policyDate;
          db.prepare("UPDATE jobs SET status=? WHERE id=?").run(
            current ? "done" : "cancelled",
            p.reminderJobId,
          );
        }
        if (p.purpose === "followup") {
          const l = db.prepare("SELECT * FROM leads WHERE id=?").get(p.leadId);
          if (l && !["Won", "Lost"].includes(l.status))
            db.prepare(
              "UPDATE leads SET due=?,status='Awaiting reply' WHERE id=?",
            ).run(plusDays(today(cfg), l.interval_days), l.id);
        }
        audit(
          db,
          "Owner confirmed manual WhatsApp send; no provider delivery receipt",
          message.id,
        );
      })();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/requests", (req, res, next) => {
    try {
      const p = z
        .object({
          contact_id: z.string().uuid(),
          channel: z.enum(["email", "whatsapp"]),
          kind: z.string().trim().min(1).max(100),
          detail: z.string().trim().min(1).max(20000),
        })
        .parse(req.body);
      if (!db.prepare("SELECT id FROM contacts WHERE id=?").get(p.contact_id))
        throw fail(400, "Client not found");
      const rid = id();
      db.prepare(
        "INSERT INTO requests(id,contact_id,channel,kind,detail,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        rid,
        p.contact_id,
        p.channel,
        p.kind,
        p.detail,
        cfg.now().toISOString(),
      );
      audit(db, "Manual task created", rid);
      res.status(201).json({ id: rid });
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/requests/:id", (req, res, next) => {
    try {
      const p = z
        .object({
          status: z.enum(["Open", "In progress", "Completed"]),
          note: z.string().max(5000),
        })
        .parse(req.body);
      if (
        !db
          .prepare("UPDATE requests SET status=?,note=? WHERE id=?")
          .run(p.status, p.note, req.params.id).changes
      )
        throw fail(404, "Task not found");
      audit(db, "Task updated", req.params.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/settings", (req, res, next) => {
    try {
      const p = z
        .object({ autoAck: z.boolean(), reminders: z.boolean() })
        .parse(req.body);
      db.transaction(() => {
        for (const [k, v] of Object.entries(p))
          db.prepare("UPDATE settings SET value=? WHERE key=?").run(
            JSON.stringify(v),
            k,
          );
        audit(db, "Automation settings updated");
      })();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/integrations/gmail/connect", (req, res, next) => {
    try {
      res.json({ url: googleAuth(db, cfg, req.user.token_hash) });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/integrations/gmail/callback", async (req, res, next) => {
    try {
      if (
        typeof req.query.code !== "string" ||
        typeof req.query.state !== "string"
      )
        throw fail(400, "Google consent was not completed");
      await googleCallback(db, cfg, {
        code: req.query.code,
        state: req.query.state,
        sessionHash: req.user.token_hash,
      });
      res.redirect("/#settings");
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/integrations/gmail/sync", async (req, res, next) => {
    try {
      if (cfg.mode !== "live")
        throw fail(400, "Gmail sync is available only in live mode");
      res.json(await syncGmail(db, cfg));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/integrations/gmail/disconnect", async (req, res, next) => {
    try {
      const current = cfg.key ? integration(db, cfg, "gmail") : null;
      let revoked = !current;
      if (current) {
        try {
          await request(cfg, "https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: current.secret.refresh_token }),
          });
          revoked = true;
        } catch {
          revoked = false;
        }
        db.prepare("DELETE FROM integrations WHERE name='gmail'").run();
      }
      audit(db, "Gmail disconnected");
      res.json({
        ok: true,
        revoked,
        action: revoked
          ? null
          : "Also revoke access in your Google account security settings.",
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/integrations/whatsapp/test", async (req, res, next) => {
    try {
      res.json(await testWhatsapp(cfg));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/simulate", (req, res, next) => {
    try {
      if (cfg.mode !== "mock")
        throw fail(404, "Simulation is unavailable in live mode");
      const p = z
        .object({
          channel: z.enum(["email", "whatsapp"]),
          name: z.string().trim().min(1).max(100),
          address: z.string(),
          text: z.string().trim().min(1).max(20000),
          eventId: z.string().max(200).optional(),
        })
        .parse(req.body);
      if (
        (p.channel === "email" && !z.email().safeParse(p.address).success) ||
        (p.channel === "whatsapp" && !/^\+[1-9]\d{7,14}$/.test(p.address))
      )
        throw fail(400, "Enter a valid channel address");
      res.json(
        inbound(db, cfg, {
          ...p,
          eventId: p.eventId || "simulation:" + id(),
          subject: "Simulated incoming message",
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found" }),
  );
  const root = path.resolve(__dirname, "..");
  const files = {
    "/": "public/workspace.html",
    "/workspace.js": "public/workspace.js",
    "/workspace.css": "public/workspace.css",
    "/styles.css": "styles.css",
    "/demo": "index.html",
    "/app.js": "app.js",
    "/mockups/MapleDesk-Interactive.html": "mockups/MapleDesk-Interactive.html",
  };
  for (const [url, file] of Object.entries(files))
    app.get(url, (req, res) => {
      if (url.includes("MapleDesk-Interactive"))
        res.removeHeader("Content-Security-Policy");
      res.set("Cache-Control", "no-store").sendFile(path.join(root, file));
    });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = err.httpStatus || 400,
      message = err.message;
    if (err instanceof z.ZodError)
      message = err.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; ");
    else if (err.code?.startsWith("SQLITE_CONSTRAINT")) {
      status = 409;
      message =
        "A client address or policy number already exists, or a linked record is invalid.";
    } else if (err.type === "entity.parse.failed")
      message = "Invalid JSON request";
    else if (err.type === "entity.too.large") {
      status = 413;
      message = "Request is too large";
    }
    if (status >= 500) message = "Unable to complete the request";
    res.status(status).json({ error: message });
  });
  return app;
}
module.exports = { createApp };
