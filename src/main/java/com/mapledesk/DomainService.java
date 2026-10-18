package com.mapledesk;

import static com.mapledesk.Json.*;
import static com.mapledesk.Settings.require;

import java.io.StringReader;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Pattern;
import org.apache.commons.csv.*;
import org.springframework.stereotype.Service;

@Service
public class DomainService {
  private final Database db;
  private final Settings cfg;

  public DomainService(Database db, Settings cfg) {
    this.db = db;
    this.cfg = cfg;
  }

  public String saveContact(Input.Contact c, String existing) {
    return db.tx(
        () -> {
          String cid = existing == null ? Database.id() : existing;
          var old = existing == null ? null : db.one("SELECT * FROM contacts WHERE id=?", existing);
          if (existing != null) require(old != null, "Client not found");
          if ((c.emailConsent() && !flag(old, "email_consent")
                  || c.whatsappConsent() && !flag(old, "whatsapp_consent")
                  || flag(old, "opted_out") && !c.optedOut())
              && c.consentNote().isEmpty())
            throw new IllegalArgumentException("Record when and how the client gave consent");
          Object email = c.email().isEmpty() ? null : c.email(),
              phone = c.phone().isEmpty() ? null : c.phone();
          if (existing == null)
            db.update(
                "INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)",
                cid,
                c.name(),
                email,
                phone,
                c.notes(),
                c.emailConsent() ? 1 : 0,
                c.whatsappConsent() ? 1 : 0,
                c.optedOut() ? 1 : 0,
                cfg.at());
          else
            db.update(
                "UPDATE contacts SET"
                    + " name=?,email=?,phone=?,notes=?,email_consent=?,whatsapp_consent=?,opted_out=?"
                    + " WHERE id=?",
                c.name(),
                email,
                phone,
                c.notes(),
                c.emailConsent() ? 1 : 0,
                c.whatsappConsent() ? 1 : 0,
                c.optedOut() ? 1 : 0,
                cid);
          for (String channel : List.of("email", "whatsapp")) {
            boolean granted = channel.equals("email") ? c.emailConsent() : c.whatsappConsent();
            if (granted != flag(old, channel + "_consent"))
              db.update(
                  "INSERT INTO consent_events VALUES(?,?,?,?,?,?)",
                  Database.id(),
                  cid,
                  channel,
                  granted ? 1 : 0,
                  c.consentNote().isEmpty() ? "Consent removed by owner" : c.consentNote(),
                  cfg.at());
          }
          return cid;
        });
  }

  public static boolean flag(Map<String, Object> map, String key) {
    return map != null && bool(map.get(key));
  }

  public String saveLead(Input.Lead input, String id) {
    return db.tx(
        () -> {
          String cid, lid = id;
          if (id == null) {
            lid = Database.id();
            cid = saveContact(input.contact(), null);
            db.update(
                "INSERT INTO leads VALUES(?,?,?,?,?,?,?)",
                lid,
                cid,
                input.insuranceType(),
                input.status(),
                input.due(),
                input.intervalDays(),
                input.channel());
          } else {
            var old = db.one("SELECT * FROM leads WHERE id=?", id);
            if (old == null) throw new ApiException(404, "Lead not found");
            cid = saveContact(input.contact(), str(old, "contact_id"));
            db.update(
                "UPDATE leads SET insurance_type=?,status=?,due=?,interval_days=?,channel=? WHERE"
                    + " id=?",
                input.insuranceType(),
                input.status(),
                input.due(),
                input.intervalDays(),
                input.channel(),
                id);
          }
          db.audit(id == null ? "Lead created" : "Lead updated", lid);
          return lid;
        });
  }

  public String savePolicy(Input.Policy p, String id) {
    return db.tx(
        () -> {
          require(
              db.one("SELECT id FROM contacts WHERE id=?", p.contactId()) != null,
              "Client not found");
          String pid = id == null ? Database.id() : id;
          if (id == null)
            db.update(
                "INSERT INTO policies VALUES(?,?,?,?,?,?,?,?,?)",
                pid,
                p.contactId(),
                p.number(),
                p.insurer(),
                p.insuranceType(),
                p.effective(),
                p.expiry(),
                p.status(),
                cfg.at());
          else {
            if (db.one("SELECT id FROM policies WHERE id=?", id) == null)
              throw new ApiException(404, "Policy not found");
            db.update(
                "UPDATE policies SET"
                    + " contact_id=?,number=?,insurer=?,insurance_type=?,effective=?,expiry=?,status=?,verified_at=?"
                    + " WHERE id=?",
                p.contactId(),
                p.number(),
                p.insurer(),
                p.insuranceType(),
                p.effective(),
                p.expiry(),
                p.status(),
                cfg.at(),
                id);
          }
          db.audit(
              id == null
                  ? "Policy created"
                  : "Policy updated; obsolete reminders will be cancelled",
              pid);
          schedule();
          return pid;
        });
  }

  public Map<String, Object> thread(String cid, String channel, String subject, String external) {
    var t = db.one("SELECT * FROM threads WHERE contact_id=? AND channel=?", cid, channel);
    if (t != null) return t;
    String id = Database.id();
    db.update(
        "INSERT INTO threads(id,contact_id,channel,subject,external_id) VALUES(?,?,?,?,?)",
        id,
        cid,
        channel,
        subject == null ? "" : subject,
        external);
    return db.one("SELECT * FROM threads WHERE id=?", id);
  }

  public static String classify(String text) {
    String t = text.toLowerCase(Locale.ROOT);
    if (t.matches("(?s).*\\b(dob|date of birth|birth date|birthday)\\b.*"))
      return "Date of birth correction";
    if (t.matches("(?s).*\\b(address|moved|moving)\\b.*")) return "Address update";
    if (t.matches("(?s).*\\b(phone|mobile|telephone)\\b.*")
        && t.matches("(?s).*\\b(change|new|update|correct)\\b.*")) return "Phone number update";
    if (Pattern.compile("\\b(arriv|depart|travel|policy|start|expiry|effective)").matcher(t).find()
        && Pattern.compile("\\b(change|instead|update|new date|reschedul|extend|extension)")
            .matcher(t)
            .find()) return "Policy date change";
    return null;
  }

  public record Incoming(
      String channel,
      String eventId,
      String address,
      String name,
      String text,
      String subject,
      String externalId,
      String rfcId,
      Instant at,
      boolean historical,
      boolean automated) {}

  public Map<String, Object> incoming(Incoming p) {
    return db.tx(
        () -> {
          require(List.of("email", "whatsapp").contains(p.channel()), "Invalid channel");
          String address =
              p.channel().equals("email")
                  ? p.address().trim().toLowerCase(Locale.ROOT)
                  : p.address();
          require(
              p.channel().equals("email") ? Input.email(address) : Input.phone(address),
              "Invalid channel address");
          if (db.update(
                  "INSERT OR IGNORE INTO inbound_events VALUES(?,?,?)",
                  p.channel(),
                  p.eventId(),
                  cfg.at())
              == 0) return map("duplicate", true);
          var c =
              db.one(
                  "SELECT * FROM contacts WHERE "
                      + (p.channel().equals("email") ? "email" : "phone")
                      + "=?",
                  address);
          if (c == null) {
            String name = p.name() == null || p.name().isBlank() ? address : p.name();
            name = name.substring(0, Math.min(name.length(), 100));
            String cid =
                saveContact(
                    new Input.Contact(
                        name,
                        p.channel().equals("email") ? address : "",
                        p.channel().equals("whatsapp") ? address : "",
                        "",
                        false,
                        false,
                        false,
                        ""),
                    null);
            c = db.one("SELECT * FROM contacts WHERE id=?", cid);
          }
          String cid = str(c, "id"),
              mid = Database.id(),
              text = p.text().substring(0, Math.min(p.text().length(), 20000)),
              at = Time.iso(p.at() == null ? cfg.now() : p.at());
          var t = thread(cid, p.channel(), p.subject(), p.externalId());
          db.update(
              "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
              mid,
              t.get("id"),
              "in",
              text,
              "received",
              p.eventId(),
              p.rfcId(),
              at);
          db.update(
              "UPDATE threads SET last_inbound=?,external_id=COALESCE(?,external_id),subject=CASE"
                  + " WHEN ?<>'' THEN ? ELSE subject END WHERE id=?",
              at,
              p.externalId(),
              p.subject() == null ? "" : p.subject(),
              p.subject() == null ? "" : p.subject(),
              t.get("id"));
          if (Pattern.compile(
                  "\\b(unsubscribe|opt[\\s-]?out|do not (?:contact|message)|don't"
                      + " (?:contact|message)|stop (?:messaging|contacting|sending)|please"
                      + " stop)\\b|^\\s*stop[\\s.!]*$",
                  Pattern.CASE_INSENSITIVE)
              .matcher(text)
              .find()) {
            db.update("UPDATE contacts SET opted_out=1 WHERE id=?", cid);
            db.audit("Client opted out", cid);
            return map("messageId", mid, "optedOut", true);
          }
          String kind = classify(text);
          if (kind != null && !p.automated()) {
            String rid = Database.id();
            db.update(
                "INSERT INTO requests(id,contact_id,channel,kind,detail,source_message,created_at)"
                    + " VALUES(?,?,?,?,?,?,?)",
                rid,
                cid,
                p.channel(),
                kind,
                text,
                mid,
                cfg.at());
            if (!p.historical() && db.setting("autoAck") && !flag(c, "opted_out")) {
              String ack = Database.id(),
                  reply =
                      "Hi "
                          + str(c, "name").split(" ")[0]
                          + ", thanks for your message. We’ve received your "
                          + kind.toLowerCase(Locale.ROOT)
                          + " request and created a task for review. We’ll contact you about any"
                          + " information needed. Your policy has not been changed yet.";
              db.update(
                  "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
                  ack,
                  t.get("id"),
                  "out",
                  reply,
                  "queued",
                  null,
                  null,
                  cfg.at());
              db.enqueue(
                  "ack:" + rid,
                  "send",
                  map("messageId", ack, "requestId", rid, "purpose", "ack"),
                  cfg.at());
              db.update("UPDATE requests SET ack_message_id=? WHERE id=?", ack, rid);
            }
            db.audit("Change request created", rid);
            return map("messageId", mid, "requestId", rid);
          }
          if (kind == null
              && !p.automated()
              && db.one("SELECT id FROM leads WHERE contact_id=?", cid) == null
              && db.one("SELECT id FROM policies WHERE contact_id=?", cid) == null)
            db.update(
                "INSERT INTO leads VALUES(?,?,?,?,?,?,?)",
                Database.id(),
                cid,
                "To confirm",
                "New enquiry",
                cfg.today(),
                2,
                p.channel());
          db.audit("Incoming conversation received", cid);
          return map("messageId", mid);
        });
  }

  public int schedule() {
    if (!db.setting("reminders")) return 0;
    return db.tx(
        () -> {
          int count = 0;
          for (var p : db.list("SELECT * FROM policies WHERE status='Active'"))
            for (String event : List.of("effective", "expiry")) {
              long days =
                  ChronoUnit.DAYS.between(
                      LocalDate.parse(cfg.today()), LocalDate.parse(str(p, event)));
              if (days != 7 && days != 30) continue;
              String key =
                  "reminder:" + p.get("id") + ":" + event + ":" + p.get(event) + ":" + days;
              if (db.one("SELECT id FROM jobs WHERE dedupe_key=?", key) == null) {
                db.enqueue(
                    key,
                    "reminder",
                    map(
                        "policyId",
                        p.get("id"),
                        "event",
                        event,
                        "date",
                        p.get(event),
                        "days",
                        days),
                    cfg.at());
                count++;
              }
            }
          return count;
        });
  }

  public Map<String, Object> importCsv(String csv, boolean confirm) {
    require(csv != null && csv.length() <= 800000, "CSV must be smaller than 800 KB");
    if (csv.startsWith("\ufeff")) csv = csv.substring(1);
    List<Input.Policy> items = new ArrayList<>();
    List<Map<String, Object>> errors = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    try (var parser =
        CSVFormat.DEFAULT
            .builder()
            .setHeader()
            .setSkipHeaderRecord(true)
            .setIgnoreEmptyLines(true)
            .setTrim(true)
            .get()
            .parse(new StringReader(csv))) {
      var records = parser.getRecords();
      require(!records.isEmpty() && records.size() <= 1000, "CSV must contain 1–1000 rows");
      for (var row : records) {
        try {
          String email = row.get("email").toLowerCase(Locale.ROOT);
          require(Input.email(email), "Invalid email");
          var c = db.one("SELECT id FROM contacts WHERE email=?", email);
          require(c != null, "Create the client with this email first");
          var p =
              new Input.Policy(
                  str(c, "id"),
                  row.get("number"),
                  row.get("insurer"),
                  row.get("insurance_type"),
                  row.get("effective"),
                  row.get("expiry"),
                  row.isMapped("status") && !row.get("status").isBlank()
                      ? row.get("status")
                      : "Active");
          require(
              seen.add(p.number())
                  && db.one("SELECT id FROM policies WHERE number=?", p.number()) == null,
              "Duplicate policy number");
          items.add(p);
        } catch (Exception e) {
          errors.add(map("row", row.getRecordNumber() + 1, "error", e.getMessage()));
        }
      }
    } catch (java.io.IOException e) {
      throw new IllegalArgumentException("Invalid CSV quoting or headers");
    }
    if (confirm) {
      require(errors.isEmpty(), "Correct all preview errors before importing");
      db.tx(
          () -> {
            for (var p : items) savePolicy(p, null);
            db.audit("Policy CSV imported", null);
            return null;
          });
    }
    var preview =
        items.stream()
            .map(
                p ->
                    map(
                        "contact_id",
                        p.contactId(),
                        "number",
                        p.number(),
                        "insurer",
                        p.insurer(),
                        "insurance_type",
                        p.insuranceType(),
                        "effective",
                        p.effective(),
                        "expiry",
                        p.expiry(),
                        "status",
                        p.status()))
            .toList();
    return map("items", preview, "errors", errors, "imported", confirm ? items.size() : 0);
  }
}
