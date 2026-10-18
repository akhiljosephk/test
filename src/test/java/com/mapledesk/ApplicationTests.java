package com.mapledesk;

import static com.mapledesk.Json.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import jakarta.servlet.http.Cookie;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.*;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.*;

@SpringBootTest(properties = {"WORKER_DELAY_MS=3600000"})
@AutoConfigureMockMvc
@Import(ApplicationTests.TestSettings.class)
class ApplicationTests {
  static final String PASSWORD = "test-only-java-owner-password!";
  static final Path DIR;

  static {
    try {
      DIR = Files.createTempDirectory("mapledesk-java-test-");
    } catch (Exception e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  static final Map<String, String> OVERRIDES = new ConcurrentHashMap<>();
  static final Map<String, String> DEFAULTS =
      Map.of(
          "DB_PATH",
          DIR.resolve("app.sqlite").toString(),
          "OWNER_EMAIL",
          "owner@example.com",
          "OWNER_PASSWORD",
          PASSWORD,
          "DATA_KEY",
          "ab".repeat(32),
          "PUBLIC_URL",
          "http://localhost:3000",
          "APP_TEST_NOW",
          "2026-10-20T14:00:00Z");

  @TestConfiguration
  static class TestSettings {
    @Bean
    @Primary
    Settings testSettings() {
      return new Settings(k -> OVERRIDES.containsKey(k) ? OVERRIDES.get(k) : DEFAULTS.get(k));
    }
  }

  @Autowired MockMvc mvc;
  @Autowired Database db;
  @Autowired Settings cfg;
  @Autowired DomainService domain;
  @Autowired JobService jobs;
  @Autowired IntegrationService integrations;
  @MockitoBean ProviderTransport http;
  Cookie cookie;
  String csrf;

  @BeforeEach
  void setUp() throws Exception {
    OVERRIDES.clear();
    reset(http);
    for (String table :
        List.of(
            "oauth_states",
            "sessions",
            "login_limits",
            "jobs",
            "requests",
            "messages",
            "threads",
            "leads",
            "policies",
            "consent_events",
            "contacts",
            "integrations",
            "inbound_events",
            "audit")) db.update("DELETE FROM " + table);
    db.update("UPDATE settings SET value='false' WHERE key='autoAck'");
    db.update("UPDATE settings SET value='true' WHERE key='reminders'");
    db.update("UPDATE users SET password_hash=?,last_totp=-1", Crypto.password(PASSWORD));
    var response =
        mvc.perform(
                post("/api/login")
                    .header("Origin", cfg.origin())
                    .contentType("application/json")
                    .content(write(map("email", "owner@example.com", "password", PASSWORD))))
            .andReturn();
    assertThat(response.getResponse().getStatus()).isEqualTo(200);
    cookie =
        new Cookie(
            "md_session",
            response.getResponse().getHeader("Set-Cookie").split(";", 2)[0].split("=", 2)[1]);
    csrf = str(body(response), "csrf");
  }

  Map<String, Object> body(MvcResult result) throws Exception {
    return Json.read(result.getResponse().getContentAsString());
  }

  MvcResult call(String path, String method, Map<String, Object> data) throws Exception {
    return mvc.perform(
            request(HttpMethod.valueOf(method), path)
                .cookie(cookie)
                .header("Origin", cfg.origin())
                .header("X-CSRF-Token", csrf)
                .contentType("application/json")
                .content(data == null ? "" : write(data)))
        .andReturn();
  }

  Map<String, Object> lead() {
    return map(
        "contact",
        map(
            "name",
            "Joseph Mathew",
            "email",
            "joseph@example.com",
            "phone",
            "+14165550101",
            "notes",
            "Parents visiting in December.",
            "email_consent",
            true,
            "whatsapp_consent",
            true,
            "consent_note",
            "Agreed during test enquiry"),
        "insurance_type",
        "Super Visa",
        "status",
        "Quote sent",
        "due",
        "2026-10-20",
        "interval_days",
        2,
        "channel",
        "email");
  }

  Map<String, Object> add() throws Exception {
    var response = call("/api/leads", "POST", lead());
    assertThat(response.getResponse().getStatus())
        .as(response.getResponse().getContentAsString())
        .isEqualTo(201);
    return db.one("SELECT * FROM leads WHERE id=?", body(response).get("id"));
  }

  Input.Message message(Map<String, Object> lead, String channel, String purpose) {
    return new Input.Message(
        str(lead, "contact_id"),
        channel,
        "Hi Joseph, can I help with the quote?",
        "Follow-up",
        purpose,
        str(lead, "id"),
        null,
        null,
        null,
        null,
        Database.id());
  }

  DomainService.Incoming incoming(
      String event,
      String channel,
      String address,
      String text,
      boolean historical,
      boolean automated) {
    return new DomainService.Incoming(
        channel,
        event,
        address,
        "Client",
        text,
        "Request",
        null,
        null,
        cfg.now(),
        historical,
        automated);
  }

  @Test
  void authenticationAndCsrf() throws Exception {
    assertThat(mvc.perform(get("/api/state")).andReturn().getResponse().getStatus()).isEqualTo(401);
    assertThat(
            mvc.perform(
                    patch("/api/settings")
                        .cookie(cookie)
                        .header("Origin", cfg.origin())
                        .header("X-CSRF-Token", "bad")
                        .contentType("application/json")
                        .content("{\"autoAck\":true,\"reminders\":true}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(
                    post("/api/login")
                        .header("Origin", "https://evil.example")
                        .contentType("application/json")
                        .content("{}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    var result = call("/api/state", "GET", null);
    assertThat(result.getResponse().getStatus()).isEqualTo(200);
    assertThat(result.getResponse().getContentAsString()).doesNotContain(cfg.key());
    assertThat(call("/api/logout", "POST", map()).getResponse().getStatus()).isEqualTo(200);
    assertThat(call("/api/state", "GET", null).getResponse().getStatus()).isEqualTo(401);
  }

  @Test
  void loginThrottling() throws Exception {
    for (int n = 0; n < 10; n++)
      assertThat(
              mvc.perform(
                      post("/api/login")
                          .header("Origin", cfg.origin())
                          .contentType("application/json")
                          .content(write(map("email", "owner@example.com", "password", "bad"))))
                  .andReturn()
                  .getResponse()
                  .getStatus())
          .isEqualTo(401);
    assertThat(
            mvc.perform(
                    post("/api/login")
                        .header("Origin", cfg.origin())
                        .contentType("application/json")
                        .content(write(map("email", "owner@example.com", "password", PASSWORD))))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(429);
  }

  @Test
  void ownerMfaAndReplay() throws Exception {
    OVERRIDES.put("OWNER_TOTP_SECRET", "JBSWY3DPEHPK3PXP");
    OVERRIDES.put("NODE_ENV", "production");
    OVERRIDES.put("PUBLIC_URL", "https://broker.example");
    String code = Crypto.totp(cfg.totpSecret(), System.currentTimeMillis() / 30000);
    var data = map("email", "owner@example.com", "password", PASSWORD, "code", code);
    var first = call("/api/login", "POST", data);
    assertThat(first.getResponse().getStatus()).isEqualTo(200);
    assertThat(first.getResponse().getHeader("Set-Cookie"))
        .contains("Secure", "HttpOnly", "SameSite=Lax");
    assertThat(call("/api/login", "POST", data).getResponse().getStatus()).isEqualTo(401);
  }

  @Test
  void productionRequiresSecurityConfiguration() {
    assertThatThrownBy(() -> new Settings(k -> Map.of("NODE_ENV", "production").get(k)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void leadValidationConsentAndMonthlyDates() throws Exception {
    var l = add();
    assertThat(db.number("SELECT count(*) FROM consent_events")).isEqualTo(2);
    var bad = lead();
    bad.put("due", "2026-02-30");
    assertThat(call("/api/leads", "POST", bad).getResponse().getStatus()).isEqualTo(400);
    var update = lead();
    update.put("due", "2026-11-03");
    update.put("interval_days", 4);
    assertThat(call("/api/leads/" + l.get("id"), "PUT", update).getResponse().getStatus())
        .isEqualTo(200);
    assertThat(db.one("SELECT due FROM leads").get("due")).isEqualTo("2026-11-03");
    assertThat(call("/api/leads", "POST", lead()).getResponse().getStatus()).isEqualTo(409);
  }

  @Test
  void consentNeedsEvidence() throws Exception {
    var data = lead();
    obj(data.get("contact")).put("consent_note", "");
    assertThat(call("/api/leads", "POST", data).getResponse().getStatus()).isEqualTo(400);
    assertThat(db.number("SELECT count(*) FROM contacts")).isZero();
  }

  @Test
  void requestValidationAndForeignKeys() throws Exception {
    var l = add();
    assertThat(
            call(
                    "/api/requests",
                    "POST",
                    map(
                        "contact_id",
                        Database.id(),
                        "channel",
                        "email",
                        "kind",
                        "Update",
                        "detail",
                        "Review please"))
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    var task =
        call(
            "/api/requests",
            "POST",
            map(
                "contact_id",
                l.get("contact_id"),
                "channel",
                "email",
                "kind",
                "Review",
                "detail",
                "Review documents"));
    assertThat(task.getResponse().getStatus()).isEqualTo(201);
    String id = str(body(task), "id");
    assertThat(
            call(
                    "/api/requests/" + id,
                    "PATCH",
                    map("status", "Completed", "note", "Reviewed with insurer"))
                .getResponse()
                .getStatus())
        .isEqualTo(200);
    assertThat(db.one("SELECT status FROM requests WHERE id=?", id).get("status"))
        .isEqualTo("Completed");
  }

  @Test
  void idempotencyAndTwoDayFollowup() throws Exception {
    var l = add();
    var p = message(l, "email", "followup");
    var result = jobs.queue(p);
    assertThat(jobs.queue(p).get("duplicate")).isEqualTo(true);
    assertThat(db.number("SELECT count(*) FROM messages")).isEqualTo(1);
    assertThat(jobs.work()).isTrue();
    assertThat(db.one("SELECT status,due FROM leads"))
        .containsEntry("status", "Awaiting reply")
        .containsEntry("due", "2026-10-22");
    assertThat(db.one("SELECT status FROM messages")).containsEntry("status", "simulated");
    assertThat(jobs.work()).isFalse();
  }

  @Test
  void fourDayCadenceWorks() throws Exception {
    var l = add();
    db.update("UPDATE leads SET interval_days=4");
    jobs.queue(message(l, "email", "followup"));
    jobs.work();
    assertThat(db.one("SELECT due FROM leads").get("due")).isEqualTo("2026-10-24");
  }

  @Test
  void closedLeadSuppressionAfterQueue() throws Exception {
    var l = add();
    jobs.queue(message(l, "email", "followup"));
    db.update("UPDATE leads SET status='Won'");
    jobs.work();
    assertThat(db.one("SELECT status FROM jobs").get("status")).isEqualTo("failed");
    assertThat(db.one("SELECT due FROM leads").get("due")).isEqualTo("2026-10-20");
    assertThatThrownBy(() -> jobs.queue(message(l, "email", "followup")))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void optOutCancelsQueuedSends() throws Exception {
    var l = add();
    jobs.queue(message(l, "email", "reply"));
    domain.incoming(
        incoming(
            "stop-1", "email", "joseph@example.com", "Please stop messaging me.", false, false));
    jobs.work();
    assertThat(db.one("SELECT status FROM jobs").get("status")).isEqualTo("failed");
    assertThat(db.number("SELECT opted_out FROM contacts")).isEqualTo(1);
  }

  @Test
  void incomingRequestsDeduplicateAndAcknowledgeReceipt() {
    db.update("UPDATE settings SET value='true' WHERE key='autoAck'");
    var p =
        incoming(
            "gmail:one", "email", "emma@example.com", "My DOB needs a correction.", false, false);
    var result = domain.incoming(p);
    assertThat(result.get("requestId")).isNotNull();
    assertThat(domain.incoming(p).get("duplicate")).isEqualTo(true);
    assertThat(db.number("SELECT count(*) FROM requests")).isEqualTo(1);
    jobs.work();
    assertThat(db.one("SELECT * FROM messages WHERE direction='out'"))
        .containsEntry("status", "simulated");
    assertThat(str(db.one("SELECT text FROM messages WHERE direction='out'"), "text"))
        .contains("not been changed");
  }

  @Test
  void oldAndAutomatedMessagesDoNotReceiveReplies() {
    db.update("UPDATE settings SET value='true' WHERE key='autoAck'");
    domain.incoming(
        incoming("old", "email", "old@example.com", "Please update my address", true, false));
    domain.incoming(
        incoming("auto", "email", "robot@example.com", "Please update my address", false, true));
    assertThat(db.number("SELECT count(*) FROM messages WHERE direction='out'")).isZero();
    assertThat(db.number("SELECT count(*) FROM requests")).isEqualTo(1);
  }

  @Test
  void whatsappSignatureAndWebhookScope() throws Exception {
    OVERRIDES.put("WHATSAPP_APP_SECRET", "test-webhook-key");
    OVERRIDES.put("WHATSAPP_PHONE_NUMBER_ID", "123");
    OVERRIDES.put("WHATSAPP_VERIFY_TOKEN", "test-verify");
    String raw =
        write(
            map(
                "object",
                "whatsapp_business_account",
                "entry",
                List.of(
                    map(
                        "changes",
                        List.of(
                            map(
                                "value",
                                map(
                                    "metadata",
                                    map("phone_number_id", "123"),
                                    "messages",
                                    List.of(
                                        map(
                                            "id",
                                            "wa-one",
                                            "from",
                                            "14165550101",
                                            "timestamp",
                                            cfg.now().getEpochSecond(),
                                            "type",
                                            "text",
                                            "text",
                                            map("body", "Please change my address"))))))))));
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(cfg.waSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    String signature =
        "sha256=" + HexFormat.of().formatHex(mac.doFinal(raw.getBytes(StandardCharsets.UTF_8)));
    assertThat(
            mvc.perform(
                    post("/webhooks/whatsapp")
                        .header("X-Hub-Signature-256", "bad")
                        .contentType("application/json")
                        .content(raw))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(
                    post("/webhooks/whatsapp")
                        .header("X-Hub-Signature-256", signature)
                        .contentType("application/json")
                        .content(raw))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(200);
    assertThat(db.number("SELECT count(*) FROM requests")).isEqualTo(1);
    assertThat(
            mvc.perform(
                    get(
                        "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=hello"))
                .andReturn()
                .getResponse()
                .getContentAsString())
        .isEqualTo("hello");
  }

  @Test
  void whatsappTemplatesAndServiceWindow() throws Exception {
    var l = add();
    assertThatThrownBy(() -> jobs.queue(message(l, "whatsapp", "reply")))
        .hasMessageContaining("template");
    OVERRIDES.put(
        "WHATSAPP_TEMPLATES_JSON",
        write(
            List.of(
                map(
                    "name",
                    "renewal",
                    "language",
                    "en",
                    "body",
                    "Hi {{1}}, expiry is {{2}}.",
                    "parameters",
                    List.of("Name", "Date")))));
    var p =
        new Input.Message(
            str(l, "contact_id"),
            "whatsapp",
            "Preview",
            null,
            "reply",
            null,
            null,
            null,
            null,
            new Input.Template("renewal", "en", List.of("Joseph", "Nov 19")),
            Database.id());
    jobs.queue(p);
    jobs.work();
    assertThat(db.one("SELECT text,status FROM messages"))
        .containsEntry("text", "Hi Joseph, expiry is Nov 19.")
        .containsEntry("status", "simulated");
  }

  Map<String, Object> policy(Map<String, Object> l) {
    return map(
        "contact_id",
        l.get("contact_id"),
        "number",
        "ML-100",
        "insurer",
        "Manulife",
        "insurance_type",
        "Super Visa",
        "effective",
        "2026-10-27",
        "expiry",
        "2026-11-19");
  }

  @Test
  void reminderDatesAreUniqueAndStaleJobsCancel() throws Exception {
    var l = add();
    assertThat(call("/api/policies", "POST", policy(l)).getResponse().getStatus()).isEqualTo(201);
    assertThat(domain.schedule()).isZero();
    assertThat(db.number("SELECT count(*) FROM jobs")).isEqualTo(2);
    db.update("UPDATE policies SET expiry='2026-12-01'");
    jobs.work();
    jobs.work();
    assertThat(db.number("SELECT count(*) FROM jobs WHERE status='draft'")).isEqualTo(1);
    assertThat(db.number("SELECT count(*) FROM jobs WHERE status='cancelled'")).isEqualTo(1);
  }

  @Test
  void aReminderCannotSendTwiceAcrossRequestKeys() throws Exception {
    var l = add();
    var r = call("/api/policies", "POST", policy(l));
    String pid = str(body(r), "id");
    jobs.work();
    jobs.work();
    var job =
        db.one(
            "SELECT * FROM jobs WHERE type='reminder' AND"
                + " json_extract(payload,'$.event')='expiry'");
    var p =
        new Input.Message(
            str(l, "contact_id"),
            "email",
            "Policy reminder",
            null,
            "reminder",
            null,
            pid,
            str(job, "id"),
            "expiry",
            null,
            Database.id());
    jobs.queue(p);
    jobs.queue(
        new Input.Message(
            p.contactId(),
            p.channel(),
            p.text(),
            p.subject(),
            p.purpose(),
            null,
            pid,
            p.reminderJobId(),
            p.event(),
            null,
            Database.id()));
    assertThat(db.number("SELECT count(*) FROM messages")).isEqualTo(1);
    jobs.work();
    assertThat(db.one("SELECT status FROM jobs WHERE id=?", job.get("id")).get("status"))
        .isEqualTo("done");
  }

  @Test
  void csvPreviewAndAtomicImport() throws Exception {
    add();
    String header = "email,number,insurer,insurance_type,effective,expiry\n",
        valid = "joseph@example.com,CSV-1,Manulife,Super Visa,2026-10-20,2027-10-20\n",
        bad = "unknown@example.com,CSV-2,Manulife,Super Visa,2026-10-20,2027-10-20\n";
    var preview = domain.importCsv(header + valid + bad, false);
    assertThat((List<?>) preview.get("items")).hasSize(1);
    assertThat((List<?>) preview.get("errors")).hasSize(1);
    assertThatThrownBy(() -> domain.importCsv(header + valid + bad, true))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(db.number("SELECT count(*) FROM policies")).isZero();
    assertThat(domain.importCsv("\ufeff" + header + valid, true).get("imported")).isEqualTo(1);
    assertThat((List<?>) domain.importCsv(header + valid, false).get("errors")).hasSize(1);
  }

  @Test
  void liveModeRequiresDeliberateEnablement() throws Exception {
    var l = add();
    OVERRIDES.put("MESSAGING_MODE", "live");
    assertThat(call("/api/simulate", "POST", map()).getResponse().getStatus()).isEqualTo(404);
    assertThatThrownBy(() -> jobs.queue(message(l, "email", "reply")))
        .hasMessageContaining("disabled");
  }

  @Test
  void unknownProviderOutcomesRequireReview() throws Exception {
    var l = add();
    jobs.queue(message(l, "email", "reply"));
    OVERRIDES.put("MESSAGING_MODE", "live");
    OVERRIDES.put("ALLOW_LIVE_SENDS", "true");
    integrations.store(
        "gmail",
        map(
            "access_token",
            "test-access",
            "refresh_token",
            "test-refresh",
            "expires_at",
            System.currentTimeMillis() + 3600000),
        map("address", "owner@gmail.com"));
    when(http.exchange(anyString(), eq("POST"), anyMap(), anyString()))
        .thenThrow(new ProviderTransport.Failure("Connection lost", 0, true));
    jobs.work();
    assertThat(db.one("SELECT status FROM jobs").get("status")).isEqualTo("needs_review");
    assertThat(jobs.work()).isFalse();
    verify(http, times(1)).exchange(anyString(), eq("POST"), anyMap(), anyString());
  }

  @Test
  void interruptedWorkerDoesNotResend() throws Exception {
    var l = add();
    jobs.queue(message(l, "email", "reply"));
    db.update("UPDATE jobs SET status='running',lease_until='2026-10-20T00:00:00.000Z'");
    db.update("UPDATE messages SET status='sending'");
    assertThat(jobs.work()).isFalse();
    assertThat(db.one("SELECT status FROM jobs").get("status")).isEqualTo("needs_review");
  }

  void googleConfig() {
    OVERRIDES.put("GOOGLE_CLIENT_ID", "test-client");
    OVERRIDES.put("GOOGLE_CLIENT_SECRET", "test-secret");
    OVERRIDES.put("GMAIL_ADDRESS", "owner@gmail.com");
  }

  @Test
  void oauthPkceStateAndEncryption() throws Exception {
    googleConfig();
    String url = integrations.googleAuth("session-one");
    var query = new HashMap<String, String>();
    for (String pair : URI.create(url).getRawQuery().split("&")) {
      String[] v = pair.split("=", 2);
      query.put(v[0], URLDecoder.decode(v[1], StandardCharsets.UTF_8));
    }
    assertThat(query.get("code_challenge_method")).isEqualTo("S256");
    String state = query.get("state");
    assertThatThrownBy(() -> integrations.googleCallback("code", state, "wrong-session"))
        .hasMessageContaining("expired");
    when(http.exchange(anyString(), anyString(), anyMap(), nullable(String.class)))
        .thenAnswer(
            i ->
                i.<String>getArgument(0).contains("/token")
                    ? map(
                        "access_token",
                        "test-access",
                        "refresh_token",
                        "test-refresh",
                        "expires_in",
                        3600)
                    : map("emailAddress", "owner@gmail.com", "historyId", "100"));
    integrations.googleCallback("code", state, "session-one");
    assertThat(str(db.one("SELECT secret FROM integrations"), "secret"))
        .doesNotContain("test-refresh");
    assertThat(obj(integrations.integration("gmail").get("metadata")).get("address"))
        .isEqualTo("owner@gmail.com");
    assertThatThrownBy(() -> integrations.googleCallback("code", state, "session-one"))
        .hasMessageContaining("expired");
  }

  Map<String, Object> emailMessage(String id, boolean sent) {
    return map(
        "id",
        id,
        "threadId",
        "thread-one",
        "internalDate",
        cfg.now().toEpochMilli(),
        "labelIds",
        List.of(sent ? "SENT" : "INBOX"),
        "payload",
        map(
            "mimeType",
            "text/plain",
            "headers",
            List.of(
                map(
                    "name",
                    "From",
                    "value",
                    sent ? "Owner <owner@gmail.com>" : "Emma <emma@example.com>"),
                map("name", "To", "value", "Joseph <joseph@example.com>"),
                map("name", "Subject", "value", "Address change")),
            "body",
            map(
                "data",
                Base64.getUrlEncoder()
                    .encodeToString(
                        (sent ? "Here are your options" : "Please update my address")
                            .getBytes(StandardCharsets.UTF_8)))));
  }

  @Test
  void gmailHistoryNeverAutoRepliesToOldMessages() {
    googleConfig();
    integrations.store(
        "gmail",
        map(
            "access_token",
            "test-access",
            "refresh_token",
            "test-refresh",
            "expires_at",
            System.currentTimeMillis() + 3600000),
        map("address", "owner@gmail.com", "historyId", "100", "initialSync", true));
    db.update("UPDATE settings SET value='true' WHERE key='autoAck'");
    when(http.exchange(anyString(), anyString(), anyMap(), nullable(String.class)))
        .thenAnswer(
            i -> {
              String url = i.getArgument(0);
              if (url.contains("/messages?")) return map("messages", List.of(map("id", "one")));
              if (url.contains("/messages/"))
                return emailMessage(url.contains("/two?") ? "two" : "one", false);
              return map(
                  "historyId",
                  "102",
                  "history",
                  List.of(map("messagesAdded", List.of(map("message", map("id", "two"))))));
            });
    integrations.syncGmail();
    assertThat(db.number("SELECT count(*) FROM messages WHERE direction='out'")).isZero();
    integrations.syncGmail();
    assertThat(db.number("SELECT count(*) FROM messages WHERE direction='out'")).isEqualTo(1);
    integrations.syncGmail();
    assertThat(db.number("SELECT count(*) FROM requests")).isEqualTo(2);
    assertThat(obj(integrations.integration("gmail").get("metadata")).get("historyId"))
        .isEqualTo("102");
  }

  @Test
  void sentMailReconcilesWithoutNewLeads() {
    googleConfig();
    integrations.store(
        "gmail",
        map(
            "access_token",
            "test-access",
            "refresh_token",
            "test-refresh",
            "expires_at",
            System.currentTimeMillis() + 3600000),
        map("address", "owner@gmail.com", "historyId", "100", "initialSync", true));
    when(http.exchange(anyString(), anyString(), anyMap(), nullable(String.class)))
        .thenAnswer(
            i -> {
              String u = i.getArgument(0);
              return u.contains("/messages?")
                  ? map("messages", List.of(map("id", "external")))
                  : u.contains("/history?")
                      ? map(
                          "historyId",
                          "101",
                          "history",
                          List.of(
                              map("messagesAdded", List.of(map("message", map("id", "external"))))))
                      : emailMessage("external", true);
            });
    integrations.syncGmail();
    integrations.syncGmail();
    assertThat(db.number("SELECT count(*) FROM messages")).isEqualTo(1);
    assertThat(db.one("SELECT status FROM messages").get("status")).isEqualTo("sent_external");
    assertThat(db.number("SELECT count(*) FROM leads")).isZero();
  }

  @Test
  void nodePasswordAndEncryptedTokensRemainCompatible() throws Exception {
    var fixture =
        Json.read(
            new String(
                getClass().getResourceAsStream("/node-compatibility.json").readAllBytes(),
                StandardCharsets.UTF_8));
    assertThat(Crypto.verify(str(fixture, "password"), str(fixture, "hash"))).isTrue();
    assertThat(Crypto.decrypt(str(fixture, "encrypted"), str(fixture, "key")))
        .isEqualTo(fixture.get("payload"));
    db.update("UPDATE users SET password_hash=?", fixture.get("hash"));
    var r =
        call(
            "/api/login",
            "POST",
            map("email", "owner@example.com", "password", fixture.get("password")));
    assertThat(r.getResponse().getStatus()).isEqualTo(200);
    assertThat(str(db.one("SELECT password_hash FROM users"), "password_hash"))
        .startsWith("{bcrypt-sha256}");
  }

  @Test
  void encryptionTamperAndSnapshotRestore() throws Exception {
    String encrypted = Crypto.encrypt(map("token", "test-only-token"), cfg.key());
    assertThat(Crypto.decrypt(encrypted, cfg.key()).get("token")).isEqualTo("test-only-token");
    assertThatThrownBy(
            () -> Crypto.decrypt(encrypted.substring(0, encrypted.length() - 2) + "ff", cfg.key()))
        .isInstanceOf(IllegalArgumentException.class);
    Path snapshot = DIR.resolve(Database.id() + ".sqlite"),
        encoded = DIR.resolve(Database.id() + ".enc"),
        restored = DIR.resolve(Database.id() + ".sqlite");
    db.snapshot(snapshot);
    Files.writeString(
        encoded,
        Crypto.encrypt(
            map(
                "schema",
                1,
                "sqlite",
                Base64.getEncoder().encodeToString(Files.readAllBytes(snapshot))),
            cfg.key()));
    Cli.restore(cfg, encoded, restored);
    Settings restoredCfg =
        new Settings(k -> k.equals("DB_PATH") ? restored.toString() : cfg.get(k, null));
    assertThat(new Database(restoredCfg).number("SELECT count(*) FROM users")).isEqualTo(1);
    assertThatThrownBy(() -> Cli.restore(cfg, encoded, restored)).hasMessageContaining("new path");
  }

  @Test
  void manualWhatsAppUsesExistingPhoneWithoutDeliveryClaims() throws Exception {
    var l = add();
    OVERRIDES.put("MESSAGING_MODE", "live");
    var p = message(l, "whatsapp", "followup");
    var result = jobs.handoff(p);
    assertThat(str(result, "url")).startsWith("https://wa.me/14165550101?text=");
    assertThat(db.one("SELECT status FROM messages").get("status")).isEqualTo("handoff");
    assertThat(db.one("SELECT due FROM leads").get("due")).isEqualTo("2026-10-20");
    assertThat(jobs.work()).isFalse();
    jobs.confirmManual(str(result, "messageId"));
    assertThat(db.one("SELECT status FROM messages").get("status")).isEqualTo("manual_sent");
    assertThat(db.one("SELECT due FROM leads").get("due")).isEqualTo("2026-10-22");
    assertThatThrownBy(() -> jobs.confirmManual(str(result, "messageId")))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void calendarAndRequestClassification() {
    Settings c =
        new Settings(k -> k.equals("APP_TEST_NOW") ? "2026-11-01T03:30:00Z" : cfg.get(k, null));
    assertThat(c.today()).isEqualTo("2026-10-31");
    assertThat(LocalDate.parse(c.today()).plusDays(2).toString()).isEqualTo("2026-11-02");
    assertThat(DomainService.classify("Can you change my policy date?"))
        .isEqualTo("Policy date change");
    assertThat(DomainService.classify("Please correct my phone number"))
        .isEqualTo("Phone number update");
    assertThat(DomainService.classify("Thanks for the quote!")).isNull();
  }

  @Test
  void privateFilesAreNotServed() throws Exception {
    for (String path :
        List.of("/.env", "/data/mapledesk.sqlite", "/pom.xml", "/src/main/resources/schema.sql"))
      assertThat(mvc.perform(get(path)).andReturn().getResponse().getStatus()).isEqualTo(404);
  }

  @Test
  void unrelatedDatabaseIsPreserved() throws Exception {
    Path path = DIR.resolve(Database.id() + ".sqlite");
    try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + path);
        var statement = connection.createStatement()) {
      statement.execute("CREATE TABLE unrelated(value TEXT)");
      statement.execute("INSERT INTO unrelated VALUES('preserve')");
    }
    Settings other = new Settings(k -> k.equals("DB_PATH") ? path.toString() : cfg.get(k, null));
    assertThatThrownBy(() -> new Database(other)).isInstanceOf(IllegalStateException.class);
    try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + path);
        var statement = connection.createStatement();
        var result =
            statement.executeQuery(
                "SELECT count(*) FROM sqlite_master WHERE name='schema_version'")) {
      assertThat(result.next()).isTrue();
      assertThat(result.getInt(1)).isZero();
    }
  }
}
