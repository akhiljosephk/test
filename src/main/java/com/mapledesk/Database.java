package com.mapledesk;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.sqlite.SQLiteConfig;
import org.sqlite.SQLiteDataSource;

public final class Database {
  private final JdbcTemplate jdbc;
  private final TransactionTemplate transactions;

  public Database(Settings cfg) {
    try {
      Path file = Path.of(cfg.dbPath()).toAbsolutePath();
      privateDirectory(file.getParent());
      SQLiteConfig config = new SQLiteConfig();
      config.enforceForeignKeys(true);
      config.setBusyTimeout(5000);
      SQLiteDataSource ds = new SQLiteDataSource(config);
      ds.setUrl("jdbc:sqlite:" + file);
      jdbc = new JdbcTemplate(ds);
      transactions = new TransactionTemplate(new DataSourceTransactionManager(ds));
      if (number("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_version'")
          > 0) {
        Settings.require(
            number("SELECT max(version) FROM schema_version") == 1,
            "Unsupported database schema version");
      } else {
        Settings.require(
            number(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE"
                        + " 'sqlite_%'")
                == 0,
            "Refusing to initialize an unrelated database");
      }
      jdbc.execute("PRAGMA journal_mode=WAL");
      String schema =
          new String(
              Objects.requireNonNull(getClass().getResourceAsStream("/schema.sql")).readAllBytes(),
              StandardCharsets.UTF_8);
      tx(
          () -> {
            for (String sql : schema.split(";")) if (!sql.isBlank()) jdbc.execute(sql);
            return null;
          });
      Settings.require(
          number("SELECT max(version) FROM schema_version") == 1,
          "Unsupported database schema version");
      permissions(file, "rw-------");
    } catch (Exception e) {
      throw new IllegalStateException("Cannot initialize database", e);
    }
  }

  public static void privateDirectory(Path path) throws java.io.IOException {
    boolean existed = Files.exists(path);
    Files.createDirectories(path);
    if (!existed) permissions(path, "rwx------");
  }

  public static void permissions(Path path, String mode) {
    try {
      Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(mode));
    } catch (UnsupportedOperationException ignored) {
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Cannot protect local file", e);
    }
  }

  public int update(String sql, Object... args) {
    return jdbc.update(sql, args);
  }

  public List<Map<String, Object>> list(String sql, Object... args) {
    return jdbc.queryForList(sql, args);
  }

  public Map<String, Object> one(String sql, Object... args) {
    var list = list(sql, args);
    return list.isEmpty() ? null : list.getFirst();
  }

  public long number(String sql, Object... args) {
    return Objects.requireNonNull(jdbc.queryForObject(sql, Long.class, args));
  }

  public <T> T tx(Supplier<T> work) {
    return transactions.execute(status -> work.get());
  }

  public boolean setting(String key) {
    var row = one("SELECT value FROM settings WHERE key=?", key);
    return row != null && "true".equals(row.get("value"));
  }

  public void audit(String event, Object entity) {
    update(
        "INSERT INTO audit VALUES(?,?,?,?)",
        id(),
        event,
        entity,
        Time.iso(java.time.Instant.now()));
  }

  public static String id() {
    return UUID.randomUUID().toString();
  }

  public String enqueue(String key, String type, Map<String, Object> payload, String at) {
    String id = id();
    int n =
        update(
            "INSERT OR IGNORE INTO jobs(id,dedupe_key,type,payload,available_at,created_at)"
                + " VALUES(?,?,?,?,?,?)",
            id,
            key,
            type,
            Json.write(payload),
            at,
            at);
    return n == 1 ? id : Json.str(one("SELECT id FROM jobs WHERE dedupe_key=?", key), "id");
  }

  public void snapshot(Path path) {
    jdbc.execute("VACUUM INTO '" + path.toAbsolutePath().toString().replace("'", "''") + "'");
    permissions(path, "rw-------");
  }
}
