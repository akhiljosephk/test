"use strict";
const { encrypt, decrypt, random, sha } = require("./security");
const { inbound, saveContact, threadFor } = require("./domain");
const { audit, id } = require("./db");
class ProviderError extends Error {
  constructor(message, status = 0, ambiguous = false) {
    super(message);
    this.status = status;
    this.ambiguous = ambiguous;
  }
}
async function request(cfg, url, options = {}) {
  let response;
  try {
    response = await cfg.fetch(url, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ProviderError(
      "Provider connection failed; check connection and network policy",
      0,
      options.method === "POST",
    );
  }
  let data;
  try {
    const raw = await response.text();
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ProviderError(
      "Invalid provider response",
      response.status,
      options.method === "POST",
    );
  }
  if (!response.ok)
    throw new ProviderError(
      "Provider request rejected (HTTP " + response.status + ")",
      response.status,
      response.status >= 500 && options.method === "POST",
    );
  return data;
}
function integration(db, cfg, name) {
  const row = db.prepare("SELECT * FROM integrations WHERE name=?").get(name);
  return row
    ? {
        secret: decrypt(row.secret, cfg.key),
        metadata: JSON.parse(row.metadata),
      }
    : null;
}
function storeIntegration(db, cfg, name, secret, metadata) {
  db.prepare(
    "INSERT INTO integrations VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET secret=excluded.secret,metadata=excluded.metadata,updated_at=excluded.updated_at",
  ).run(
    name,
    encrypt(secret, cfg.key),
    JSON.stringify(metadata),
    cfg.now().toISOString(),
  );
}
function googleReady(cfg) {
  return Boolean(
    cfg.key && cfg.googleClientId && cfg.googleClientSecret && cfg.gmailAddress,
  );
}
function whatsappReady(cfg) {
  return Boolean(
    cfg.waToken &&
    cfg.waPhoneId &&
    cfg.waAppSecret &&
    cfg.waVerifyToken &&
    cfg.graphVersion,
  );
}
function googleAuth(db, cfg, sessionHash) {
  if (!googleReady(cfg))
    throw new Error(
      "Configure Google OAuth and the expected Gmail address first",
    );
  const state = random(),
    verifier = random();
  db.prepare("DELETE FROM oauth_states WHERE expires_at<?").run(Date.now());
  db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?)").run(
    sha(state),
    sessionHash,
    verifier,
    Date.now() + 600000,
  );
  const query = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: cfg.publicUrl + "/api/integrations/gmail/callback",
    response_type: "code",
    scope:
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: Buffer.from(sha(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
  });
  return cfg.googleAuthUrl + "?" + query;
}
async function googleCallback(db, cfg, { code, state, sessionHash }) {
  const row = db
    .prepare(
      "SELECT * FROM oauth_states WHERE hash=? AND session_hash=? AND expires_at>?",
    )
    .get(sha(state), sessionHash, Date.now());
  if (!row)
    throw new Error(
      "OAuth request expired or invalid; reconnect from settings",
    );
  db.prepare("DELETE FROM oauth_states WHERE hash=?").run(sha(state));
  const token = await request(cfg, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: cfg.publicUrl + "/api/integrations/gmail/callback",
      grant_type: "authorization_code",
      code_verifier: row.verifier,
    }),
  });
  if (!token.access_token || !token.refresh_token)
    throw new Error(
      "Google did not grant offline access; reconnect and approve consent",
    );
  const profile = await request(
    cfg,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: "Bearer " + token.access_token } },
  );
  if (profile.emailAddress.toLowerCase() !== cfg.gmailAddress)
    throw new Error(
      "Connected Gmail address does not match the configured mailbox",
    );
  storeIntegration(
    db,
    cfg,
    "gmail",
    {
      refresh_token: token.refresh_token,
      access_token: token.access_token,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
    },
    {
      address: profile.emailAddress,
      historyId: profile.historyId,
      initialSync: true,
    },
  );
  audit(db, "Gmail connected");
}
async function gmailToken(db, cfg) {
  const item = integration(db, cfg, "gmail");
  if (!item) throw new Error("Gmail is not connected");
  if (item.secret.expires_at > Date.now() + 60000)
    return item.secret.access_token;
  const token = await request(cfg, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      refresh_token: item.secret.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!token.access_token)
    throw new Error("Gmail authorization needs reconnection");
  storeIntegration(
    db,
    cfg,
    "gmail",
    {
      ...item.secret,
      access_token: token.access_token,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
    },
    item.metadata,
  );
  return token.access_token;
}
function header(payload, name) {
  return (
    payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}
function plainText(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data)
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  for (const p of payload.parts || []) {
    const text = plainText(p);
    if (text) return text;
  }
  return "";
}
function parseSender(from) {
  const match = from.match(
    /<?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?\s*$/i,
  );
  if (!match) return null;
  return {
    address: match[1].toLowerCase(),
    name:
      from
        .replace(match[0], "")
        .replace(/^["\s]+|["\s<]+$/g, "")
        .slice(0, 100) || match[1],
  };
}
async function importGmailMessage(db, cfg, token, messageId, historical) {
  const m = await request(
    cfg,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
      encodeURIComponent(messageId) +
      "?format=full",
    { headers: { Authorization: "Bearer " + token } },
  );
  const sender = parseSender(header(m.payload, "From"));
  if (m.labelIds?.includes("SENT") && sender?.address === cfg.gmailAddress) {
    // Reflect replies sent from Gmail itself without treating them as incoming leads.
    const recipients =
      header(m.payload, "To").match(
        /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      ) || [];
    if (recipients.length !== 1) return; // Multi-recipient threads remain in Gmail for manual review.
    const recipient = parseSender(header(m.payload, "To"));
    if (!recipient || recipient.address === cfg.gmailAddress) return;
    db.transaction(() => {
      const providerId = "gmail:" + m.id;
      if (
        db
          .prepare("SELECT id FROM messages WHERE provider_id=?")
          .get(providerId)
      )
        return;
      let client = db
        .prepare("SELECT * FROM contacts WHERE email=?")
        .get(recipient.address);
      if (!client) {
        const cid = saveContact(db, {
          name: recipient.name,
          email: recipient.address,
        });
        client = db.prepare("SELECT * FROM contacts WHERE id=?").get(cid);
      }
      const thread = threadFor(
        db,
        client.id,
        "email",
        header(m.payload, "Subject").slice(0, 200),
        m.threadId,
      );
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
        id(),
        thread.id,
        "out",
        (
          plainText(m.payload) ||
          m.snippet ||
          "[Non-text message: review in Gmail]"
        ).slice(0, 20000),
        "sent_external",
        providerId,
        header(m.payload, "Message-Id").replace(/[\r\n]/g, ""),
        new Date(Number(m.internalDate)).toISOString(),
      );
      audit(db, "Message sent in Gmail synchronized", client.id);
    })();
    return;
  }
  if (!m.labelIds?.includes("INBOX")) return;
  if (!sender || sender.address === cfg.gmailAddress) return;
  const automated = Boolean(
    header(m.payload, "List-Id") ||
    header(m.payload, "Precedence").match(/bulk|list|junk/i) ||
    (header(m.payload, "Auto-Submitted") &&
      !/^no$/i.test(header(m.payload, "Auto-Submitted"))),
  );
  const text =
    plainText(m.payload) || m.snippet || "[Non-text message: review in Gmail]";
  inbound(db, cfg, {
    channel: "email",
    eventId: "gmail:" + m.id,
    address: sender.address,
    name: sender.name,
    text,
    subject: header(m.payload, "Subject").slice(0, 200),
    threadId: m.threadId,
    rfcId: header(m.payload, "Message-Id").replace(/[\r\n]/g, ""),
    at: new Date(Number(m.internalDate)).toISOString(),
    historical,
    automated,
  });
}
async function syncGmail(db, cfg) {
  const item = integration(db, cfg, "gmail");
  if (!item) return { skipped: true };
  const token = await gmailToken(db, cfg),
    auth = { headers: { Authorization: "Bearer " + token } };
  if (item.metadata.initialSync) {
    const list = await request(
      cfg,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
        new URLSearchParams({
          q: "{in:inbox in:sent} newer_than:7d",
          maxResults: "20",
        }),
      auth,
    );
    for (const m of list.messages || [])
      await importGmailMessage(db, cfg, token, m.id, true);
    const latest = integration(db, cfg, "gmail");
    storeIntegration(db, cfg, "gmail", latest.secret, {
      ...item.metadata,
      initialSync: false,
      lastSync: cfg.now().toISOString(),
      lastError: null,
    });
    return { initial: true };
  }
  let pageToken = "",
    latestHistory = item.metadata.historyId;
  for (let page = 0; page < 20; page++) {
    let result;
    try {
      result = await request(
        cfg,
        "https://gmail.googleapis.com/gmail/v1/users/me/history?" +
          new URLSearchParams({
            startHistoryId: item.metadata.historyId,
            historyTypes: "messageAdded",
            maxResults: "100",
            ...(pageToken ? { pageToken } : {}),
          }),
        auth,
      );
    } catch (e) {
      if (e.status === 404) {
        const profile = await request(
          cfg,
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          auth,
        );
        const latest = integration(db, cfg, "gmail");
        storeIntegration(db, cfg, "gmail", latest.secret, {
          ...item.metadata,
          historyId: profile.historyId,
          initialSync: true,
          gapWarning:
            "Mailbox cursor expired. Re-importing recent messages without automatic replies; review Gmail for older gaps.",
        });
        return { rebaseline: true };
      }
      throw e;
    }
    for (const h of result.history || [])
      for (const added of h.messagesAdded || [])
        await importGmailMessage(db, cfg, token, added.message.id, false);
    latestHistory = result.historyId || latestHistory;
    pageToken = result.nextPageToken || "";
    if (!pageToken) {
      const latest = integration(db, cfg, "gmail");
      storeIntegration(db, cfg, "gmail", latest.secret, {
        ...item.metadata,
        historyId: latestHistory,
        lastSync: cfg.now().toISOString(),
        lastError: null,
      });
      return { synced: true };
    }
  }
  throw new Error(
    "Gmail sync backlog exceeds batch limit; cursor retained, repeat sync will deduplicate processed messages",
  );
}
async function sendGmail(db, cfg, contact, thread, text, automatic = false) {
  const token = await gmailToken(db, cfg);
  const subject = (thread.subject || "Your insurance enquiry")
    .replace(/[\r\n]/g, " ")
    .slice(0, 200);
  const previous = db
    .prepare(
      "SELECT rfc_id FROM messages WHERE thread_id=? AND direction='in' AND rfc_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(thread.id);
  const reply = previous?.rfc_id?.replace(/[\r\n]/g, "");
  const mime = [
    `From: ${cfg.gmailAddress}`,
    `To: ${contact.email}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    ...(automatic ? ["Auto-Submitted: auto-replied"] : []),
    ...(reply ? [`In-Reply-To: ${reply}`, `References: ${reply}`] : []),
    "",
    (
      Buffer.from(text)
        .toString("base64")
        .match(/.{1,76}/g) || []
    ).join("\r\n"),
  ].join("\r\n");
  const sent = await request(
    cfg,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: Buffer.from(mime).toString("base64url"),
        ...(thread.external_id ? { threadId: thread.external_id } : {}),
      }),
    },
  );
  return {
    providerId: "gmail:" + sent.id,
    externalId: sent.threadId,
    status: "sent",
  };
}
function templateText(cfg, template) {
  const spec = cfg.templates.find(
    (t) => t.name === template?.name && t.language === template?.language,
  );
  if (
    !spec ||
    !Array.isArray(template.parameters) ||
    template.parameters.length !== spec.parameters.length ||
    template.parameters.some(
      (v) =>
        typeof v !== "string" ||
        !v.trim() ||
        v.length > 300 ||
        /[\r\n]/.test(v),
    )
  )
    throw new Error(
      "Select a configured approved template and fill all parameters",
    );
  return spec.body.replace(
    /\{\{(\d+)\}\}/g,
    (_, n) => template.parameters[Number(n) - 1] || "",
  );
}
async function sendWhatsapp(cfg, contact, text, template) {
  const message = template
    ? {
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: [
            {
              type: "body",
              parameters: template.parameters.map((text) => ({
                type: "text",
                text,
              })),
            },
          ],
        },
      }
    : { type: "text", text: { body: text } };
  const sent = await request(
    cfg,
    `https://graph.facebook.com/${cfg.graphVersion}/${cfg.waPhoneId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + cfg.waToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: contact.phone.slice(1),
        ...message,
      }),
    },
  );
  if (!sent.messages?.[0]?.id)
    throw new ProviderError("WhatsApp response omitted message ID", 200, true);
  return { providerId: sent.messages[0].id, status: "sent" };
}
async function testWhatsapp(cfg) {
  if (!whatsappReady(cfg))
    throw new Error(
      "Configure WhatsApp business API credentials and version first",
    );
  const p = await request(
    cfg,
    `https://graph.facebook.com/${cfg.graphVersion}/${cfg.waPhoneId}?fields=display_phone_number,verified_name`,
    { headers: { Authorization: "Bearer " + cfg.waToken } },
  );
  return {
    display_phone_number: p.display_phone_number,
    verified_name: p.verified_name,
  };
}
module.exports = {
  ProviderError,
  request,
  integration,
  storeIntegration,
  googleReady,
  whatsappReady,
  googleAuth,
  googleCallback,
  gmailToken,
  syncGmail,
  sendGmail,
  sendWhatsapp,
  testWhatsapp,
  templateText,
  parseSender,
};
