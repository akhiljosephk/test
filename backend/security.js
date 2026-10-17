"use strict";
const crypto = require("node:crypto");
const OTPAuth = require("otpauth");
const { id } = require("./db");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("hex");
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  return (
    /^[a-f0-9]{128}$/.test(hash) &&
    crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"))
  );
}
function encrypt(value, key) {
  if (!key)
    throw new Error("DATA_KEY is required to store integration credentials");
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex"),
  ].join(":");
}
function decrypt(value, key) {
  const [iv, tag, data] = value.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "hex")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
function bootstrapOwner(db, cfg) {
  if (!cfg.ownerEmail || !cfg.ownerPassword) return;
  if (db.prepare("SELECT count(*) n FROM users").get().n) return;
  if (cfg.ownerPassword.length < 14)
    throw new Error("Owner password must contain at least 14 characters");
  if (cfg.production && !cfg.totpSecret)
    throw new Error(
      "Set OWNER_TOTP_SECRET before creating the production owner",
    );
  db.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").run(
    id(),
    cfg.ownerEmail,
    hashPassword(cfg.ownerPassword),
  );
}
function cookieToken(req) {
  const m = (req.headers.cookie || "").match(
    /(?:^|;\s*)md_session=([a-f0-9]{64})(?:;|$)/,
  );
  return m?.[1] || "";
}
function session(db, req) {
  return db
    .prepare(
      "SELECT sessions.*,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?",
    )
    .get(sha(cookieToken(req)), Date.now());
}
function totpCounter(token, secret) {
  const otp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  const delta = otp.validate({ token, window: 1 });
  return delta === null ? null : Math.floor(Date.now() / 30000) + delta;
}
module.exports = {
  sha,
  random,
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  bootstrapOwner,
  cookieToken,
  session,
  totpCounter,
};
