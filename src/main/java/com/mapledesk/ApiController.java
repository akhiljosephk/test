package com.mapledesk;

import static com.mapledesk.Json.*;
import static com.mapledesk.Settings.require;

import jakarta.servlet.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
public class ApiController {
  private final Database db;
  private final Settings cfg;
  private final DomainService domain;
  private final AuthService auth;
  private final JobService jobs;
  private final IntegrationService integrations;

  public ApiController(
      Database db,
      Settings cfg,
      DomainService domain,
      AuthService auth,
      JobService jobs,
      IntegrationService integrations) {
    this.db = db;
    this.cfg = cfg;
    this.domain = domain;
    this.auth = auth;
    this.jobs = jobs;
    this.integrations = integrations;
  }

  @GetMapping("/healthz")
  public Map<String, Object> health() {
    db.number("SELECT 1");
    return map("status", "ok");
  }

  @GetMapping("/api/session")
  public Map<String, Object> session(HttpServletRequest request) {
    var s = sessionRow(request);
    return map("email", s.get("email"), "csrf", s.get("csrf"));
  }

  @PostMapping("/api/login")
  public ResponseEntity<?> login(
      @RequestBody Map<String, Object> body, HttpServletRequest request) {
    var result =
        auth.login(
            str(body, "email"), str(body, "password"), str(body, "code"), request.getRemoteAddr());
    var cookie =
        ResponseCookie.from("md_session", str(result, "token"))
            .httpOnly(true)
            .secure(cfg.production())
            .sameSite("Lax")
            .path("/")
            .maxAge(12 * 3600)
            .build();
    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, cookie.toString())
        .body(map("email", result.get("email"), "csrf", result.get("csrf")));
  }

  @PostMapping("/api/logout")
  public ResponseEntity<?> logout(HttpServletRequest request) {
    db.update("DELETE FROM sessions WHERE token_hash=?", Crypto.sha(SecurityConfig.token(request)));
    var cookie =
        ResponseCookie.from("md_session", "")
            .httpOnly(true)
            .secure(cfg.production())
            .sameSite("Lax")
            .path("/")
            .maxAge(0)
            .build();
    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, cookie.toString())
        .body(map("ok", true));
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> sessionRow(HttpServletRequest request) {
    return (Map<String, Object>) request.getAttribute("md.session");
  }

  @GetMapping("/api/state")
  public Map<String, Object> state(HttpServletRequest request) {
    var gmail = cfg.key().isEmpty() ? null : integrations.integration("gmail");
    var meta = gmail == null ? new LinkedHashMap<String, Object>() : obj(gmail.get("metadata"));
    var jobRows =
        db.list(
            "SELECT id,type,status,payload,last_error,created_at FROM jobs ORDER BY created_at DESC"
                + " LIMIT 200");
    jobRows.forEach(j -> j.put("payload", Json.read(str(j, "payload"))));
    return map(
        "business",
        cfg.business(),
        "today",
        cfg.today(),
        "timezone",
        cfg.timezone(),
        "mode",
        cfg.mode(),
        "liveSends",
        cfg.liveSends(),
        "owner",
        sessionRow(request).get("email"),
        "contacts",
        db.list("SELECT * FROM contacts ORDER BY created_at DESC"),
        "leads",
        db.list("SELECT * FROM leads ORDER BY due"),
        "policies",
        db.list("SELECT * FROM policies ORDER BY expiry"),
        "threads",
        db.list("SELECT * FROM threads"),
        "messages",
        db.list("SELECT * FROM messages ORDER BY created_at"),
        "requests",
        db.list("SELECT * FROM requests ORDER BY created_at DESC"),
        "jobs",
        jobRows,
        "audit",
        db.list("SELECT * FROM audit ORDER BY created_at DESC LIMIT 100"),
        "settings",
        map("autoAck", db.setting("autoAck"), "reminders", db.setting("reminders")),
        "integrations",
        map(
            "gmail",
            map(
                "configured",
                cfg.googleReady(),
                "connected",
                gmail != null,
                "address",
                meta.get("address"),
                "lastSync",
                meta.get("lastSync"),
                "error",
                meta.get("lastError") != null ? meta.get("lastError") : meta.get("gapWarning")),
            "whatsapp",
            map("configured", cfg.whatsappReady(), "templates", cfg.templates())));
  }

  @PostMapping("/api/leads")
  public ResponseEntity<?> createLead(@RequestBody Map<String, Object> body) {
    return ResponseEntity.status(201)
        .body(map("id", domain.saveLead(Input.parse(body, Input.Lead.class), null)));
  }

  @PutMapping("/api/leads/{id}")
  public Map<String, Object> updateLead(
      @PathVariable String id, @RequestBody Map<String, Object> body) {
    domain.saveLead(Input.parse(body, Input.Lead.class), Input.uuid(id));
    return map("ok", true);
  }

  @PutMapping("/api/contacts/{id}")
  public Map<String, Object> updateContact(
      @PathVariable String id, @RequestBody Map<String, Object> body) {
    domain.saveContact(Input.parse(body, Input.Contact.class), Input.uuid(id));
    db.audit("Client contact details and consent updated", id);
    return map("ok", true);
  }

  @PostMapping("/api/policies")
  public ResponseEntity<?> createPolicy(@RequestBody Map<String, Object> body) {
    return ResponseEntity.status(201)
        .body(map("id", domain.savePolicy(Input.parse(body, Input.Policy.class), null)));
  }

  @PutMapping("/api/policies/{id}")
  public Map<String, Object> updatePolicy(
      @PathVariable String id, @RequestBody Map<String, Object> body) {
    domain.savePolicy(Input.parse(body, Input.Policy.class), Input.uuid(id));
    return map("ok", true);
  }

  @PostMapping("/api/policies/import")
  public Map<String, Object> importCsv(@RequestBody Map<String, Object> body) {
    return domain.importCsv(str(body, "csv"), bool(body.get("confirm")));
  }

  @PostMapping("/api/messages")
  public ResponseEntity<?> send(@RequestBody Map<String, Object> body) {
    return ResponseEntity.status(202).body(jobs.queue(Input.parse(body, Input.Message.class)));
  }

  @PostMapping("/api/whatsapp/handoff")
  public ResponseEntity<?> handoff(@RequestBody Map<String, Object> body) {
    return ResponseEntity.status(201).body(jobs.handoff(Input.parse(body, Input.Message.class)));
  }

  @PostMapping("/api/messages/{id}/confirm-manual")
  public Map<String, Object> confirm(@PathVariable String id) {
    jobs.confirmManual(Input.uuid(id));
    return map("ok", true);
  }

  @PostMapping("/api/requests")
  public ResponseEntity<?> createTask(@RequestBody Map<String, Object> body) {
    String cid = Input.uuid(str(body, "contact_id")),
        channel = Input.choice(str(body, "channel"), List.of("email", "whatsapp"), "email"),
        kind = Input.text(str(body, "kind"), 100, true),
        detail = Input.text(str(body, "detail"), 20000, true);
    require(db.one("SELECT id FROM contacts WHERE id=?", cid) != null, "Client not found");
    String rid = Database.id();
    db.update(
        "INSERT INTO requests(id,contact_id,channel,kind,detail,created_at) VALUES(?,?,?,?,?,?)",
        rid,
        cid,
        channel,
        kind,
        detail,
        cfg.at());
    db.audit("Manual task created", rid);
    return ResponseEntity.status(201).body(map("id", rid));
  }

  @PatchMapping("/api/requests/{id}")
  public Map<String, Object> updateTask(
      @PathVariable String id, @RequestBody Map<String, Object> body) {
    String
        status =
            Input.choice(str(body, "status"), List.of("Open", "In progress", "Completed"), "Open"),
        note = Input.text(str(body, "note"), 5000, false);
    if (db.update("UPDATE requests SET status=?,note=? WHERE id=?", status, note, Input.uuid(id))
        != 1) throw new ApiException(404, "Task not found");
    db.audit("Task updated", id);
    return map("ok", true);
  }

  @PatchMapping("/api/settings")
  public Map<String, Object> settings(@RequestBody Map<String, Object> body) {
    require(
        body.get("autoAck") instanceof Boolean && body.get("reminders") instanceof Boolean,
        "Settings must be true or false");
    db.tx(
        () -> {
          for (String key : List.of("autoAck", "reminders"))
            db.update("UPDATE settings SET value=? WHERE key=?", write(body.get(key)), key);
          db.audit("Automation settings updated", null);
          return null;
        });
    return map("ok", true);
  }

  @PostMapping("/api/integrations/gmail/connect")
  public Map<String, Object> connect(HttpServletRequest request) {
    return map("url", integrations.googleAuth(str(sessionRow(request), "token_hash")));
  }

  @GetMapping("/api/integrations/gmail/callback")
  public ResponseEntity<?> callback(
      @RequestParam(required = false) String code,
      @RequestParam(required = false) String state,
      HttpServletRequest request) {
    require(code != null && state != null, "Google consent was not completed");
    integrations.googleCallback(code, state, str(sessionRow(request), "token_hash"));
    return ResponseEntity.status(302).header("Location", "/#settings").build();
  }

  @PostMapping("/api/integrations/gmail/sync")
  public Map<String, Object> sync() {
    require(cfg.mode().equals("live"), "Gmail sync is available only in live mode");
    return integrations.syncGmail();
  }

  @PostMapping("/api/integrations/gmail/disconnect")
  public Map<String, Object> disconnect() {
    return integrations.disconnect();
  }

  @PostMapping("/api/integrations/whatsapp/test")
  public Map<String, Object> testWhatsapp() {
    return integrations.testWhatsapp();
  }

  @PostMapping("/api/simulate")
  public Map<String, Object> simulate(@RequestBody Map<String, Object> body) {
    if (!cfg.mode().equals("mock"))
      throw new ApiException(404, "Simulation is unavailable in live mode");
    String channel = Input.choice(str(body, "channel"), List.of("email", "whatsapp"), "email");
    return domain.incoming(
        new DomainService.Incoming(
            channel,
            body.get("eventId") == null
                ? "simulation:" + Database.id()
                : Input.text(str(body, "eventId"), 200, true),
            Input.text(str(body, "address"), 254, true),
            Input.text(str(body, "name"), 100, true),
            Input.text(str(body, "text"), 20000, true),
            "Simulated incoming message",
            null,
            null,
            cfg.now(),
            false,
            false));
  }

  @GetMapping("/webhooks/whatsapp")
  public ResponseEntity<String> verifyWebhook(@RequestParam Map<String, String> params) {
    if (cfg.waVerify().isEmpty()
        || !"subscribe".equals(params.get("hub.mode"))
        || !Crypto.equal(cfg.waVerify(), params.getOrDefault("hub.verify_token", "")))
      throw new ApiException(403, "Webhook verification failed");
    return ResponseEntity.ok()
        .contentType(MediaType.TEXT_PLAIN)
        .body(params.getOrDefault("hub.challenge", ""));
  }

  @PostMapping("/webhooks/whatsapp")
  public ResponseEntity<String> webhook(
      @RequestBody byte[] raw,
      @RequestHeader(value = "X-Hub-Signature-256", defaultValue = "") String signature)
      throws Exception {
    if (cfg.waSecret().isEmpty()) throw new ApiException(403, "Webhook verification unavailable");
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(cfg.waSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    if (!Crypto.equal(signature, "sha256=" + HexFormat.of().formatHex(mac.doFinal(raw))))
      throw new ApiException(403, "Invalid webhook signature");
    var data = Json.read(new String(raw, StandardCharsets.UTF_8));
    require("whatsapp_business_account".equals(data.get("object")), "Unexpected webhook object");
    for (var entry : rows(data.get("entry")))
      for (var change : rows(entry.get("changes"))) {
        var v = obj(change.get("value"));
        if (!cfg.waPhoneId().equals(str(obj(v.get("metadata")), "phone_number_id"))) continue;
        for (var m : rows(v.get("messages"))) {
          String from = str(m, "from");
          if (!from.matches("\\d{8,15}") || str(m, "id").isEmpty()) continue;
          String name =
              rows(v.get("contacts")).stream()
                  .filter(c -> str(c, "wa_id").equals(from))
                  .map(c -> str(obj(c.get("profile")), "name"))
                  .findFirst()
                  .orElse("+" + from);
          String text = str(obj(m.get("text")), "body");
          if (text.isEmpty()) text = "[" + str(m, "type") + " message — review in WhatsApp]";
          domain.incoming(
              new DomainService.Incoming(
                  "whatsapp",
                  str(m, "id"),
                  "+" + from,
                  name,
                  text,
                  "",
                  null,
                  null,
                  Instant.ofEpochSecond(number(m.get("timestamp"))),
                  false,
                  false));
        }
        Map<String, Integer> rank =
            Map.of("queued", 0, "sending", 1, "sent", 2, "delivered", 3, "read", 4, "failed", 5);
        for (var s : rows(v.get("statuses"))) {
          String status = str(s, "status");
          if (!List.of("sent", "delivered", "read", "failed").contains(status)) continue;
          var m = db.one("SELECT id,status FROM messages WHERE provider_id=?", s.get("id"));
          if (m == null
              || str(m, "status").equals("read")
              || rank.get(status) < rank.getOrDefault(str(m, "status"), 0)) continue;
          db.update("UPDATE messages SET status=? WHERE id=?", status, m.get("id"));
        }
      }
    return ResponseEntity.ok("OK");
  }
}
