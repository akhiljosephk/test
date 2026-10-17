"use strict";
const { z } = require("zod");
const { parse } = require("csv-parse/sync");
const { id, audit, enqueue } = require("./db");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T12:00:00Z");
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");
const email = z.string().trim().toLowerCase().email().max(254);
const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Use E.164 phone format, e.g. +14165550123");
const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: email.or(z.literal("")).optional(),
    phone: phone.or(z.literal("")).optional(),
    notes: z.string().max(3000).default(""),
    email_consent: z.boolean().default(false),
    whatsapp_consent: z.boolean().default(false),
    opted_out: z.boolean().default(false),
    consent_note: z.string().trim().max(500).default(""),
  })
  .refine((c) => c.email || c.phone, "Email or phone is required");
const leadSchema = z
  .object({
    contact: contactSchema,
    insurance_type: z.string().trim().min(1).max(80),
    status: z
      .enum(["New enquiry", "Quote sent", "Awaiting reply", "Won", "Lost"])
      .default("New enquiry"),
    due: isoDate,
    interval_days: z.union([z.literal(2), z.literal(4)]),
    channel: z.enum(["email", "whatsapp"]),
  })
  .refine(
    (l) =>
      l.channel === "email"
        ? Boolean(l.contact.email)
        : Boolean(l.contact.phone),
    "Preferred channel requires its contact address",
  );
const policySchema = z
  .object({
    contact_id: z.string().uuid(),
    number: z.string().trim().min(1).max(100),
    insurer: z.string().trim().min(1).max(100),
    insurance_type: z.string().trim().min(1).max(80),
    effective: isoDate,
    expiry: isoDate,
    status: z.enum(["Active", "Cancelled", "Expired"]).default("Active"),
  })
  .refine(
    (p) => p.expiry >= p.effective,
    "Expiry must be on or after effective date",
  );
const today = (cfg) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(cfg.now());
const plusDays = (date, n) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) =>
  Math.round(
    (new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000,
  );
function saveContact(db, input, existingId) {
  const c = contactSchema.parse(input);
  const cid = existingId || id();
  const old = existingId
    ? db.prepare("SELECT * FROM contacts WHERE id=?").get(existingId)
    : null;
  for (const channel of ["email", "whatsapp"])
    if (
      c[channel + "_consent"] &&
      !old?.[channel + "_consent"] &&
      !c.consent_note
    )
      throw new Error("Record when and how the client gave consent");
  if (old?.opted_out && !c.opted_out && !c.consent_note)
    throw new Error("Record renewed consent before clearing an opt-out");
  if (existingId) {
    db.prepare(
      "UPDATE contacts SET name=?,email=?,phone=?,notes=?,email_consent=?,whatsapp_consent=?,opted_out=? WHERE id=?",
    ).run(
      c.name,
      c.email || null,
      c.phone || null,
      c.notes,
      +c.email_consent,
      +c.whatsapp_consent,
      +c.opted_out,
      cid,
    );
  } else
    db.prepare("INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)").run(
      cid,
      c.name,
      c.email || null,
      c.phone || null,
      c.notes,
      +c.email_consent,
      +c.whatsapp_consent,
      +c.opted_out,
      new Date().toISOString(),
    );
  for (const channel of ["email", "whatsapp"])
    if (
      Number(c[channel + "_consent"]) !==
      Number(old?.[channel + "_consent"] || 0)
    )
      db.prepare("INSERT INTO consent_events VALUES(?,?,?,?,?,?)").run(
        id(),
        cid,
        channel,
        +c[channel + "_consent"],
        c.consent_note || "Consent removed by owner",
        new Date().toISOString(),
      );
  return cid;
}
function threadFor(db, contactId, channel, subject = "", externalId = null) {
  let t = db
    .prepare("SELECT * FROM threads WHERE contact_id=? AND channel=?")
    .get(contactId, channel);
  if (!t) {
    const tid = id();
    db.prepare(
      "INSERT INTO threads(id,contact_id,channel,subject,external_id) VALUES(?,?,?,?,?)",
    ).run(tid, contactId, channel, subject, externalId);
    t = db.prepare("SELECT * FROM threads WHERE id=?").get(tid);
  }
  return t;
}
function classify(text) {
  const t = text.toLowerCase();
  if (/\b(dob|date of birth|birth date|birthday)\b/.test(t))
    return "Date of birth correction";
  if (/\b(address|moved|moving)\b/.test(t)) return "Address update";
  if (
    /\b(phone|mobile|telephone)\b/.test(t) &&
    /\b(change|new|update|correct)\b/.test(t)
  )
    return "Phone number update";
  if (
    /\b(arriv|depart|travel|policy|start|expiry|effective)/.test(t) &&
    /\b(change|instead|update|new date|reschedul|extend|extension)/.test(t)
  )
    return "Policy date change";
  return null;
}
function inbound(db, cfg, input) {
  return db.transaction(() => {
    const event = db
      .prepare("INSERT OR IGNORE INTO inbound_events VALUES(?,?,?)")
      .run(input.channel, input.eventId, cfg.now().toISOString());
    if (!event.changes) return { duplicate: true };
    const address =
      input.channel === "email" ? input.address.toLowerCase() : input.address;
    let c = db
      .prepare(
        `SELECT * FROM contacts WHERE ${input.channel === "email" ? "email" : "phone"}=?`,
      )
      .get(address);
    if (!c) {
      const cid = saveContact(db, {
        name: (input.name || address).slice(0, 100),
        email: input.channel === "email" ? address : "",
        phone: input.channel === "whatsapp" ? address : "",
        notes: "",
      });
      c = db.prepare("SELECT * FROM contacts WHERE id=?").get(cid);
    }
    const t = threadFor(
        db,
        c.id,
        input.channel,
        input.subject || "",
        input.threadId || null,
      ),
      mid = id(),
      at = input.at || cfg.now().toISOString();
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
      mid,
      t.id,
      "in",
      input.text.slice(0, 20000),
      "received",
      input.eventId,
      input.rfcId || null,
      at,
    );
    db.prepare(
      "UPDATE threads SET last_inbound=?,external_id=COALESCE(?,external_id),subject=CASE WHEN ?<>'' THEN ? ELSE subject END WHERE id=?",
    ).run(
      at,
      input.threadId || null,
      input.subject || "",
      input.subject || "",
      t.id,
    );
    if (
      /\b(unsubscribe|opt[\s-]?out|do not (?:contact|message)|don\x27t (?:contact|message)|stop (?:messaging|contacting|sending)|please stop)\b|^\s*stop[\s.!]*$/i.test(
        input.text,
      )
    ) {
      db.prepare("UPDATE contacts SET opted_out=1 WHERE id=?").run(c.id);
      audit(db, "Client opted out", c.id);
      return { messageId: mid, optedOut: true };
    }
    // Receiving a message does not grant blanket outbound marketing consent.
    const kind = classify(input.text);
    if (kind && !input.automated) {
      const rid = id();
      db.prepare(
        "INSERT INTO requests(id,contact_id,channel,kind,detail,source_message,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        rid,
        c.id,
        input.channel,
        kind,
        input.text.slice(0, 20000),
        mid,
        cfg.now().toISOString(),
      );
      if (
        !input.historical &&
        JSON.parse(
          db.prepare("SELECT value FROM settings WHERE key='autoAck'").get()
            .value,
        ) &&
        !c.opted_out
      ) {
        const msg = id(),
          text = `Hi ${c.name.split(" ")[0]}, thanks for your message. We’ve received your ${kind.toLowerCase()} request and created a task for review. We’ll contact you about any information needed. Your policy has not been changed yet.`;
        db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
          msg,
          t.id,
          "out",
          text,
          "queued",
          null,
          null,
          cfg.now().toISOString(),
        );
        enqueue(
          db,
          "ack:" + rid,
          "send",
          { messageId: msg, requestId: rid, purpose: "ack" },
          cfg.now().toISOString(),
        );
        db.prepare("UPDATE requests SET ack_message_id=? WHERE id=?").run(
          msg,
          rid,
        );
      }
      audit(db, "Change request created", rid);
      return { messageId: mid, requestId: rid };
    }
    if (
      !db.prepare("SELECT id FROM leads WHERE contact_id=?").get(c.id) &&
      !kind &&
      !input.automated
    ) {
      db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?)").run(
        id(),
        c.id,
        "To confirm",
        "New enquiry",
        today(cfg),
        2,
        input.channel,
      );
    }
    audit(db, "Incoming conversation received", c.id);
    return { messageId: mid };
  })();
}
function schedule(db, cfg) {
  const at = cfg.now().toISOString(),
    day = today(cfg);
  if (
    !JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key='reminders'").get()
        .value,
    )
  )
    return 0;
  let count = 0;
  for (const p of db
    .prepare("SELECT * FROM policies WHERE status='Active'")
    .all())
    for (const event of ["effective", "expiry"]) {
      const days = daysBetween(day, p[event]);
      if (![7, 30].includes(days)) continue;
      const key = `reminder:${p.id}:${event}:${p[event]}:${days}`;
      const before = db
        .prepare("SELECT id FROM jobs WHERE dedupe_key=?")
        .get(key);
      enqueue(
        db,
        key,
        "reminder",
        { policyId: p.id, event, date: p[event], days },
        at,
      );
      if (!before) count++;
    }
  return count;
}
function parsePolicies(db, text) {
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    max_record_size: 10000,
    trim: true,
  });
  if (rows.length > 1000) throw new Error("Maximum 1000 rows per import");
  if (!rows.length) throw new Error("The CSV is empty");
  const errors = [],
    items = [],
    seen = new Set();
  rows.forEach((row, i) => {
    try {
      const emailValue = email.parse(row.email);
      const c = db
        .prepare("SELECT id FROM contacts WHERE email=?")
        .get(emailValue);
      if (!c) throw new Error("Create the client with this email first");
      const p = policySchema.parse({
        contact_id: c.id,
        number: row.number,
        insurer: row.insurer,
        insurance_type: row.insurance_type,
        effective: row.effective,
        expiry: row.expiry,
        status: row.status || "Active",
      });
      if (
        seen.has(p.number) ||
        db.prepare("SELECT id FROM policies WHERE number=?").get(p.number)
      )
        throw new Error("Duplicate policy number");
      seen.add(p.number);
      items.push(p);
    } catch (e) {
      errors.push({
        row: i + 2,
        error: e.issues?.map((x) => x.message).join("; ") || e.message,
      });
    }
  });
  return { items, errors };
}
module.exports = {
  leadSchema,
  policySchema,
  contactSchema,
  isoDate,
  today,
  plusDays,
  daysBetween,
  saveContact,
  threadFor,
  classify,
  inbound,
  schedule,
  parsePolicies,
};
