package com.mapledesk;

import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

public final class Crypto {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final BCryptPasswordEncoder PASSWORDS = new BCryptPasswordEncoder(12);

  public static String random() {
    byte[] b = new byte[32];
    RANDOM.nextBytes(b);
    return HexFormat.of().formatHex(b);
  }

  public static String sha(String s) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public static boolean equal(String a, String b) {
    return MessageDigest.isEqual(
        a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
  }

  public static String password(String value) {
    return "{bcrypt-sha256}" + PASSWORDS.encode(sha(value));
  }

  public static boolean verify(String value, String stored) {
    if (stored.startsWith("{bcrypt-sha256}"))
      return PASSWORDS.matches(sha(value), stored.substring(15));
    if (stored.startsWith("$2"))
      return value.getBytes(StandardCharsets.UTF_8).length <= 72
          && PASSWORDS.matches(value, stored);
    if (!stored.matches("[a-f0-9]{32}:[a-f0-9]{128}")) return false;
    String[] parts = stored.split(":");
    byte[] actual =
        SCrypt.generate(
            value.getBytes(StandardCharsets.UTF_8),
            parts[0].getBytes(StandardCharsets.UTF_8),
            16384,
            8,
            1,
            64);
    return MessageDigest.isEqual(actual, HexFormat.of().parseHex(parts[1]));
  }

  public static String encrypt(Object value, String key) {
    Settings.require(!key.isEmpty(), "DATA_KEY is required to store integration credentials");
    try {
      byte[] iv = new byte[12];
      RANDOM.nextBytes(iv);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(
          Cipher.ENCRYPT_MODE,
          new SecretKeySpec(HexFormat.of().parseHex(key), "AES"),
          new GCMParameterSpec(128, iv));
      byte[] all = c.doFinal(Json.write(value).getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(iv)
          + ":"
          + HexFormat.of().formatHex(Arrays.copyOfRange(all, all.length - 16, all.length))
          + ":"
          + HexFormat.of().formatHex(Arrays.copyOf(all, all.length - 16));
    } catch (Exception e) {
      throw new IllegalStateException("Cannot encrypt data", e);
    }
  }

  public static Map<String, Object> decrypt(String value, String key) {
    try {
      String[] p = value.split(":", -1);
      byte[] data = HexFormat.of().parseHex(p[2]), tag = HexFormat.of().parseHex(p[1]);
      byte[] all = Arrays.copyOf(data, data.length + tag.length);
      System.arraycopy(tag, 0, all, data.length, tag.length);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(
          Cipher.DECRYPT_MODE,
          new SecretKeySpec(HexFormat.of().parseHex(key), "AES"),
          new GCMParameterSpec(128, HexFormat.of().parseHex(p[0])));
      return Json.read(new String(c.doFinal(all), StandardCharsets.UTF_8));
    } catch (Exception e) {
      throw new IllegalArgumentException("Encrypted data cannot be verified; check DATA_KEY");
    }
  }

  public static String totp(String secret, long counter) {
    try {
      byte[] key = base32(secret);
      Mac mac = Mac.getInstance("HmacSHA1");
      mac.init(new SecretKeySpec(key, "HmacSHA1"));
      byte[] hash = mac.doFinal(ByteBuffer.allocate(8).putLong(counter).array());
      int offset = hash[hash.length - 1] & 15;
      int n = ByteBuffer.wrap(hash, offset, 4).getInt() & 0x7fffffff;
      return String.format(Locale.ROOT, "%06d", n % 1000000);
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid authenticator configuration");
    }
  }

  private static byte[] base32(String value) {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    int buffer = 0, bits = 0;
    for (char c : value.toUpperCase(Locale.ROOT).toCharArray()) {
      if (c == '=') break;
      int n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
      Settings.require(n >= 0, "Invalid authenticator seed");
      buffer = (buffer << 5) | n;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.write((buffer >> bits) & 255);
      }
    }
    return out.toByteArray();
  }

  public static Long validCounter(String code, String secret, long milliseconds) {
    if (code == null || !code.matches("\\d{6}")) return null;
    long current = milliseconds / 30000;
    for (long counter = current - 1; counter <= current + 1; counter++)
      if (equal(code, totp(secret, counter))) return counter;
    return null;
  }
}
