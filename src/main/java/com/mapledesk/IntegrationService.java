package com.mapledesk;

import static com.mapledesk.Json.*;
import static com.mapledesk.Settings.require;

import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.regex.*;
import org.springframework.stereotype.Service;

@Service
public class IntegrationService {
  private final Database db;
  private final Settings cfg;
  private final DomainService domain;
  private final ProviderTransport http;

  public IntegrationService(
      Database db, Settings cfg, DomainService domain, ProviderTransport http) {
    this.db = db;
    this.cfg = cfg;
    this.domain = domain;
    this.http = http;
  }

  public Map<String, Object> integration(String name) {
    var r = db.one("SELECT * FROM integrations WHERE name=?", name);
    return r == null
        ? null
        : map(
            "secret",
            Crypto.decrypt(str(r, "secret"), cfg.key()),
            "metadata",
            Json.read(str(r, "metadata")));
  }

  public void store(String name, Map<String, Object> secret, Map<String, Object> metadata) {
    db.update(
        "INSERT INTO integrations VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET"
            + " secret=excluded.secret,metadata=excluded.metadata,updated_at=excluded.updated_at",
        name,
        Crypto.encrypt(secret, cfg.key()),
        write(metadata),
        cfg.at());
  }

  private Map<String, Object> get(String url, String token) {
    return http.exchange(url, "GET", Map.of("Authorization", "Bearer " + token), null);
  }

  private Map<String, Object> postForm(String url, Map<String, Object> body) {
    return http.exchange(
        url,
        "POST",
        Map.of("Content-Type", "application/x-www-form-urlencoded"),
        ProviderTransport.form(body));
  }

  public String googleAuth(String sessionHash) {
    require(cfg.googleReady(), "Configure Google OAuth and the expected Gmail address first");
    String state = Crypto.random(), verifier = Crypto.random();
    long now = System.currentTimeMillis();
    db.update("DELETE FROM oauth_states WHERE expires_at<?", now);
    db.update(
        "INSERT INTO oauth_states VALUES(?,?,?,?)",
        Crypto.sha(state),
        sessionHash,
        verifier,
        now + 600000);
    String challenge =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(HexFormat.of().parseHex(Crypto.sha(verifier)));
    return "https://accounts.google.com/o/oauth2/v2/auth?"
        + ProviderTransport.form(
            map(
                "client_id",
                cfg.googleClientId(),
                "redirect_uri",
                cfg.origin() + "/api/integrations/gmail/callback",
                "response_type",
                "code",
                "scope",
                "https://www.googleapis.com/auth/gmail.readonly"
                    + " https://www.googleapis.com/auth/gmail.send",
                "access_type",
                "offline",
                "prompt",
                "consent",
                "state",
                state,
                "code_challenge",
                challenge,
                "code_challenge_method",
                "S256"));
  }

  public void googleCallback(String code, String state, String sessionHash) {
    var row =
        db.tx(
            () -> {
              var value =
                  db.one(
                      "SELECT * FROM oauth_states WHERE hash=? AND session_hash=? AND expires_at>?",
                      Crypto.sha(state),
                      sessionHash,
                      System.currentTimeMillis());
              require(value != null, "OAuth request expired or invalid; reconnect from settings");
              db.update("DELETE FROM oauth_states WHERE hash=?", Crypto.sha(state));
              return value;
            });
    var token =
        postForm(
            "https://oauth2.googleapis.com/token",
            map(
                "code",
                code,
                "client_id",
                cfg.googleClientId(),
                "client_secret",
                cfg.googleClientSecret(),
                "redirect_uri",
                cfg.origin() + "/api/integrations/gmail/callback",
                "grant_type",
                "authorization_code",
                "code_verifier",
                row.get("verifier")));
    require(
        !str(token, "access_token").isEmpty() && !str(token, "refresh_token").isEmpty(),
        "Google did not grant offline access; reconnect and approve consent");
    var profile =
        get("https://gmail.googleapis.com/gmail/v1/users/me/profile", str(token, "access_token"));
    require(
        str(profile, "emailAddress").equalsIgnoreCase(cfg.gmailAddress()),
        "Connected Gmail address does not match the configured mailbox");
    store(
        "gmail",
        map(
            "refresh_token",
            token.get("refresh_token"),
            "access_token",
            token.get("access_token"),
            "expires_at",
            System.currentTimeMillis() + number(token.getOrDefault("expires_in", 3600)) * 1000),
        map(
            "address",
            profile.get("emailAddress"),
            "historyId",
            profile.get("historyId"),
            "initialSync",
            true));
    db.audit("Gmail connected", null);
  }

  public String gmailToken() {
    var item = integration("gmail");
    require(item != null, "Gmail is not connected");
    var secret = obj(item.get("secret"));
    if (number(secret.get("expires_at")) > System.currentTimeMillis() + 60000)
      return str(secret, "access_token");
    var response =
        postForm(
            "https://oauth2.googleapis.com/token",
            map(
                "client_id",
                cfg.googleClientId(),
                "client_secret",
                cfg.googleClientSecret(),
                "refresh_token",
                secret.get("refresh_token"),
                "grant_type",
                "refresh_token"));
    require(!str(response, "access_token").isEmpty(), "Gmail authorization needs reconnection");
    secret.put("access_token", response.get("access_token"));
    secret.put(
        "expires_at",
        System.currentTimeMillis() + number(response.getOrDefault("expires_in", 3600)) * 1000);
    store("gmail", secret, obj(item.get("metadata")));
    return str(secret, "access_token");
  }

  public static String header(Map<String, Object> payload, String name) {
    return rows(payload.get("headers")).stream()
        .filter(h -> str(h, "name").equalsIgnoreCase(name))
        .map(h -> str(h, "value"))
        .findFirst()
        .orElse("");
  }

  public static String plain(Map<String, Object> p) {
    if ("text/plain".equals(p.get("mimeType")) && !str(obj(p.get("body")), "data").isEmpty())
      return new String(
          Base64.getUrlDecoder().decode(str(obj(p.get("body")), "data")), StandardCharsets.UTF_8);
    for (var part : rows(p.get("parts"))) {
      String text = plain(part);
      if (!text.isEmpty()) return text;
    }
    return "";
  }

  private static final Pattern ADDRESS =
      Pattern.compile(
          "<?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,})>?\\s*$",
          Pattern.CASE_INSENSITIVE);

  public static Map<String, Object> sender(String from) {
    var m = ADDRESS.matcher(from);
    if (!m.find()) return null;
    String address = m.group(1).toLowerCase(Locale.ROOT),
        name = from.substring(0, m.start()).replaceAll("^[\\\"\\s]+|[\\\"\\s<]+$", "");
    if (name.isEmpty()) name = address;
    return map("address", address, "name", name.substring(0, Math.min(100, name.length())));
  }

  private void importMessage(String token, String messageId, boolean historical) {
    var m =
        get(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + messageId + "?format=full",
            token);
    var payload = obj(m.get("payload"));
    var from = sender(header(payload, "From"));
    String providerId = "gmail:" + m.get("id");
    var labels = (List<?>) m.getOrDefault("labelIds", List.of());
    String text = plain(payload);
    if (text.isEmpty()) text = str(m, "snippet");
    if (text.isEmpty()) text = "[Non-text message: review in Gmail]";
    String finalText = text.substring(0, Math.min(text.length(), 20000));
    if (labels.contains("SENT")
        && from != null
        && str(from, "address").equals(cfg.gmailAddress())) {
      String to = header(payload, "To");
      long count =
          Pattern.compile(
                  "[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", Pattern.CASE_INSENSITIVE)
              .matcher(to)
              .results()
              .count();
      if (count != 1) return;
      var recipient = sender(to);
      if (recipient == null || str(recipient, "address").equals(cfg.gmailAddress())) return;
      db.tx(
          () -> {
            if (db.one("SELECT id FROM messages WHERE provider_id=?", providerId) != null)
              return null;
            var c = db.one("SELECT * FROM contacts WHERE email=?", recipient.get("address"));
            if (c == null) {
              String cid =
                  domain.saveContact(
                      new Input.Contact(
                          str(recipient, "name"),
                          str(recipient, "address"),
                          "",
                          "",
                          false,
                          false,
                          false,
                          ""),
                      null);
              c = db.one("SELECT * FROM contacts WHERE id=?", cid);
            }
            var t =
                domain.thread(
                    str(c, "id"), "email", header(payload, "Subject"), str(m, "threadId"));
            db.update(
                "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
                Database.id(),
                t.get("id"),
                "out",
                finalText,
                "sent_external",
                providerId,
                header(payload, "Message-Id").replaceAll("[\\r\\n]", ""),
                Time.iso(Instant.ofEpochMilli(number(m.get("internalDate")))));
            db.audit("Message sent in Gmail synchronized", c.get("id"));
            return null;
          });
      return;
    }
    if (!labels.contains("INBOX")
        || from == null
        || str(from, "address").equals(cfg.gmailAddress())) return;
    boolean automated =
        !header(payload, "List-Id").isEmpty()
            || Pattern.compile("bulk|list|junk", Pattern.CASE_INSENSITIVE)
                .matcher(header(payload, "Precedence"))
                .find()
            || !header(payload, "Auto-Submitted").isEmpty()
                && !header(payload, "Auto-Submitted").equalsIgnoreCase("no");
    domain.incoming(
        new DomainService.Incoming(
            "email",
            providerId,
            str(from, "address"),
            str(from, "name"),
            finalText,
            header(payload, "Subject")
                .substring(0, Math.min(200, header(payload, "Subject").length())),
            str(m, "threadId"),
            header(payload, "Message-Id").replaceAll("[\\r\\n]", ""),
            Instant.ofEpochMilli(number(m.get("internalDate"))),
            historical,
            automated));
  }

  public synchronized Map<String, Object> syncGmail() {
    var item = integration("gmail");
    if (item == null) return map("skipped", true);
    String token = gmailToken();
    var metadata = obj(item.get("metadata"));
    if (bool(metadata.get("initialSync"))) {
      var list =
          get(
              "https://gmail.googleapis.com/gmail/v1/users/me/messages?"
                  + ProviderTransport.form(
                      map("q", "{in:inbox in:sent} newer_than:7d", "maxResults", 20)),
              token);
      for (var m : rows(list.get("messages"))) importMessage(token, str(m, "id"), true);
      metadata.put("initialSync", false);
      metadata.put("lastSync", cfg.at());
      metadata.put("lastError", null);
      saveMetadata(metadata);
      return map("initial", true);
    }
    String pageToken = "", latest = str(metadata, "historyId");
    for (int page = 0; page < 20; page++) {
      Map<String, Object> result;
      try {
        var query =
            map(
                "startHistoryId",
                metadata.get("historyId"),
                "historyTypes",
                "messageAdded",
                "maxResults",
                100);
        if (!pageToken.isEmpty()) query.put("pageToken", pageToken);
        result =
            get(
                "https://gmail.googleapis.com/gmail/v1/users/me/history?"
                    + ProviderTransport.form(query),
                token);
      } catch (ProviderTransport.Failure e) {
        if (e.status != 404) throw e;
        var profile = get("https://gmail.googleapis.com/gmail/v1/users/me/profile", token);
        metadata.put("historyId", profile.get("historyId"));
        metadata.put("initialSync", true);
        metadata.put(
            "gapWarning",
            "Mailbox cursor expired. Re-importing recent messages without automatic replies; review"
                + " Gmail for older gaps.");
        saveMetadata(metadata);
        return map("rebaseline", true);
      }
      for (var h : rows(result.get("history")))
        for (var added : rows(h.get("messagesAdded")))
          importMessage(token, str(obj(added.get("message")), "id"), false);
      latest = str(result, "historyId").isEmpty() ? latest : str(result, "historyId");
      pageToken = str(result, "nextPageToken");
      if (pageToken.isEmpty()) {
        metadata.put("historyId", latest);
        metadata.put("lastSync", cfg.at());
        metadata.put("lastError", null);
        saveMetadata(metadata);
        return map("synced", true);
      }
    }
    throw new IllegalArgumentException(
        "Gmail sync backlog exceeds batch limit; cursor retained for safe retry");
  }

  public void saveMetadata(Map<String, Object> metadata) {
    var current = integration("gmail");
    if (current != null) store("gmail", obj(current.get("secret")), metadata);
  }

  public Map<String, Object> sendGmail(
      Map<String, Object> c, Map<String, Object> thread, String text, boolean automatic) {
    String token = gmailToken(), subject = str(thread, "subject").replaceAll("[\\r\\n]", " ");
    if (subject.isEmpty()) subject = "Your insurance enquiry";
    if (subject.length() > 200) subject = subject.substring(0, 200);
    var previous =
        db.one(
            "SELECT rfc_id FROM messages WHERE thread_id=? AND direction='in' AND rfc_id IS NOT"
                + " NULL ORDER BY created_at DESC LIMIT 1",
            thread.get("id"));
    String reply = previous == null ? "" : str(previous, "rfc_id").replaceAll("[\\r\\n]", "");
    var lines =
        new ArrayList<>(
            List.of(
                "From: " + cfg.gmailAddress(),
                "To: " + c.get("email"),
                "Subject: =?UTF-8?B?"
                    + Base64.getEncoder().encodeToString(subject.getBytes(StandardCharsets.UTF_8))
                    + "?=",
                "MIME-Version: 1.0",
                "Content-Type: text/plain; charset=UTF-8",
                "Content-Transfer-Encoding: base64"));
    if (automatic) lines.add("Auto-Submitted: auto-replied");
    if (!reply.isEmpty()) {
      lines.add("In-Reply-To: " + reply);
      lines.add("References: " + reply);
    }
    lines.add("");
    lines.add(
        Base64.getMimeEncoder(76, "\r\n".getBytes(StandardCharsets.UTF_8))
            .encodeToString(text.getBytes(StandardCharsets.UTF_8)));
    var body =
        map(
            "raw",
            Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString(String.join("\r\n", lines).getBytes(StandardCharsets.UTF_8)));
    if (!str(thread, "external_id").isEmpty()) body.put("threadId", thread.get("external_id"));
    var result =
        http.exchange(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            "POST",
            Map.of("Authorization", "Bearer " + token, "Content-Type", "application/json"),
            write(body));
    if (str(result, "id").isEmpty())
      throw new ProviderTransport.Failure("Gmail response omitted message ID", 200, true);
    return map(
        "providerId",
        "gmail:" + result.get("id"),
        "externalId",
        result.get("threadId"),
        "status",
        "sent");
  }

  public String templateText(Input.Template template) {
    require(template != null && template.parameters() != null, "Select an approved template");
    var spec =
        cfg.templates().stream()
            .filter(
                t ->
                    str(t, "name").equals(template.name())
                        && str(t, "language").equals(template.language()))
            .findFirst()
            .orElseThrow(
                () -> new IllegalArgumentException("Select a configured approved template"));
    var labels = (List<?>) spec.get("parameters");
    require(
        template.parameters().size() == labels.size()
            && template.parameters().stream()
                .allMatch(
                    v ->
                        v != null
                            && !v.isBlank()
                            && v.length() <= 300
                            && !v.contains("\r")
                            && !v.contains("\n")),
        "Fill all approved template parameters");
    String body = str(spec, "body");
    for (int i = 0; i < template.parameters().size(); i++)
      body = body.replace("{{" + (i + 1) + "}}", template.parameters().get(i));
    return body;
  }

  public Map<String, Object> sendWhatsapp(
      Map<String, Object> c, String text, Input.Template template) {
    var body = map("messaging_product", "whatsapp", "to", str(c, "phone").substring(1));
    if (template == null) {
      body.put("type", "text");
      body.put("text", map("body", text));
    } else {
      body.put("type", "template");
      body.put(
          "template",
          map(
              "name",
              template.name(),
              "language",
              map("code", template.language()),
              "components",
              List.of(
                  map(
                      "type",
                      "body",
                      "parameters",
                      template.parameters().stream()
                          .map(v -> map("type", "text", "text", v))
                          .toList()))));
    }
    var result =
        http.exchange(
            "https://graph.facebook.com/"
                + cfg.graphVersion()
                + "/"
                + cfg.waPhoneId()
                + "/messages",
            "POST",
            Map.of("Authorization", "Bearer " + cfg.waToken(), "Content-Type", "application/json"),
            write(body));
    var messages = rows(result.get("messages"));
    if (messages.isEmpty() || str(messages.getFirst(), "id").isEmpty())
      throw new ProviderTransport.Failure("WhatsApp response omitted message ID", 200, true);
    return map("providerId", messages.getFirst().get("id"), "status", "sent");
  }

  public Map<String, Object> testWhatsapp() {
    require(cfg.whatsappReady(), "Configure WhatsApp API credentials and version first");
    return get(
        "https://graph.facebook.com/"
            + cfg.graphVersion()
            + "/"
            + cfg.waPhoneId()
            + "?fields=display_phone_number,verified_name",
        cfg.waToken());
  }

  public Map<String, Object> disconnect() {
    var current = cfg.key().isEmpty() ? null : integration("gmail");
    boolean revoked = current == null;
    if (current != null) {
      try {
        postForm(
            "https://oauth2.googleapis.com/revoke",
            map("token", obj(current.get("secret")).get("refresh_token")));
        revoked = true;
      } catch (Exception ignored) {
      }
      db.update("DELETE FROM integrations WHERE name='gmail'");
    }
    db.audit("Gmail disconnected", null);
    return map(
        "ok",
        true,
        "revoked",
        revoked,
        "action",
        revoked ? null : "Also revoke access in your Google account security settings.");
  }
}
