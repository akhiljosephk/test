package com.mapledesk;

import static com.mapledesk.Json.*;
import static com.mapledesk.Settings.require;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

public final class Cli {
  private Cli() {}

  public static void run(String command, String[] args) throws Exception {
    var env = new LinkedHashMap<String, Object>(Application.dotenv());
    env.putAll(System.getenv());
    if (command.equals("init")) {
      require(
          Input.email(Objects.toString(env.get("OWNER_EMAIL"), "")),
          "Set OWNER_EMAIL privately first");
      require(
          Objects.toString(env.get("OWNER_PASSWORD"), "").length() >= 14,
          "Set OWNER_PASSWORD privately (14+ characters)");
      if (!Files.exists(Path.of(".env"))) {
        Path existingDb = Path.of(Objects.toString(env.get("DB_PATH"), "data/mapledesk.sqlite"));
        require(
            !Files.exists(existingDb)
                || Files.size(existingDb) == 0
                || !Objects.toString(env.get("DATA_KEY"), "").isBlank(),
            "Existing database found; restore its .env or supply its existing DATA_KEY before"
                + " initialization");
        String key = env.get("DATA_KEY") == null ? Crypto.random() : env.get("DATA_KEY").toString();
        Path file = Files.createFile(Path.of(".env"));
        Database.permissions(file, "rw-------");
        Files.writeString(
            file,
            "APP_ENV=development\nPORT=3000\nPUBLIC_URL=http://localhost:3000\nDATA_KEY="
                + key
                + "\nMESSAGING_MODE=mock\nALLOW_LIVE_SENDS=false\n");
        env = new LinkedHashMap<>(Application.dotenv());
        env.putAll(System.getenv());
      }
    }
    final var values = env;
    Settings cfg = new Settings(k -> Objects.toString(values.get(k), null));
    Map<String, String> options = new HashMap<>();
    for (String arg : args)
      if (arg.startsWith("--") && arg.contains("=")) {
        int i = arg.indexOf('=');
        options.put(arg.substring(2, i), arg.substring(i + 1));
      }
    switch (command) {
      case "init" -> {
        Database db = new Database(cfg);
        boolean existing = db.number("SELECT count(*) FROM users") > 0;
        AuthService.bootstrap(db, cfg);
        System.out.println(
            existing
                ? "Owner already exists; credentials and .env were preserved."
                : "Owner provisioned. No sample clients were added.");
      }
      case "reset-owner" -> {
        require(
            !cfg.ownerEmail().isEmpty() && cfg.ownerPassword().length() >= 14,
            "Set OWNER_EMAIL and a new OWNER_PASSWORD privately (14+ characters)");
        Database db = new Database(cfg);
        db.tx(
            () -> {
              require(
                  db.update(
                          "UPDATE users SET password_hash=?,last_totp=-1 WHERE email=?",
                          Crypto.password(cfg.ownerPassword()),
                          cfg.ownerEmail())
                      == 1,
                  "Owner not found");
              db.update("DELETE FROM sessions");
              return null;
            });
        System.out.println("Owner password reset; all sessions revoked.");
      }
      case "backup" -> backup(cfg);
      case "restore" -> {
        restore(
            cfg,
            Path.of(Objects.requireNonNull(options.get("source"), "Use --source=backup.enc")),
            Path.of(
                Objects.requireNonNull(
                    options.get("destination"), "Use --destination=NEW-DATABASE-PATH")));
        System.out.println(
            "Restored database integrity verified. Review the runbook before replacing the live"
                + " database.");
      }
      default -> throw new IllegalArgumentException("Unknown command: " + command);
    }
  }

  public static void backup(Settings cfg) throws Exception {
    require(
        !cfg.key().isEmpty() && !cfg.get("BACKUP_BUCKET", "").isEmpty(),
        "DATA_KEY and BACKUP_BUCKET are required");
    Path dir = Files.createTempDirectory("mapledesk-backup-");
    Database.permissions(dir, "rwx------");
    Path snapshot = dir.resolve("snapshot.sqlite");
    try {
      new Database(cfg).snapshot(snapshot);
      String encrypted =
          Crypto.encrypt(
              map(
                  "sqlite",
                  Base64.getEncoder().encodeToString(Files.readAllBytes(snapshot)),
                  "schema",
                  1),
              cfg.key());
      String key =
          cfg.get("BACKUP_PREFIX", "mapledesk/")
              + java.time.Instant.now().toString().replace(':', '-').replace('.', '-')
              + "-"
              + UUID.randomUUID()
              + ".enc";
      try (S3Client s3 =
          S3Client.builder().region(Region.of(cfg.get("AWS_REGION", "ca-central-1"))).build()) {
        s3.putObject(
            PutObjectRequest.builder()
                .bucket(cfg.get("BACKUP_BUCKET", ""))
                .key(key)
                .contentType("application/octet-stream")
                .serverSideEncryption("AES256")
                .build(),
            RequestBody.fromString(encrypted, StandardCharsets.UTF_8));
      }
      System.out.println("Encrypted backup uploaded successfully.");
    } finally {
      Files.deleteIfExists(snapshot);
      Files.deleteIfExists(dir);
    }
  }

  public static void restore(Settings cfg, Path source, Path destination) throws Exception {
    require(
        !Files.exists(destination) && !Files.exists(Path.of(destination + "-wal")),
        "Destination must be a new path; stop the app before swapping databases");
    var data = Crypto.decrypt(Files.readString(source), cfg.key());
    require(number(data.get("schema")) == 1, "Unsupported backup schema");
    Path dir = destination.toAbsolutePath().getParent();
    Database.privateDirectory(dir);
    Files.createFile(destination);
    Database.permissions(destination, "rw-------");
    boolean valid = false;
    try {
      Files.write(destination, Base64.getDecoder().decode(str(data, "sqlite")));
      try (Connection conn =
              DriverManager.getConnection(
                  "jdbc:sqlite:file:" + destination.toAbsolutePath() + "?mode=ro");
          Statement stmt = conn.createStatement();
          ResultSet result = stmt.executeQuery("PRAGMA integrity_check")) {
        require(
            result.next() && "ok".equals(result.getString(1)),
            "Restored database integrity check failed");
      }
      valid = true;
    } finally {
      if (!valid) Files.deleteIfExists(destination);
    }
  }
}
