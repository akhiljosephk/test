package com.mapledesk;

import java.net.URI;
import java.time.*;
import java.util.*;
import java.util.function.Function;

public final class Settings {
  private final Function<String, String> source;

  public Settings(Function<String, String> source) {
    this.source = source;
    ZoneId.of(timezone());
    require(List.of("mock", "live").contains(mode()), "MESSAGING_MODE must be mock or live");
    require(
        key().isEmpty() || key().matches("(?i)[a-f0-9]{64}"),
        "DATA_KEY must contain 64 hex characters");
    require(
        totpSecret().isEmpty() || totpSecret().matches("(?i)[A-Z2-7]{16,128}"),
        "OWNER_TOTP_SECRET must be an unformatted base32 seed");
    require(
        graphVersion().isEmpty() || graphVersion().matches("v\\d+\\.\\d+"),
        "Invalid WhatsApp Graph version");
    if (production()) {
      require(
          !key().isEmpty() && !totpSecret().isEmpty() && origin().startsWith("https://"),
          "Production requires DATA_KEY, owner MFA and HTTPS PUBLIC_URL");
      require(get("APP_TEST_NOW", "").isEmpty(), "Test clock is forbidden in production");
    }
    templates();
  }

  public static void require(boolean ok, String message) {
    if (!ok) throw new IllegalArgumentException(message);
  }

  public String get(String key, String fallback) {
    String v = source.apply(key);
    return v == null ? fallback : v;
  }

  public boolean production() {
    return "production".equals(get("APP_ENV", get("NODE_ENV", "development")));
  }

  public String mode() {
    return get("MESSAGING_MODE", "mock");
  }

  public boolean liveSends() {
    return "true".equals(get("ALLOW_LIVE_SENDS", "false"));
  }

  public String key() {
    return get("DATA_KEY", "");
  }

  public String origin() {
    URI u = URI.create(get("PUBLIC_URL", "http://localhost:" + get("PORT", "3000")));
    require(
        u.getHost() != null
            && List.of("http", "https").contains(u.getScheme())
            && u.getRawUserInfo() == null,
        "Invalid PUBLIC_URL");
    return u.getScheme() + "://" + u.getHost() + (u.getPort() < 0 ? "" : ":" + u.getPort());
  }

  public String dbPath() {
    return get("DB_PATH", "data/mapledesk.sqlite");
  }

  public String timezone() {
    return get("BUSINESS_TIMEZONE", "America/Toronto");
  }

  public String business() {
    return get("BUSINESS_NAME", "Insurance workspace");
  }

  public String ownerEmail() {
    return get("OWNER_EMAIL", "").trim().toLowerCase(Locale.ROOT);
  }

  public String ownerPassword() {
    return get("OWNER_PASSWORD", "");
  }

  public String totpSecret() {
    return get("OWNER_TOTP_SECRET", "");
  }

  public String googleClientId() {
    return get("GOOGLE_CLIENT_ID", "");
  }

  public String googleClientSecret() {
    return get("GOOGLE_CLIENT_SECRET", "");
  }

  public String gmailAddress() {
    return get("GMAIL_ADDRESS", "").trim().toLowerCase(Locale.ROOT);
  }

  public String waToken() {
    return get("WHATSAPP_ACCESS_TOKEN", "");
  }

  public String waPhoneId() {
    return get("WHATSAPP_PHONE_NUMBER_ID", "");
  }

  public String waSecret() {
    return get("WHATSAPP_APP_SECRET", "");
  }

  public String waVerify() {
    return get("WHATSAPP_VERIFY_TOKEN", "");
  }

  public String graphVersion() {
    return get("WHATSAPP_GRAPH_VERSION", "");
  }

  public boolean googleReady() {
    return !key().isEmpty()
        && !googleClientId().isEmpty()
        && !googleClientSecret().isEmpty()
        && !gmailAddress().isEmpty();
  }

  public boolean whatsappReady() {
    return !waToken().isEmpty()
        && !waPhoneId().isEmpty()
        && !waSecret().isEmpty()
        && !waVerify().isEmpty()
        && !graphVersion().isEmpty();
  }

  public Instant now() {
    String fixed = get("APP_TEST_NOW", "");
    return fixed.isEmpty() ? Instant.now() : Instant.parse(fixed);
  }

  public String at() {
    return Time.iso(now());
  }

  public String today() {
    return now().atZone(ZoneId.of(timezone())).toLocalDate().toString();
  }

  public List<Map<String, Object>> templates() {
    try {
      List<Map<String, Object>> list =
          Json.MAPPER.readValue(
              get("WHATSAPP_TEMPLATES_JSON", "[]"),
              new com.fasterxml.jackson.core.type.TypeReference<>() {});
      require(list.size() <= 20, "Too many templates");
      for (var t : list) {
        require(
            Json.str(t, "name").matches("[a-z0-9_]{1,512}")
                && Json.str(t, "language").matches("[a-zA-Z_]{2,10}")
                && t.get("body") instanceof String body
                && body.length() <= 2000
                && t.get("parameters") instanceof List<?> p
                && p.size() <= 10
                && p.stream().allMatch(x -> x instanceof String),
            "Invalid WhatsApp template catalog");
      }
      return list;
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid WhatsApp template catalog");
    }
  }
}
