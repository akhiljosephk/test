package com.mapledesk;

import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class AuthService {
  private final Database db;
  private final Settings cfg;
  private static final String DUMMY = Crypto.password("not-a-real-account-password");

  public AuthService(Database db, Settings cfg) {
    this.db = db;
    this.cfg = cfg;
    bootstrap(db, cfg);
  }

  public static void bootstrap(Database db, Settings cfg) {
    if (cfg.ownerEmail().isEmpty()
        || cfg.ownerPassword().isEmpty()
        || db.number("SELECT count(*) FROM users") > 0) return;
    Settings.require(Input.email(cfg.ownerEmail()), "Configure a valid owner email");
    Settings.require(
        cfg.ownerPassword().length() >= 14 && cfg.ownerPassword().length() <= 500,
        "Owner password must be 14–500 characters");
    db.update(
        "INSERT INTO users(id,email,password_hash) VALUES(?,?,?)",
        Database.id(),
        cfg.ownerEmail(),
        Crypto.password(cfg.ownerPassword()));
  }

  public Map<String, Object> session(String token) {
    return db.one(
        "SELECT sessions.*,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE"
            + " token_hash=? AND expires_at>?",
        Crypto.sha(token),
        System.currentTimeMillis());
  }

  public Map<String, Object> login(String email, String password, String code, String ip) {
    Settings.require(
        Input.email(email) && password != null && !password.isEmpty() && password.length() <= 500,
        "Invalid sign-in details");
    String key = Crypto.sha(ip == null ? "unknown" : ip);
    long now = System.currentTimeMillis();
    db.update("DELETE FROM login_limits WHERE expires_at<?", now);
    var limit = db.one("SELECT * FROM login_limits WHERE key=?", key);
    if (limit != null && Json.number(limit.get("count")) >= 10)
      throw new ApiException(429, "Too many attempts. Try again in 15 minutes.");
    db.update(
        "INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        key,
        now + 900000);
    var user = db.one("SELECT * FROM users WHERE email=?", email.trim().toLowerCase(Locale.ROOT));
    boolean valid = Crypto.verify(password, user == null ? DUMMY : Json.str(user, "password_hash"));
    Long counter =
        cfg.totpSecret().isEmpty() ? null : Crypto.validCounter(code, cfg.totpSecret(), now);
    if (user == null
        || !valid
        || !cfg.totpSecret().isEmpty()
            && (counter == null || counter <= Json.number(user.get("last_totp"))))
      throw new ApiException(401, "Sign-in failed. Check email, password and authenticator code.");
    return db.tx(
        () -> {
          if (counter != null) {
            int changed =
                db.update(
                    "UPDATE users SET last_totp=? WHERE id=? AND last_totp<?",
                    counter,
                    user.get("id"),
                    counter);
            if (changed != 1) throw new ApiException(401, "Authenticator code already used");
          }
          if (!Json.str(user, "password_hash").startsWith("{bcrypt-sha256}"))
            db.update(
                "UPDATE users SET password_hash=? WHERE id=?",
                Crypto.password(password),
                user.get("id"));
          db.update("DELETE FROM sessions WHERE expires_at<?", now);
          String token = Crypto.random(), csrf = Crypto.random();
          db.update(
              "INSERT INTO sessions VALUES(?,?,?,?)",
              Crypto.sha(token),
              user.get("id"),
              csrf,
              now + 12 * 3600000L);
          db.update("DELETE FROM login_limits WHERE key=?", key);
          db.audit("Owner signed in", user.get("id"));
          return Json.map("token", token, "csrf", csrf, "email", user.get("email"));
        });
  }
}
