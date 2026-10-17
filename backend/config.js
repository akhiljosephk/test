"use strict";
const path = require("node:path");
function config(env = process.env) {
  const production = env.NODE_ENV === "production";
  if (
    env.OWNER_TOTP_SECRET &&
    !/^[A-Z2-7]{16,128}$/i.test(env.OWNER_TOTP_SECRET)
  )
    throw new Error(
      "OWNER_TOTP_SECRET must be an unformatted base32 authenticator seed",
    );
  new Intl.DateTimeFormat("en-CA", {
    timeZone: env.BUSINESS_TIMEZONE || "America/Toronto",
  });
  const mode = env.MESSAGING_MODE || "mock";
  if (!["mock", "live"].includes(mode))
    throw new Error("MESSAGING_MODE must be mock or live");
  const key = env.DATA_KEY || "";
  if (key && !/^[a-f0-9]{64}$/i.test(key))
    throw new Error(
      "DATA_KEY must be 32 random bytes encoded as 64 hex characters",
    );
  if (production && !env.OWNER_TOTP_SECRET)
    throw new Error("Production requires OWNER_TOTP_SECRET for owner MFA");
  if (production && (!key || !env.PUBLIC_URL?.startsWith("https://")))
    throw new Error("Production requires DATA_KEY and an HTTPS PUBLIC_URL");
  const publicUrl = env.PUBLIC_URL || "http://localhost:" + (env.PORT || 3000);
  const graphVersion = env.WHATSAPP_GRAPH_VERSION || "";
  if (graphVersion && !/^v\d+\.\d+$/.test(graphVersion))
    throw new Error("Invalid WhatsApp Graph version");
  let templates = [];
  try {
    templates = JSON.parse(env.WHATSAPP_TEMPLATES_JSON || "[]");
  } catch {
    throw new Error("Invalid WHATSAPP_TEMPLATES_JSON");
  }
  if (
    !Array.isArray(templates) ||
    templates.length > 20 ||
    templates.some(
      (t) =>
        !/^[a-z0-9_]{1,512}$/.test(t.name) ||
        !/^[a-z_]{2,10}$/i.test(t.language) ||
        typeof t.body !== "string" ||
        t.body.length > 2000 ||
        !Array.isArray(t.parameters) ||
        t.parameters.some((p) => typeof p !== "string") ||
        t.parameters.length > 10,
    )
  )
    throw new Error("Invalid WhatsApp template catalog");
  return {
    production,
    mode,
    liveSends: env.ALLOW_LIVE_SENDS === "true",
    publicUrl: new URL(publicUrl).origin,
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || path.resolve("data/mapledesk.sqlite"),
    key,
    ownerEmail: (env.OWNER_EMAIL || "").trim().toLowerCase(),
    ownerPassword: env.OWNER_PASSWORD || "",
    totpSecret: env.OWNER_TOTP_SECRET || "",
    timezone: env.BUSINESS_TIMEZONE || "America/Toronto",
    business: env.BUSINESS_NAME || "Insurance workspace",
    googleClientId: env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    gmailAddress: (env.GMAIL_ADDRESS || "").trim().toLowerCase(),
    googleAuthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    waToken: env.WHATSAPP_ACCESS_TOKEN || "",
    waPhoneId: env.WHATSAPP_PHONE_NUMBER_ID || "",
    waAppSecret: env.WHATSAPP_APP_SECRET || "",
    waVerifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
    graphVersion,
    templates,
    backupBucket: env.BACKUP_BUCKET || "",
    backupPrefix: env.BACKUP_PREFIX || "mapledesk/",
    awsRegion: env.AWS_REGION || "ca-central-1",
    fetch: globalThis.fetch,
    now: () => new Date(),
  };
}
module.exports = { config };
