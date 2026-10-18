package com.mapledesk;

import static com.mapledesk.Json.*;
import static com.mapledesk.Settings.require;

import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class JobService {
  private final Database db;
  private final Settings cfg;
  private final DomainService domain;
  private final IntegrationService integrations;
  private final AtomicBoolean busy = new AtomicBoolean();
  private long lastSync;

  public JobService(
      Database db, Settings cfg, DomainService domain, IntegrationService integrations) {
    this.db = db;
    this.cfg = cfg;
    this.domain = domain;
    this.integrations = integrations;
  }

  public record Recipient(Map<String, Object> thread, Map<String, Object> contact) {}

  public Recipient check(Map<String, Object> message, Map<String, Object> payload) {
    var thread = db.one("SELECT * FROM threads WHERE id=?", message.get("thread_id"));
    require(thread != null, "Conversation not found");
    var c = db.one("SELECT * FROM contacts WHERE id=?", thread.get("contact_id"));
    require(!DomainService.flag(c, "opted_out"), "Client has opted out");
    String purpose = str(payload, "purpose"), channel = str(thread, "channel");
    if (purpose.equals("followup")) {
      var l = db.one("SELECT * FROM leads WHERE id=?", payload.get("leadId"));
      require(
          l != null && !List.of("Won", "Lost").contains(str(l, "status")),
          "Sales follow-up cancelled: lead is closed");
    }
    if (payload.get("policyId") != null) {
      var p = db.one("SELECT * FROM policies WHERE id=?", payload.get("policyId"));
      require(
          p != null
              && str(p, "status").equals("Active")
              && Objects.equals(p.get(str(payload, "event")), payload.get("policyDate")),
          "Reminder cancelled: policy was changed");
    }
    boolean recent = false;
    if (thread.get("last_inbound") != null) {
      long delta =
          Duration.between(Instant.parse(str(thread, "last_inbound")), cfg.now()).toMillis();
      recent = delta >= 0 && delta < 86400000;
    }
    require(
        purpose.equals("ack") && recent || DomainService.flag(c, channel + "_consent"),
        "Record client consent before sending on this channel");
    require(
        !str(c, channel.equals("email") ? "email" : "phone").isEmpty(),
        "Client address is missing");
    require(
        !channel.equals("whatsapp") || recent || payload.get("template") != null,
        "WhatsApp requires an approved template outside the 24-hour service window");
    if (payload.get("template") != null)
      require(
          integrations
              .templateText(Json.MAPPER.convertValue(payload.get("template"), Input.Template.class))
              .equals(message.get("text")),
          "Template preview and message text do not match");
    if (cfg.mode().equals("live")) {
      require(cfg.liveSends(), "Live sending is disabled in environment settings");
      require(
          channel.equals("email") ? integrations.integration("gmail") != null : cfg.whatsappReady(),
          channel.equals("email") ? "Gmail is disconnected" : "WhatsApp API is not configured");
    }
    return new Recipient(thread, c);
  }

  public Map<String, Object> queue(Input.Message p) {
    return db.tx(
        () -> {
          var c = db.one("SELECT * FROM contacts WHERE id=?", p.contactId());
          require(c != null, "Client not found");
          if (p.purpose().equals("followup"))
            require(
                db.one("SELECT * FROM leads WHERE id=? AND contact_id=?", p.leadId(), p.contactId())
                    != null,
                "Follow-up lead does not match this client");
          String policyDate = policyDate(p);
          String key =
              p.reminderJobId() == null ? "owner:" + p.key() : "reminder-send:" + p.reminderJobId();
          var source = reminderSource(p, policyDate);
          String text = p.template() == null ? p.text() : integrations.templateText(p.template());
          var t = domain.thread(p.contactId(), p.channel(), p.subject(), null);
          var old = db.one("SELECT * FROM jobs WHERE dedupe_key=?", key);
          if (old != null) {
            String mid = str(Json.read(str(old, "payload")), "messageId");
            var prior = db.one("SELECT * FROM messages WHERE id=?", mid);
            require(
                prior != null
                    && prior.get("thread_id").equals(t.get("id"))
                    && prior.get("text").equals(text),
                "This request key was already used for a different message");
            return map("messageId", mid, "jobId", old.get("id"), "duplicate", true);
          }
          require(
              source == null || str(source, "status").equals("draft"),
              "This reminder is already being handled; inspect its outcome before sending again");
          String mid = Database.id();
          var payload =
              map(
                  "messageId",
                  mid,
                  "purpose",
                  p.purpose(),
                  "leadId",
                  p.leadId(),
                  "policyId",
                  p.policyId(),
                  "event",
                  p.event(),
                  "policyDate",
                  policyDate,
                  "reminderJobId",
                  p.reminderJobId(),
                  "template",
                  p.template());
          check(map("thread_id", t.get("id"), "text", text), payload);
          db.update(
              "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
              mid,
              t.get("id"),
              "out",
              text,
              "queued",
              null,
              null,
              cfg.at());
          String jid = db.enqueue(key, "send", payload, cfg.at());
          if (source != null)
            db.update("UPDATE jobs SET status='queued' WHERE id=?", p.reminderJobId());
          db.audit("Message queued for " + p.channel(), mid);
          return map("messageId", mid, "jobId", jid);
        });
  }

  private String policyDate(Input.Message p) {
    if (!p.purpose().equals("reminder")) return null;
    require(db.setting("reminders"), "Reminders are disabled");
    var policy =
        db.one("SELECT * FROM policies WHERE id=? AND contact_id=?", p.policyId(), p.contactId());
    require(
        policy != null && p.event() != null, "Reminder requires a matching policy and date type");
    return str(policy, p.event());
  }

  private Map<String, Object> reminderSource(Input.Message p, String date) {
    if (p.reminderJobId() == null) return null;
    var row = db.one("SELECT * FROM jobs WHERE id=? AND type='reminder'", p.reminderJobId());
    require(row != null, "Reminder draft not found");
    var source = Json.read(str(row, "payload"));
    require(
        Objects.equals(source.get("policyId"), p.policyId())
            && Objects.equals(source.get("event"), p.event())
            && Objects.equals(source.get("date"), date),
        "Reminder draft no longer matches the policy");
    return row;
  }

  public Map<String, Object> handoff(Input.Message p) {
    return db.tx(
        () -> {
          require(p.channel().equals("whatsapp"), "Handoff is for WhatsApp only");
          var c = db.one("SELECT * FROM contacts WHERE id=?", p.contactId());
          require(c != null && !str(c, "phone").isEmpty(), "Client WhatsApp phone is missing");
          require(
              !DomainService.flag(c, "opted_out") && DomainService.flag(c, "whatsapp_consent"),
              "Client consent is required and opt-outs must be respected");
          if (p.purpose().equals("followup")) {
            var l =
                db.one(
                    "SELECT * FROM leads WHERE id=? AND contact_id=?", p.leadId(), p.contactId());
            require(
                l != null && !List.of("Won", "Lost").contains(str(l, "status")),
                "Follow-up lead is closed or invalid");
          }
          String date = policyDate(p);
          if (p.purpose().equals("reminder"))
            require(
                "Active"
                    .equals(
                        db.one("SELECT status FROM policies WHERE id=?", p.policyId())
                            .get("status")),
                "Policy is not active");
          var source = reminderSource(p, date);
          String key =
              p.reminderJobId() == null
                  ? "handoff:" + p.key()
                  : "reminder-handoff:" + p.reminderJobId();
          var old = db.one("SELECT * FROM jobs WHERE dedupe_key=?", key);
          String mid;
          if (old != null) {
            mid = str(Json.read(str(old, "payload")), "messageId");
            var m =
                db.one(
                    "SELECT messages.*,threads.contact_id FROM messages JOIN threads ON"
                        + " threads.id=messages.thread_id WHERE messages.id=?",
                    mid);
            require(
                m != null
                    && m.get("contact_id").equals(p.contactId())
                    && m.get("text").equals(p.text()),
                "This request key was already used for a different draft");
          } else {
            require(
                source == null || str(source, "status").equals("draft"),
                "This reminder is already being handled");
            mid = Database.id();
            var thread = domain.thread(p.contactId(), "whatsapp", "", null);
            db.update(
                "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
                mid,
                thread.get("id"),
                "out",
                p.text(),
                "handoff",
                null,
                null,
                cfg.at());
            db.update(
                "INSERT INTO jobs(id,dedupe_key,type,payload,status,available_at,created_at)"
                    + " VALUES(?,?,?,?,?,?,?)",
                Database.id(),
                key,
                "manual",
                write(
                    map(
                        "messageId",
                        mid,
                        "purpose",
                        p.purpose(),
                        "leadId",
                        p.leadId(),
                        "policyId",
                        p.policyId(),
                        "event",
                        p.event(),
                        "policyDate",
                        date,
                        "reminderJobId",
                        p.reminderJobId())),
                "awaiting_owner",
                cfg.at(),
                cfg.at());
            if (source != null)
              db.update("UPDATE jobs SET status='awaiting_owner' WHERE id=?", p.reminderJobId());
            db.audit("WhatsApp draft handed off; not marked sent", mid);
          }
          return map(
              "messageId",
              mid,
              "url",
              "https://wa.me/"
                  + str(c, "phone").substring(1)
                  + "?text="
                  + java.net.URLEncoder.encode(p.text(), java.nio.charset.StandardCharsets.UTF_8)
                      .replace("+", "%20"));
        });
  }

  public void confirmManual(String id) {
    db.tx(
        () -> {
          var m = db.one("SELECT * FROM messages WHERE id=? AND status='handoff'", id);
          require(m != null, "Message is not awaiting manual confirmation");
          var job =
              db.one(
                  "SELECT * FROM jobs WHERE type='manual' AND"
                      + " json_extract(payload,'$.messageId')=?",
                  id);
          var p = Json.read(str(job, "payload"));
          db.update("UPDATE messages SET status='manual_sent' WHERE id=?", id);
          db.update("UPDATE jobs SET status='done' WHERE id=?", job.get("id"));
          advanceLead(p);
          if (p.get("reminderJobId") != null) {
            var policy = db.one("SELECT * FROM policies WHERE id=?", p.get("policyId"));
            boolean valid =
                policy != null
                    && str(policy, "status").equals("Active")
                    && Objects.equals(policy.get(str(p, "event")), p.get("policyDate"));
            db.update(
                "UPDATE jobs SET status=? WHERE id=?",
                valid ? "done" : "cancelled",
                p.get("reminderJobId"));
          }
          db.audit("Owner confirmed manual WhatsApp send; no provider delivery receipt", id);
          return null;
        });
  }

  private void advanceLead(Map<String, Object> p) {
    if (!"followup".equals(p.get("purpose"))) return;
    var l = db.one("SELECT * FROM leads WHERE id=?", p.get("leadId"));
    if (l != null && !List.of("Won", "Lost").contains(str(l, "status")))
      db.update(
          "UPDATE leads SET due=?,status='Awaiting reply' WHERE id=?",
          LocalDate.parse(cfg.today()).plusDays(number(l.get("interval_days"))).toString(),
          l.get("id"));
  }

  public boolean work() {
    for (var stale :
        db.list("SELECT * FROM jobs WHERE status='running' AND lease_until<?", cfg.at())) {
      var p = Json.read(str(stale, "payload"));
      db.tx(
          () -> {
            db.update(
                "UPDATE jobs SET status='needs_review',last_error='Interrupted operation; check"
                    + " provider before resending' WHERE id=?",
                stale.get("id"));
            if (p.get("messageId") != null)
              db.update(
                  "UPDATE messages SET status='needs_review' WHERE id=? AND status='sending'",
                  p.get("messageId"));
            if (p.get("reminderJobId") != null)
              db.update(
                  "UPDATE jobs SET status='needs_review',last_error='Interrupted send; inspect"
                      + " provider history' WHERE id=?",
                  p.get("reminderJobId"));
            return null;
          });
    }
    var job =
        db.tx(
            () -> {
              var row =
                  db.one(
                      "SELECT * FROM jobs WHERE status='pending' AND available_at<=? ORDER BY"
                          + " available_at LIMIT 1",
                      cfg.at());
              if (row != null)
                db.update(
                    "UPDATE jobs SET status='running',attempts=attempts+1,lease_until=? WHERE id=?",
                    Time.iso(cfg.now().plusSeconds(120)),
                    row.get("id"));
              return row;
            });
    if (job == null) return false;
    var p = Json.read(str(job, "payload"));
    boolean attempted = false;
    try {
      if (str(job, "type").equals("reminder")) {
        var policy = db.one("SELECT * FROM policies WHERE id=?", p.get("policyId"));
        if (!db.setting("reminders")
            || policy == null
            || !str(policy, "status").equals("Active")
            || !Objects.equals(policy.get(str(p, "event")), p.get("date"))) {
          db.update("UPDATE jobs SET status='cancelled' WHERE id=?", job.get("id"));
          return true;
        }
        db.audit(
            "Reminder draft ready: " + p.get("event") + " in " + p.get("days") + " days",
            policy.get("id"));
        db.update("UPDATE jobs SET status='draft' WHERE id=?", job.get("id"));
        return true;
      }
      require(str(job, "type").equals("send"), "Unknown job type");
      var message = db.one("SELECT * FROM messages WHERE id=?", p.get("messageId"));
      require(message != null, "Message not found");
      Recipient recipient = check(message, p);
      db.update("UPDATE messages SET status='sending' WHERE id=?", message.get("id"));
      attempted = true;
      Map<String, Object> result;
      if (cfg.mode().equals("mock"))
        result = map("providerId", "mock:" + message.get("id"), "status", "simulated");
      else if (str(recipient.thread(), "channel").equals("email"))
        result =
            integrations.sendGmail(
                recipient.contact(),
                recipient.thread(),
                str(message, "text"),
                str(p, "purpose").equals("ack"));
      else
        result =
            integrations.sendWhatsapp(
                recipient.contact(),
                str(message, "text"),
                p.get("template") == null
                    ? null
                    : Json.MAPPER.convertValue(p.get("template"), Input.Template.class));
      var finalResult = result;
      db.tx(
          () -> {
            db.update(
                "UPDATE messages SET status=?,provider_id=? WHERE id=?",
                finalResult.get("status"),
                finalResult.get("providerId"),
                message.get("id"));
            if (finalResult.get("externalId") != null)
              db.update(
                  "UPDATE threads SET external_id=? WHERE id=?",
                  finalResult.get("externalId"),
                  recipient.thread().get("id"));
            db.update("UPDATE jobs SET status='done',last_error=NULL WHERE id=?", job.get("id"));
            if (p.get("reminderJobId") != null)
              db.update("UPDATE jobs SET status='done' WHERE id=?", p.get("reminderJobId"));
            advanceLead(p);
            db.audit(
                cfg.mode().equals("mock") ? "Message simulated" : "Provider accepted message",
                message.get("id"));
            return null;
          });
    } catch (Exception e) {
      int status = e instanceof ProviderTransport.Failure failure ? failure.status : 0;
      boolean
          ambiguous =
              attempted
                  && (status == 0
                      || e instanceof ProviderTransport.Failure failure && failure.ambiguous),
          retry = status == 429 && number(job.get("attempts")) < 4;
      String outcome = retry ? "pending" : ambiguous ? "needs_review" : "failed",
          error =
              e instanceof IllegalArgumentException || e instanceof ProviderTransport.Failure
                  ? e.getMessage()
                  : "Operation failed; inspect provider history before retrying";
      db.tx(
          () -> {
            db.update(
                "UPDATE jobs SET status=?,available_at=?,last_error=? WHERE id=?",
                outcome,
                Time.iso(cfg.now().plusSeconds(60L * (1L << number(job.get("attempts"))))),
                error,
                job.get("id"));
            if (p.get("messageId") != null)
              db.update(
                  "UPDATE messages SET status=? WHERE id=?",
                  retry ? "queued" : outcome,
                  p.get("messageId"));
            if (p.get("reminderJobId") != null && !retry)
              db.update(
                  "UPDATE jobs SET status=?,last_error=? WHERE id=?",
                  outcome,
                  error,
                  p.get("reminderJobId"));
            db.audit("Background job " + outcome, job.get("id"));
            return null;
          });
    }
    return true;
  }

  @Scheduled(
      fixedDelayString = "${WORKER_DELAY_MS:5000}",
      initialDelayString = "${WORKER_DELAY_MS:5000}")
  public void tick() {
    if (!busy.compareAndSet(false, true)) return;
    try {
      domain.schedule();
      if (cfg.mode().equals("live")
          && cfg.now().toEpochMilli() - lastSync > 300000
          && db.one("SELECT name FROM integrations WHERE name='gmail'") != null) {
        lastSync = cfg.now().toEpochMilli();
        try {
          integrations.syncGmail();
        } catch (Exception e) {
          var current = integrations.integration("gmail");
          if (current != null) {
            var metadata = obj(current.get("metadata"));
            metadata.put(
                "lastError",
                e instanceof ProviderTransport.Failure || e instanceof IllegalArgumentException
                    ? e.getMessage()
                    : "Mailbox sync failed; check connection");
            integrations.saveMetadata(metadata);
          }
        }
      }
      for (int i = 0; i < 20; i++) if (!work()) break;
    } catch (Exception e) {
      org.slf4j.LoggerFactory.getLogger(getClass())
          .warn("Background processing stopped for this tick: {}", e.getClass().getSimpleName());
    } finally {
      busy.set(false);
    }
  }
}
