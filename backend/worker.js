"use strict";
const { id, audit, enqueue, setting } = require("./db");
const { today, plusDays, threadFor, schedule } = require("./domain");
const {
  integration,
  storeIntegration,
  whatsappReady,
  sendGmail,
  sendWhatsapp,
  syncGmail,
  templateText,
} = require("./integrations");
function checkSend(db, cfg, message, payload) {
  const t = db
      .prepare("SELECT * FROM threads WHERE id=?")
      .get(message.thread_id),
    c = db.prepare("SELECT * FROM contacts WHERE id=?").get(t.contact_id);
  if (c.opted_out) throw new Error("Client has opted out");
  if (payload.purpose === "followup") {
    const lead = db
      .prepare("SELECT * FROM leads WHERE id=?")
      .get(payload.leadId);
    if (!lead || ["Won", "Lost"].includes(lead.status))
      throw new Error("Sales follow-up cancelled: lead is closed");
  }
  if (payload.policyId) {
    const p = db
      .prepare("SELECT * FROM policies WHERE id=?")
      .get(payload.policyId);
    if (!p || p.status !== "Active" || p[payload.event] !== payload.policyDate)
      throw new Error("Reminder cancelled: policy was changed");
  }
  const recent =
    t.last_inbound &&
    cfg.now() - new Date(t.last_inbound) < 24 * 3600000 &&
    cfg.now() >= new Date(t.last_inbound);
  const directReceipt = payload.purpose === "ack" && recent;
  if (!directReceipt && !c[t.channel + "_consent"])
    throw new Error("Record client consent before sending on this channel");
  if (
    (t.channel === "email" && !c.email) ||
    (t.channel === "whatsapp" && !c.phone)
  )
    throw new Error("Client address is missing");
  if (t.channel === "whatsapp" && !recent && !payload.template)
    throw new Error(
      "WhatsApp requires an approved template outside the 24-hour service window",
    );
  if (payload.template) {
    const expected = templateText(cfg, payload.template);
    if (expected !== message.text)
      throw new Error("Template preview and message text do not match");
  }
  if (cfg.mode === "live") {
    if (!cfg.liveSends)
      throw new Error("Live sending is disabled in environment settings");
    if (t.channel === "email" && !integration(db, cfg, "gmail"))
      throw new Error("Gmail is disconnected");
    if (t.channel === "whatsapp" && !whatsappReady(cfg))
      throw new Error("WhatsApp API is not configured");
  }
  return { thread: t, contact: c };
}
function queueMessage(
  db,
  cfg,
  {
    contactId,
    channel,
    text,
    subject,
    purpose = "reply",
    leadId,
    policyId,
    event,
    policyDate,
    reminderJobId,
    template,
    key,
  },
) {
  return db.transaction(() => {
    const t = threadFor(
        db,
        contactId,
        channel,
        subject || "Your insurance enquiry",
      ),
      mid = id();
    const existing = db
      .prepare("SELECT * FROM jobs WHERE dedupe_key=?")
      .get(key);
    if (existing) {
      const prior = db
        .prepare("SELECT * FROM messages WHERE id=?")
        .get(JSON.parse(existing.payload).messageId);
      if (!prior || prior.thread_id !== t.id || prior.text !== text)
        throw new Error(
          "This request key was already used for a different message",
        );
      return {
        messageId: JSON.parse(existing.payload).messageId,
        jobId: existing.id,
        duplicate: true,
      };
    }
    if (
      reminderJobId &&
      db
        .prepare("SELECT status FROM jobs WHERE id=? AND type='reminder'")
        .get(reminderJobId)?.status !== "draft"
    )
      throw new Error(
        "This reminder is already being handled; check its outcome before sending again",
      );
    const payload = {
      messageId: mid,
      purpose,
      leadId,
      policyId,
      event,
      policyDate,
      reminderJobId,
      template,
    };
    checkSend(db, cfg, { thread_id: t.id, text }, payload);
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
      mid,
      t.id,
      "out",
      text,
      "queued",
      null,
      null,
      cfg.now().toISOString(),
    );
    const jid = enqueue(db, key, "send", payload, cfg.now().toISOString());
    if (reminderJobId)
      db.prepare(
        "UPDATE jobs SET status='queued' WHERE id=? AND status='draft'",
      ).run(reminderJobId);
    audit(db, "Message queued for " + channel, mid);
    return { messageId: mid, jobId: jid };
  })();
}
async function work(db, cfg) {
  const now = cfg.now().toISOString();
  // A process interrupted during a provider send cannot know whether it succeeded. Never automatically resend it.
  for (const stale of db
    .prepare("SELECT * FROM jobs WHERE status='running' AND lease_until<?")
    .all(now)) {
    const p = JSON.parse(stale.payload);
    db.prepare(
      "UPDATE jobs SET status='needs_review',last_error='Interrupted operation; check provider before resending' WHERE id=?",
    ).run(stale.id);
    if (p.messageId)
      db.prepare(
        "UPDATE messages SET status='needs_review' WHERE id=? AND status='sending'",
      ).run(p.messageId);
    if (p.reminderJobId)
      db.prepare(
        "UPDATE jobs SET status='needs_review',last_error='Interrupted send; inspect provider history' WHERE id=?",
      ).run(p.reminderJobId);
  }
  const job = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT * FROM jobs WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 1",
      )
      .get(now);
    if (!row) return null;
    db.prepare(
      "UPDATE jobs SET status='running',attempts=attempts+1,lease_until=? WHERE id=?",
    ).run(new Date(cfg.now().getTime() + 120000).toISOString(), row.id);
    return row;
  })();
  if (!job) return false;
  const p = JSON.parse(job.payload);
  let attempted = false;
  try {
    if (job.type === "reminder") {
      const policy = db
        .prepare("SELECT * FROM policies WHERE id=?")
        .get(p.policyId);
      if (
        !setting(db, "reminders") ||
        !policy ||
        policy.status !== "Active" ||
        policy[p.event] !== p.date
      ) {
        db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);
        return true;
      }
      audit(
        db,
        `Reminder draft ready: ${p.event} in ${p.days} days`,
        policy.id,
      );
      db.prepare("UPDATE jobs SET status='draft' WHERE id=?").run(job.id);
      return true;
    }
    if (job.type !== "send") throw new Error("Unknown job type");
    const message = db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(p.messageId);
    if (!message) throw new Error("Message not found");
    const { thread, contact } = checkSend(db, cfg, message, p);
    db.prepare("UPDATE messages SET status='sending' WHERE id=?").run(
      message.id,
    );
    attempted = true;
    let result;
    if (cfg.mode === "mock")
      result = { providerId: "mock:" + message.id, status: "simulated" };
    else
      result =
        thread.channel === "email"
          ? await sendGmail(
              db,
              cfg,
              contact,
              thread,
              message.text,
              p.purpose === "ack",
            )
          : await sendWhatsapp(cfg, contact, message.text, p.template);
    db.transaction(() => {
      db.prepare("UPDATE messages SET status=?,provider_id=? WHERE id=?").run(
        result.status,
        result.providerId,
        message.id,
      );
      if (result.externalId)
        db.prepare("UPDATE threads SET external_id=? WHERE id=?").run(
          result.externalId,
          thread.id,
        );
      db.prepare(
        "UPDATE jobs SET status='done',last_error=NULL WHERE id=?",
      ).run(job.id);
      if (p.reminderJobId)
        db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(
          p.reminderJobId,
        );
      if (p.purpose === "followup") {
        const l = db.prepare("SELECT * FROM leads WHERE id=?").get(p.leadId);
        if (l && !["Won", "Lost"].includes(l.status))
          db.prepare(
            "UPDATE leads SET due=?,status='Awaiting reply' WHERE id=?",
          ).run(plusDays(today(cfg), l.interval_days), l.id);
      }
      audit(
        db,
        cfg.mode === "mock" ? "Message simulated" : "Provider accepted message",
        message.id,
      );
    })();
  } catch (e) {
    const ambiguous = attempted && (e.ambiguous || !e.status),
      retry = e.status === 429 && job.attempts < 4;
    const status = retry ? "pending" : ambiguous ? "needs_review" : "failed";
    db.prepare(
      "UPDATE jobs SET status=?,available_at=?,last_error=? WHERE id=?",
    ).run(
      status,
      new Date(cfg.now().getTime() + 60000 * 2 ** job.attempts).toISOString(),
      e.message,
      job.id,
    );
    if (p.messageId)
      db.prepare("UPDATE messages SET status=? WHERE id=?").run(
        retry ? "queued" : status,
        p.messageId,
      );
    if (p.reminderJobId && !retry)
      db.prepare("UPDATE jobs SET status=?,last_error=? WHERE id=?").run(
        status,
        e.message,
        p.reminderJobId,
      );
    audit(db, "Background job " + status, job.id);
  }
  return true;
}
function startWorker(db, cfg) {
  let busy = false,
    lastSync = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      schedule(db, cfg);
      if (
        cfg.mode === "live" &&
        cfg.now().getTime() - lastSync > 300000 &&
        db.prepare("SELECT name FROM integrations WHERE name='gmail'").get()
      ) {
        lastSync = cfg.now().getTime();
        try {
          await syncGmail(db, cfg);
        } catch (e) {
          const current = integration(db, cfg, "gmail");
          if (current)
            storeIntegration(db, cfg, "gmail", current.secret, {
              ...current.metadata,
              lastError: e.message,
            });
        }
      }
      for (let i = 0; i < 20; i++) if (!(await work(db, cfg))) break;
    } catch (e) {
      console.error("Background processing failed:", e.name);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
module.exports = { checkSend, queueMessage, work, startWorker };
