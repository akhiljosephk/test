"use strict";
let S = null,
  csrf = "",
  page = location.hash.slice(1) || "dashboard",
  threadId = null,
  channelFilter = "all",
  search = "",
  month = "",
  leadStatus = "all",
  requestStatus = "all";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const pages = {
  dashboard: "Overview",
  leads: "Clients & follow-ups",
  inbox: "WhatsApp & Gmail",
  policies: "Policies & reminders",
  requests: "Change requests",
  activity: "Activity & jobs",
  settings: "Connections & settings",
};
const channel = (c) => (c === "email" ? "✉ Gmail" : "◉ WhatsApp");
const contact = (id) => S.contacts.find((c) => c.id === id);
const first = (c) => c.name.split(" ")[0];
const initials = (n) =>
  n
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("");
const avatar = (c) => `<span class="avatar">${esc(initials(c.name))}</span>`;
const date = (s) =>
  s
    ? new Date(s + "T12:00:00Z").toLocaleDateString("en-CA", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Not set";
const fmt = (s) =>
  new Date(s).toLocaleString("en-CA", {
    timeZone: S.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
const days = (d) =>
  Math.round(
    (new Date(d + "T12:00:00Z") - new Date(S.today + "T12:00:00Z")) / 86400000,
  );
const isOpen = (l) => !["Won", "Lost"].includes(l.status);
const badge = (s, tone = "") => `<span class="pill ${tone}">${esc(s)}</span>`;
const b = (text, action, attrs = "", primary = false) =>
  `<button type="button" class="button ${primary ? "primary" : ""}" data-action="${action}" ${attrs}>${text}</button>`;
const empty = (title, text, button = "") =>
  `<div class="workspace-empty"><h2>${title}</h2><p>${text}</p>${button}</div>`;
let toastTimer;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
async function api(url, method = "GET", body) {
  const response = await fetch("/api" + url, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== "/login") {
      S = null;
      login();
    }
    throw new Error(data.error || "Request failed");
  }
  return data;
}
async function refresh() {
  S = await api("/state");
  render();
}
function login() {
  csrf = "";
  $("#workspace").innerHTML =
    `<div class="login-screen"><section class="login-intro"><div class="brand"><span class="brand-icon">✦</span>MapleDesk.</div><h1>A little clarity.<br>A better day.</h1><p>More time for your clients. Less time chasing conversations, dates, and details.</p><p class="hint">A private workspace for your insurance practice.</p></section><section class="login-form"><div class="brand"><span class="brand-icon">✦</span>MapleDesk.</div><div class="eyebrow">YOUR WORKSPACE AWAITS</div><h1>Welcome back.</h1><p class="subtext">Sign in to your broker workspace.</p><form id="login-form"><label class="field">Email<input type="email" name="email" autocomplete="username" required></label><label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label><label class="field">Authenticator code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="Required when MFA is configured"></label><p id="login-error" class="form-error" role="alert"></p><button class="button primary">Sign in</button></form><p class="hint">Access is provisioned by the workspace administrator. There is no public sign-up.</p></section></div>`;
}
function head(title, sub, actions = "") {
  return `<div class="page-head"><div><div class="eyebrow">YOUR INSURANCE WORKSPACE</div><h1>${title}</h1><p class="subtext">${sub}</p></div><div class="actions">${actions}</div></div>`;
}
function render() {
  if (!S) return;
  page = Object.hasOwn(pages, page) ? page : "dashboard";
  $("#workspace").innerHTML =
    `<aside class="sidebar"><a class="brand" href="#dashboard"><span class="brand-icon">✦</span>MapleDesk.</a><div class="workspace">${avatar({ name: S.business })}<div><b>${esc(S.business)}</b><small>${esc(S.timezone)}</small></div></div><div class="nav-label">WORKSPACE</div><nav id="nav">${Object.entries(
      pages,
    )
      .map(
        ([k, v], i) =>
          `<button class="nav-item ${k === page ? "active" : ""}" data-page="${k}"><span>${["▦", "♧", "✉", "◷", "☷", "↗", "⚙"][i]}</span>${v}${k === "requests" ? `<span class="count">${S.requests.filter((r) => r.status !== "Completed").length}</span>` : ""}</button>`,
      )
      .join(
        "",
      )}</nav><div class="sidebar-bottom"><div class="plan-card"><span class="plan-label">SINGLE-BROKER EDITION</span><p>Built around your practice.<br>No subscription billing yet.</p></div><div class="profile">${avatar({ name: S.owner })}<div><b>Workspace owner</b><small>${esc(S.owner)}</small></div></div><button class="nav-item" data-action="logout">Sign out</button></div></aside><div class="app"><header class="topbar"><button id="mobile-menu" aria-label="Toggle navigation">☰</button><div class="breadcrumb">Workspace <span>/</span><b>${pages[page]}</b></div><div class="top-actions"><span class="demo-pill ${S.mode === "live" ? "badge-live" : ""}">${S.mode === "mock" ? "Mock delivery · persistent data" : S.liveSends ? "Live sending enabled" : "Live connections · sending disabled"}</span><button class="icon-button" data-action="refresh" aria-label="Refresh workspace">↻</button></div></header><div class="demo-banner"><span>${S.mode === "mock" ? "Messages are simulated. Your records are stored on the server, not in browser storage." : "Review recipients and content before sending. Policy changes require insurer confirmation."}</span><button data-page="settings">Connection settings</button></div><main id="main">${{ dashboard, leads, inbox, policies, requests, activity, settings }[page]()}</main><footer>MapleDesk <span>Built for the human side of insurance.</span><span>${date(S.today)} · ${esc(S.timezone)}</span></footer></div>`;
}
function leadTable(list) {
  return `<div class="table-wrap"><table><thead><tr><th>CLIENT</th><th>INSURANCE</th><th>NEXT CHECK-IN</th><th>STATUS</th><th></th></tr></thead><tbody>${list
    .map((l) => {
      const c = contact(l.contact_id);
      return `<tr><td><div class="person">${avatar(c)}<div><strong>${esc(c.name)}</strong><small>${esc(c.email || c.phone)}</small></div></div></td><td>${esc(l.insurance_type)}<small>${channel(l.channel)}</small></td><td>${date(l.due)} ${l.due < S.today && isOpen(l) ? badge("Overdue", "red") : ""}</td><td>${badge(l.status, l.status === "Won" ? "green" : "blue")}${c.opted_out ? "<small>Opted out</small>" : ""}</td><td><div class="actions">${b("Details", "lead", `data-id="${l.id}"`)}${isOpen(l) ? b("Follow up", "followup", `data-id="${l.id}"`, true) : ""}</div></td></tr>`;
    })
    .join(
      "",
    )}</tbody></table>${!list.length ? empty("A clear queue.", "No leads match this view.") : ""}</div>`;
}
function dashboard() {
  const due = S.leads.filter(
      (l) => isOpen(l) && l.due <= S.today && !contact(l.contact_id).opted_out,
    ),
    reminders = S.jobs.filter(
      (j) => j.type === "reminder" && j.status === "draft",
    );
  return (
    head(
      "A little clarity. A better day.",
      "Your conversations, clients, and next steps — together.",
      b("＋ Add client", "lead", "", true),
    ) +
    `<div class="stats">${[
      ["Follow-ups due", due.length, "leads"],
      ["Reminder drafts", reminders.length, "policies"],
      [
        "Open requests",
        S.requests.filter((r) => r.status !== "Completed").length,
        "requests",
      ],
      ["Clients", S.contacts.length, "leads"],
    ]
      .map(
        ([label, value, p]) =>
          `<button class="stat" data-page="${p}"><div class="stat-top">${label}<span>↗</span></div><div class="stat-value">${String(value).padStart(2, "0")}</div><div class="stat-foot">View details</div></button>`,
      )
      .join(
        "",
      )}</div><div class="grid"><section class="card"><div class="card-header"><div><h2>Conversations to keep going</h2><p>Keep names unchanged. Organize by date and status.</p></div></div>${S.contacts.length ? leadTable(due) : empty("Your workspace starts here.", "Add your first client, then import policies or connect a channel.", b("Add your first client", "lead", "", true))}</section><section class="card"><div class="card-header"><h2>Your next steps</h2></div><div class="card-body"><div class="mini-row"><span class="circle-icon">✉</span><div class="details"><strong>Connect Gmail</strong><p>${S.integrations.gmail.connected ? "Connected: " + esc(S.integrations.gmail.address) : "Bring email conversations into your workspace."}</p></div><button data-page="settings">Open</button></div><div class="mini-row"><span class="circle-icon">◉</span><div class="details"><strong>WhatsApp Business</strong><p>${S.integrations.whatsapp.configured ? "API credentials configured; test before sending." : "Confirm phone-app coexistence before onboarding."}</p></div><button data-page="settings">Open</button></div><div class="mini-row"><span class="circle-icon">◷</span><div class="details"><strong>Policy reminders</strong><p>Import policy dates. Review 30-day and 7-day drafts.</p></div><button data-page="policies">Open</button></div></div></section></div><div class="notice">Acknowledgements confirm receipt only. Review client details and insurer approval before completing a policy change.</div>`
  );
}
function leads() {
  const orphan = S.contacts.filter(
    (c) =>
      !S.leads.some((l) => l.contact_id === c.id) &&
      (c.name + " " + (c.email || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const list = S.leads.filter((l) => {
    const c = contact(l.contact_id);
    return (
      (c.name + " " + (c.email || "") + " " + l.insurance_type)
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!month || l.due.startsWith(month)) &&
      (leadStatus === "all" || l.status === leadStatus)
    );
  });
  return (
    head(
      "Clients & follow-ups",
      "Every relationship, with its next action in view.",
      b("＋ Add client", "lead", "", true),
    ) +
    `<div class="toolbar"><input class="search" id="search" value="${esc(search)}" placeholder="Search client, email, or insurance…" aria-label="Search clients"><input class="filter search-month" id="month" type="month" value="${month}" aria-label="Follow-up month"><select class="filter" id="lead-status" aria-label="Filter lead status">${["all", "New enquiry", "Quote sent", "Awaiting reply", "Won", "Lost"].map((s) => `<option value="${s}" ${s === leadStatus ? "selected" : ""}>${s === "all" ? "All statuses" : s}</option>`).join("")}</select>${b("Clear filters", "clear-filters")}</div><section class="card">${leadTable(list)}</section>${orphan.length ? `<section class="card section-space"><div class="card-header"><h2>Other client contacts</h2></div><div class="card-body">${orphan.map((c) => `<div class="mini-row">${avatar(c)}<div class="details"><strong>${esc(c.name)}</strong><p>${esc(c.email || c.phone)}</p></div>${b("Contact details", "contact", `data-id="${c.id}"`)}</div>`).join("")}</div></section>` : ""}`
  );
}
function inbox() {
  const list = S.threads.filter(
    (t) => channelFilter === "all" || t.channel === channelFilter,
  );
  let t = list.find((t) => t.id === threadId) || list[0];
  threadId = t?.id;
  const c = t ? contact(t.contact_id) : null;
  return (
    head(
      "One inbox. Both channels.",
      "Real conversation history lives on your server.",
      S.mode === "mock"
        ? b("＋ Simulate incoming", "simulate", "", true)
        : b("Sync Gmail", "sync-gmail"),
    ) +
    `<div class="toolbar">${["all", "whatsapp", "email"].map((k) => b(k === "all" ? "All conversations" : channel(k), "inbox-filter", `data-channel="${k}"`, channelFilter === k)).join("")}</div><section class="card inbox-layout"><div class="thread-list">${
      list
        .map((t) => {
          const c = contact(t.contact_id),
            m = S.messages.filter((m) => m.thread_id === t.id).at(-1);
          return `<button class="thread ${t.id === threadId ? "active" : ""}" data-action="thread" data-id="${t.id}">${avatar(c)}<div class="details"><b>${esc(c.name)}</b><p>${esc(m?.text || "No messages yet")}</p><small>${channel(t.channel)}</small></div></button>`;
        })
        .join("") ||
      empty("No conversations yet.", "Connect a channel or send a follow-up.")
    }</div>${
      t
        ? `<div class="chat"><div class="chat-head">${avatar(c)}<div class="details"><b>${esc(c.name)}</b><small>${channel(t.channel)} · ${esc(t.channel === "email" ? c.email : c.phone)}</small></div><div class="actions">${b("Client", "contact", `data-id="${c.id}"`)}${b("Create task", "task", `data-contact="${c.id}" data-channel="${t.channel}"`)}${b("Reply", "reply", `data-contact="${c.id}" data-channel="${t.channel}"`, true)}</div></div><div class="messages">${t.channel === "email" ? `<div class="subject">${esc(t.subject)}</div>` : ""}${
            S.messages
              .filter((m) => m.thread_id === t.id)
              .map((m) => {
                const job = S.jobs.find((j) => j.payload.messageId === m.id);
                return `<div class="bubble ${m.direction === "out" ? "out" : ""}">${esc(m.text)}<small>${fmt(m.created_at)} · ${esc(m.status)}</small>${m.status === "handoff" ? `<div class="actions section-space">${b("Open draft", "reopen-handoff", `data-id="${m.id}"`)}${b("I sent this in WhatsApp", "confirm-manual", `data-id="${m.id}"`)}</div>` : ""}${job?.last_error ? `<div class="status-line">${esc(job.last_error)}</div>` : ""}</div>`;
              })
              .join("") || '<div class="empty">Send a message to begin.</div>'
          }</div><div class="chat-compose"><div class="actions"><span class="hint">${c.opted_out ? "Client opted out — outgoing messages blocked." : "Review every outgoing message before sending."}</span>${b("Compose reply", "reply", `data-contact="${c.id}" data-channel="${t.channel}"`, true)}</div></div></div>`
        : empty(
            "Keep your conversations connected.",
            "Emails and WhatsApp messages appear here.",
          )
    }</section>`
  );
}
function policies() {
  const drafts = S.jobs.filter(
    (j) => j.type === "reminder" && j.status === "draft",
  );
  return (
    head(
      "Dates worth remembering.",
      "Manual and CSV policy records. No insurer portal sync.",
      b("Import CSV", "import") + b("＋ Add policy", "policy", "", true),
    ) +
    `<div class="notice">30-day and 7-day drafts are generated daily in ${esc(S.timezone)}. Last verified dates show how fresh your policy records are. Update them after insurer changes.</div>${
      drafts.length
        ? `<section class="card section-space"><div class="card-header"><h2>Ready for review · ${drafts.length} reminders</h2></div><div class="card-body">${drafts
            .map((j) => {
              const p = S.policies.find((p) => p.id === j.payload.policyId);
              if (
                !p ||
                p.status !== "Active" ||
                p[j.payload.event] !== j.payload.date
              )
                return "";
              const c = contact(p.contact_id);
              return `<div class="mini-row">${avatar(c)}<div class="details"><strong>${esc(c.name)}</strong><p>${esc(p.number)} · ${j.payload.event === "expiry" ? "Expires" : "Starts"} ${date(j.payload.date)} · ${j.payload.days} days</p></div>${b("Review reminder", "reminder", `data-id="${p.id}" data-event="${j.payload.event}"`, true)}</div>`;
            })
            .join("")}</div></section>`
        : ""
    }<section class="card section-space"><div class="table-wrap"><table><thead><tr><th>CLIENT / POLICY</th><th>INSURER</th><th>EFFECTIVE</th><th>EXPIRY</th><th>STATUS / VERIFIED</th><th></th></tr></thead><tbody>${S.policies.map((p) => `<tr><td><strong>${esc(contact(p.contact_id).name)}</strong><small>${esc(p.number)} · ${esc(p.insurance_type)}</small></td><td>${esc(p.insurer)}</td><td>${date(p.effective)}</td><td>${date(p.expiry)}<small>${days(p.expiry)} days from today</small></td><td>${badge(p.status, "green")}<small>${fmt(p.verified_at)}</small></td><td><div class="actions">${b("Edit", "policy", `data-id="${p.id}"`)}${b("Remind", "reminder", `data-id="${p.id}" data-event="expiry"`)}</div></td></tr>`).join("")}</tbody></table>${!S.policies.length ? empty("Every policy has an important date.", "Add a client first, then enter a policy or import a CSV.") : ""}</div></section>`
  );
}
function requests() {
  const list = S.requests.filter(
    (r) => requestStatus === "all" || r.status === requestStatus,
  );
  return (
    head(
      "Acknowledged. Now, action.",
      "Incoming changes become review tasks. Insurer updates remain manual.",
      b("＋ Create task", "task", "", true),
    ) +
    `<div class="toolbar"><select class="filter" id="request-status" aria-label="Filter request status">${["all", "Open", "In progress", "Completed"].map((k) => `<option value="${k}" ${requestStatus === k ? "selected" : ""}>${k === "all" ? "All requests" : k}</option>`).join("")}</select><span class="hint">Automatic receipt acknowledgements: ${S.settings.autoAck ? "enabled" : "disabled"}</span></div><section class="card"><div class="table-wrap"><table><thead><tr><th>CLIENT</th><th>REQUEST</th><th>CHANNEL</th><th>ACKNOWLEDGEMENT</th><th>STATUS</th><th></th></tr></thead><tbody>${list
      .map((r) => {
        const m = S.messages.find((m) => m.id === r.ack_message_id);
        return `<tr><td><strong>${esc(contact(r.contact_id).name)}</strong><small>${fmt(r.created_at)}</small></td><td>${esc(r.kind)}</td><td>${channel(r.channel)}</td><td>${badge(m?.status || "Not sent", m?.status === "sent" ? "green" : "")}</td><td>${badge(r.status, "blue")}</td><td>${b("Review task", "task", `data-id="${r.id}"`)}</td></tr>`;
      })
      .join(
        "",
      )}</tbody></table>${!list.length ? empty("A clear task list.", "Client change requests will appear here. General messages still need review in the inbox.") : ""}</div></section><div class="notice section-space">Request detection uses simple rules to flag DOB, address, phone, and policy-date changes. It can miss ambiguous wording; review all inbox messages. Create a task manually when needed.</div>`
  );
}
function activity() {
  return (
    head(
      "What happened. What needs attention.",
      "Inspect message outcomes and background work.",
    ) +
    `<section class="card"><div class="card-header"><h2>Background jobs</h2></div><div class="table-wrap"><table><thead><tr><th>TYPE</th><th>STATUS</th><th>CREATED</th><th>DETAILS</th></tr></thead><tbody>${S.jobs
      .slice(0, 50)
      .map(
        (j) =>
          `<tr><td>${esc(j.type)}</td><td>${badge(j.status, ["failed", "needs_review"].includes(j.status) ? "red" : "green")}</td><td>${fmt(j.created_at)}</td><td class="job-error">${esc(j.last_error || "—")}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table>${!S.jobs.length ? empty("No background jobs yet.", "New reminders and outgoing messages will appear here.") : ""}</div></section><section class="card section-space"><div class="card-header"><h2>Audit activity</h2></div><div class="card-body">${S.audit.map((a) => `<div class="activity"><span class="activity-dot"></span><div>${esc(a.event)}<small>${fmt(a.created_at)}</small></div></div>`).join("") || '<p class="hint">No activity yet.</p>'}</div></section><div class="notice section-space">A needs_review send may already have reached the provider. Check Gmail or WhatsApp before composing a replacement. The system does not automatically resend ambiguous outcomes.</div>`
  );
}
function settings() {
  const g = S.integrations.gmail,
    w = S.integrations.whatsapp;
  return (
    head(
      "Connected on your terms.",
      "Gmail and official WhatsApp Business API connections.",
    ) +
    `<div class="settings-grid"><section class="card integration"><div class="integration-icon">✉</div><h2>Gmail</h2><p>${g.connected ? esc(g.address) : "Connect the broker’s existing Gmail account using Google consent."}</p><div class="hint">${g.connected ? "Last sync: " + (g.lastSync ? fmt(g.lastSync) : "Awaiting initial import") : g.configured ? "OAuth configuration ready." : "Google Cloud OAuth credentials and mailbox address are not configured."}</div>${g.error ? `<div class="inline-error">${esc(g.error)}</div>` : ""}<div class="actions">${badge(g.connected ? "Connected" : "Not connected", g.connected ? "green" : "amber")}<div class="actions">${g.connected ? b("Sync now", "sync-gmail") + b("Disconnect", "disconnect-gmail") : b("Connect Gmail", "connect-gmail", "", true)}</div></div></section><section class="card integration"><div class="integration-icon">◉</div><h2>WhatsApp Business</h2><p>Keep the phone app where Meta’s supported coexistence route is available. Do not migrate the number before confirming eligibility.</p><div class="hint">${w.configured ? "API credentials configured. A read-only connection test is available." : "Meta business API credentials and webhook configuration are required."}</div><div class="actions">${badge(w.configured ? "Configured · not a connectivity guarantee" : "Not configured", w.configured ? "green" : "amber")}${b("Test API connection", "test-whatsapp")}</div></section></div><section class="card section-space"><div class="card-header"><h2>A little automation, with clear boundaries.</h2></div><form id="settings-form"><div class="card-body"><div class="rule"><div><b>Automatic change-request acknowledgements</b><p>Send a receipt-only reply for detected incoming requests when channel rules allow it.</p></div><input type="checkbox" name="autoAck" class="toggle" aria-label="Automatic acknowledgements" ${S.settings.autoAck ? "checked" : ""}></div><div class="rule"><div><b>Policy reminder drafts</b><p>Prepare 30-day and 7-day effective/expiry reminders. Broker review is required before sending.</p></div><input type="checkbox" name="reminders" class="toggle" aria-label="Policy reminder drafts" ${S.settings.reminders ? "checked" : ""}></div><div class="actions section-space"><button class="button primary">Save automation settings</button></div></div></form></section><div class="notice section-space">${S.mode === "mock" ? "This workspace is in mock delivery mode. No external sends or mailbox synchronization occur. Switch to live mode only after provider configuration and supervised tests." : S.liveSends ? "Live sending is enabled. Consent, opt-outs, and WhatsApp template requirements are checked at queue time and again before sending." : "Live connections are available, but outgoing sends are disabled by ALLOW_LIVE_SENDS."} Google authorization is separate from your workspace sign-in. Secrets are entered in server configuration, never in this page.</div>`
  );
}
function dialog(title, html) {
  $("#dialog-body").innerHTML =
    `<div class="modal-head"><h2>${title}</h2><button class="icon-button" data-action="close" aria-label="Close dialog">×</button></div>${html}`;
  if (!$("#dialog").open) $("#dialog").showModal();
}
function close() {
  $("#dialog").close();
  $("#dialog-body").innerHTML = "";
}
const field = (label, name, value = "", type = "text", required = true) =>
  `<label class="field">${label}<input type="${type}" name="${name}" value="${esc(value)}" ${required ? "required" : ""}></label>`;
const select = (label, name, options, value) =>
  `<label class="field">${label}<select name="${name}">${options
    .map((o) => {
      const [v, n] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(n)}</option>`;
    })
    .join("")}</select></label>`;
const formEnd = (text = "Save") =>
  `<p class="form-error" id="form-error" role="alert"></p></div><div class="modal-foot">${b("Cancel", "close")}<button class="button primary" type="submit">${text}</button></div></form>`;
function leadForm(id) {
  const l = S.leads.find((l) => l.id === id),
    c = l ? contact(l.contact_id) : {};
  dialog(
    l ? "Client details" : "A new relationship starts here",
    `<form id="lead-form" data-id="${l?.id || ""}"><div class="modal-body">${field("Full name", "name", c.name || "")}<div class="form-grid">${field("Email", "email", c.email || "", "email", false)}${field("Phone · E.164 format", "phone", c.phone || "", "tel", false)}</div><div class="form-grid">${field("Insurance type", "insurance_type", l?.insurance_type || "Super Visa")}${select("Status", "status", ["New enquiry", "Quote sent", "Awaiting reply", "Won", "Lost"], l?.status || "New enquiry")}</div><div class="form-grid">${field("Next follow-up", "due", l?.due || S.today, "date")}${select(
      "Follow-up cadence",
      "interval_days",
      [
        ["2", "Every 2 days"],
        ["4", "Every 4 days"],
      ],
      String(l?.interval_days || 2),
    )}</div>${select(
      "Preferred channel",
      "channel",
      [
        ["whatsapp", "WhatsApp"],
        ["email", "Gmail"],
      ],
      l?.channel || "email",
    )}<label class="field">Context and notes<textarea name="notes">${esc(c.notes || "")}</textarea></label><label class="checkbox-field"><input type="checkbox" name="email_consent" ${c.email_consent ? "checked" : ""}>Client consent recorded for email follow-ups/reminders</label><label class="checkbox-field"><input type="checkbox" name="whatsapp_consent" ${c.whatsapp_consent ? "checked" : ""}>Client consent recorded for WhatsApp follow-ups/reminders</label><label class="field">Consent source / evidence<input name="consent_note" placeholder="When and how consent was recorded"></label><label class="checkbox-field"><input type="checkbox" name="opted_out" ${c.opted_out ? "checked" : ""}>Client opted out — block outgoing messages</label><p class="hint">Use notes for enquiry context. Contact names do not change when a follow-up moves to another month.</p>${formEnd()}`,
  );
}
function contactForm(id) {
  const c = contact(id);
  dialog(
    "Client contact details",
    `<form id="contact-form" data-id="${id}"><div class="modal-body">${field("Full name", "name", c.name)}${field("Email", "email", c.email || "", "email", false)}${field("Phone · E.164 format", "phone", c.phone || "", "tel", false)}<label class="field">Context and notes<textarea name="notes">${esc(c.notes)}</textarea></label><label class="checkbox-field"><input type="checkbox" name="email_consent" ${c.email_consent ? "checked" : ""}>Email follow-up/reminder consent recorded</label><label class="checkbox-field"><input type="checkbox" name="whatsapp_consent" ${c.whatsapp_consent ? "checked" : ""}>WhatsApp follow-up/reminder consent recorded</label>${field("Consent source / evidence", "consent_note", "", "text", false)}<label class="checkbox-field"><input type="checkbox" name="opted_out" ${c.opted_out ? "checked" : ""}>Client opted out</label>${formEnd()}`,
  );
}
function policyForm(id) {
  if (!S.contacts.length) {
    toast("Add a client before adding a policy.");
    return;
  }
  const p = S.policies.find((p) => p.id === id);
  dialog(
    p ? "Update policy dates" : "Add a policy",
    `<form id="policy-form" data-id="${p?.id || ""}"><div class="modal-body">${select(
      "Client",
      "contact_id",
      S.contacts.map((c) => [c.id, c.name]),
      p?.contact_id || S.contacts[0].id,
    )}${field("Policy number", "number", p?.number || "")}${field("Insurer", "insurer", p?.insurer || "")}${field("Insurance type", "insurance_type", p?.insurance_type || "Super Visa")}<div class="form-grid">${field("Effective date", "effective", p?.effective || S.today, "date")}${field("Expiry date", "expiry", p?.expiry || "", "date")}</div>${select("Status", "status", ["Active", "Cancelled", "Expired"], p?.status || "Active")}<p class="hint">Saving confirms these dates were reviewed. It does not update the insurer’s records.</p>${formEnd()}`,
  );
}
function taskForm(id, contactId, channelValue) {
  if (!S.contacts.length) {
    toast("Add a client first.");
    return;
  }
  const r = S.requests.find((r) => r.id === id);
  dialog(
    r ? "Review client change request" : "Create a task",
    `<form id="task-form" data-id="${r?.id || ""}"><div class="modal-body">${
      r
        ? `<p><b>${esc(contact(r.contact_id).name)}</b> · ${channel(r.channel)}</p><div class="bubble full-width">${esc(r.detail)}</div>${select("Task status", "status", ["Open", "In progress", "Completed"], r.status)}<label class="field">Internal review note<textarea name="note">${esc(r.note)}</textarea></label>`
        : `${select(
            "Client",
            "contact_id",
            S.contacts.map((c) => [c.id, c.name]),
            contactId || S.contacts[0].id,
          )}${select(
            "Channel",
            "channel",
            [
              ["email", "Gmail"],
              ["whatsapp", "WhatsApp"],
            ],
            channelValue || "email",
          )}${field("Request type", "kind", "Conversation follow-up")}<label class="field">Details<textarea name="detail" required></textarea></label>`
    }<p class="hint">Complete this task only after reviewing the insurer’s response. No automatic policy amendment is made.</p>${formEnd()}`,
  );
}
let composeContext = null;
function compose(contactId, c, purpose = "reply", ref) {
  const client = contact(contactId);
  if (!client) return;
  const l = purpose === "followup" ? S.leads.find((l) => l.id === ref) : null,
    p = purpose === "reminder" ? S.policies.find((p) => p.id === ref.id) : null;
  let text = `Hi ${first(client)}, `;
  if (l)
    text += `I wanted to check in about your ${l.insurance_type} enquiry. ${client.notes ? "Following our last conversation, I’m happy to clarify the options. " : ""}Have you had a chance to review them?`;
  else if (p)
    text += `a friendly reminder that your ${p.insurance_type} policy with ${p.insurer} ${ref.event === "expiry" ? "expires" : "starts"} on ${date(p[ref.event])}. ${ref.event === "expiry" ? "Would you like to review renewal options?" : "Please let me know if your travel plans have changed."}`;
  composeContext = {
    contactId,
    purpose,
    leadId: l?.id,
    policyId: p?.id,
    event: ref?.event,
    reminderJobId: p
      ? S.jobs.find(
          (j) =>
            j.type === "reminder" &&
            j.status === "draft" &&
            j.payload.policyId === p.id &&
            j.payload.event === ref.event &&
            j.payload.date === p[ref.event],
        )?.id
      : undefined,
    key: crypto.randomUUID(),
  };
  dialog(
    purpose === "reminder"
      ? "Review policy reminder"
      : purpose === "followup"
        ? "A thoughtful follow-up"
        : "Compose a reply",
    `<form id="send-form"><div class="modal-body"><p><b>To:</b> ${esc(client.name)}</p><p class="body-copy"><b>Client context:</b> ${esc(client.notes || "No notes recorded. Personalize the message before sending.")}</p>${select(
      "Channel",
      "channel",
      [
        ["email", "Gmail"],
        ["whatsapp", "WhatsApp"],
      ],
      c,
    )}${field("Email subject", "subject", p ? "Your policy date reminder" : l ? "Following up on your insurance" : "Your insurance enquiry")}<div id="template-options"></div><label class="field" id="text-field">Message<textarea name="text" required>${esc(text)}</textarea></label><div id="send-guide" class="send-note"></div><div id="handoff-action"></div>${formEnd(S.mode === "mock" ? "Confirm simulated send" : "Confirm API send")}`,
  );
  updateTemplateOptions();
}
function handoffLink(url) {
  dialog(
    "Continue in your WhatsApp app",
    `<div class="modal-body"><p class="body-copy">The draft is prepared. Open WhatsApp and press Send yourself. No automatic send or delivery receipt is recorded.</p><a class="button primary" target="_blank" rel="noopener noreferrer" href="${esc(url)}">Open draft in WhatsApp</a><p class="hint">After sending, return to this conversation and choose ‘I sent this in WhatsApp’ to update your follow-up date.</p></div><div class="modal-foot">${b("Back to workspace", "close")}</div>`,
  );
}
function updateTemplateOptions() {
  const f = $("#send-form"),
    c = f.elements.channel.value,
    client = contact(composeContext.contactId),
    t = S.threads.find((t) => t.contact_id === client.id && t.channel === c),
    recent =
      t?.last_inbound && Date.now() - new Date(t.last_inbound) < 86400000;
  $("#template-options").innerHTML =
    c === "whatsapp"
      ? select(
          "WhatsApp message format",
          "template",
          [
            ["", "Free-form message"],
            ...S.integrations.whatsapp.templates.map((t) => [
              t.name + "|" + t.language,
              t.name + " · " + t.language,
            ]),
          ],
          "",
        ) + '<div id="template-parameters"></div>'
      : "";
  $("#handoff-action").innerHTML =
    c === "whatsapp"
      ? b("Prepare for my WhatsApp app", "handoff") +
        '<p class="hint">Manual alternative: keep using your current phone app. No API connection is needed.</p>'
      : "";
  $("#send-guide").textContent =
    (S.mode === "mock" ? "Simulated send. " : "Real outbound send. ") +
    (c === "whatsapp" && !recent
      ? "No recent WhatsApp reply: select an approved configured template, or use Gmail. "
      : "Review the recipient, content, and recorded consent before sending. ") +
    (composeContext.purpose === "followup"
      ? "After provider acceptance, the next follow-up moves by this client’s 2- or 4-day cadence."
      : "");
}
function updateTemplatePreview() {
  const f = $("#send-form"),
    value = f.elements.template?.value;
  if (!value) return;
  const [name, language] = value.split("|"),
    spec = S.integrations.whatsapp.templates.find(
      (t) => t.name === name && t.language === language,
    );
  if (!spec) return;
  f.elements.text.value = spec.body.replace(
    /\{\{(\d+)\}\}/g,
    (_, n) =>
      f.elements["param" + (Number(n) - 1)]?.value ||
      `[${spec.parameters[Number(n) - 1]}]`,
  );
}
function importForm() {
  dialog(
    "Import policy dates",
    `<form id="import-form"><div class="modal-body"><p class="body-copy">Create clients first. Match each CSV row by the client’s email. Existing policy numbers are rejected; use Edit to update them.</p><label class="field">CSV file<input type="file" id="csv-file" accept=".csv,text/csv"></label><label class="field">CSV contents<textarea name="csv" required placeholder="email,number,insurer,insurance_type,effective,expiry,status&#10;client@example.com,ABC123,Insurer,Super Visa,2026-11-01,2027-11-01,Active"></textarea></label><div id="import-preview"></div><p class="hint">Maximum 1,000 rows. Preview and correct all errors before confirming.</p>${formEnd("Preview import")}`,
  );
}
function simulateForm() {
  dialog(
    "Simulate incoming message",
    `<form id="simulate-form"><div class="modal-body">${field("Client name", "name", "Sample Client")}${select(
      "Channel",
      "channel",
      [
        ["email", "Gmail"],
        ["whatsapp", "WhatsApp"],
      ],
      "email",
    )}${field("Email address or E.164 phone", "address", "client@example.com")}<label class="field">Message<textarea name="text" required>I have moved. Can you update my mailing address?</textarea></label><p class="hint">Mock mode only. A matching client is reused; otherwise a new contact is created. Change-request detection creates a task.</p>${formEnd("Simulate incoming")}`,
  );
}
async function mutate(url, method, body, message) {
  await api(url, method, body);
  close();
  await refresh();
  toast(message);
}
document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-page]");
  if (nav) {
    page = nav.dataset.page;
    location.hash = page;
    render();
    return;
  }
  if (e.target.closest("#mobile-menu")) {
    $(".sidebar").classList.toggle("open");
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action,
    id = el.dataset.id;
  try {
    if (a === "close") close();
    if (a === "handoff") {
      const f = $("#send-form");
      if (!f.reportValidity()) return;
      const r = await api("/whatsapp/handoff", "POST", {
        ...composeContext,
        channel: "whatsapp",
        text: f.elements.text.value.trim(),
        subject: f.elements.subject.value,
      });
      await refresh();
      handoffLink(r.url);
    }
    if (a === "reopen-handoff") {
      const m = S.messages.find((m) => m.id === id),
        t = S.threads.find((t) => t.id === m.thread_id),
        c = contact(t.contact_id);
      handoffLink(
        "https://wa.me/" +
          c.phone.slice(1) +
          "?text=" +
          encodeURIComponent(m.text),
      );
    }
    if (a === "confirm-manual") {
      if (
        confirm(
          "Confirm you actually sent this message in WhatsApp? This records your confirmation, not a provider delivery receipt.",
        )
      ) {
        await api("/messages/" + id + "/confirm-manual", "POST", {});
        await refresh();
        toast("Manual send recorded.");
      }
    }
    if (a === "refresh") await refresh();
    if (a === "logout") {
      await api("/logout", "POST", {});
      S = null;
      login();
    }
    if (a === "lead") leadForm(id);
    if (a === "contact") contactForm(id);
    if (a === "policy") policyForm(id);
    if (a === "task") taskForm(id, el.dataset.contact, el.dataset.channel);
    if (a === "followup") {
      const l = S.leads.find((l) => l.id === id);
      compose(l.contact_id, l.channel, "followup", id);
    }
    if (a === "reply") compose(el.dataset.contact, el.dataset.channel);
    if (a === "reminder") {
      const p = S.policies.find((p) => p.id === id);
      compose(p.contact_id, "email", "reminder", {
        id,
        event: el.dataset.event,
      });
    }
    if (a === "inbox-filter") {
      channelFilter = el.dataset.channel;
      render();
    }
    if (a === "thread") {
      threadId = id;
      render();
    }
    if (a === "clear-filters") {
      search = "";
      month = "";
      leadStatus = "all";
      render();
    }
    if (a === "simulate") simulateForm();
    if (a === "import") importForm();
    if (a === "connect-gmail") {
      const r = await api("/integrations/gmail/connect", "POST", {});
      location.assign(r.url);
    }
    if (a === "disconnect-gmail") {
      if (
        confirm(
          "Disconnect Gmail and revoke access where possible? Pending Gmail sends will be blocked.",
        )
      ) {
        const r = await api("/integrations/gmail/disconnect", "POST", {});
        await refresh();
        toast(r.action || "Gmail disconnected.");
      }
    }
    if (a === "sync-gmail") {
      await api("/integrations/gmail/sync", "POST", {});
      await refresh();
      toast("Gmail sync finished.");
    }
    if (a === "test-whatsapp") {
      const r = await api("/integrations/whatsapp/test", "POST", {});
      toast("WhatsApp API accessible: " + r.display_phone_number);
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  e.preventDefault();
  const d = new FormData(f),
    v = (n) => String(d.get(n) || "").trim();
  const submit =
    f.querySelector('button[type="submit"]') ||
    f.querySelector("button:last-child");
  if (submit) submit.disabled = true;
  try {
    if (f.id === "login-form") {
      const r = await api("/login", "POST", {
        email: v("email"),
        password: String(d.get("password") || ""),
        code: v("code"),
      });
      csrf = r.csrf;
      await refresh();
    }
    if (f.id === "lead-form") {
      const body = {
        contact: {
          name: v("name"),
          email: v("email"),
          phone: v("phone"),
          notes: v("notes"),
          email_consent: d.has("email_consent"),
          whatsapp_consent: d.has("whatsapp_consent"),
          opted_out: d.has("opted_out"),
          consent_note: v("consent_note"),
        },
        insurance_type: v("insurance_type"),
        status: v("status"),
        due: v("due"),
        interval_days: Number(v("interval_days")),
        channel: v("channel"),
      };
      await mutate(
        "/leads" + (f.dataset.id ? "/" + f.dataset.id : ""),
        f.dataset.id ? "PUT" : "POST",
        body,
        "Client saved.",
      );
    }
    if (f.id === "contact-form") {
      await mutate(
        "/contacts/" + f.dataset.id,
        "PUT",
        {
          name: v("name"),
          email: v("email"),
          phone: v("phone"),
          notes: v("notes"),
          email_consent: d.has("email_consent"),
          whatsapp_consent: d.has("whatsapp_consent"),
          opted_out: d.has("opted_out"),
          consent_note: v("consent_note"),
        },
        "Contact details saved.",
      );
    }
    if (f.id === "policy-form") {
      const body = Object.fromEntries(
        [
          "contact_id",
          "number",
          "insurer",
          "insurance_type",
          "effective",
          "expiry",
          "status",
        ].map((k) => [k, v(k)]),
      );
      await mutate(
        "/policies" + (f.dataset.id ? "/" + f.dataset.id : ""),
        f.dataset.id ? "PUT" : "POST",
        body,
        "Policy dates saved and verified.",
      );
    }
    if (f.id === "task-form") {
      const edit = Boolean(f.dataset.id),
        body = edit
          ? { status: v("status"), note: v("note") }
          : Object.fromEntries(
              ["contact_id", "channel", "kind", "detail"].map((k) => [k, v(k)]),
            );
      await mutate(
        "/requests" + (edit ? "/" + f.dataset.id : ""),
        edit ? "PATCH" : "POST",
        body,
        "Task saved. Insurer records unchanged.",
      );
    }
    if (f.id === "send-form") {
      let template;
      if (v("template")) {
        const [name, language] = v("template").split("|");
        const spec = S.integrations.whatsapp.templates.find(
          (t) => t.name === name && t.language === language,
        );
        template = {
          name,
          language,
          parameters: spec.parameters.map((_, i) => v("param" + i)),
        };
        updateTemplatePreview();
      }
      await mutate(
        "/messages",
        "POST",
        {
          ...composeContext,
          channel: v("channel"),
          subject: v("subject"),
          text: f.elements.text.value.trim(),
          ...(template ? { template } : {}),
        },
        S.mode === "mock"
          ? "Message queued for simulation."
          : "Message queued. Track its outcome in the inbox.",
      );
    }
    if (f.id === "settings-form") {
      await api("/settings", "PATCH", {
        autoAck: d.has("autoAck"),
        reminders: d.has("reminders"),
      });
      await refresh();
      toast("Automation settings saved.");
    }
    if (f.id === "simulate-form")
      await mutate(
        "/simulate",
        "POST",
        {
          name: v("name"),
          channel: v("channel"),
          address: v("address"),
          text: v("text"),
        },
        "Incoming message simulated. Check the inbox and tasks.",
      );
    if (f.id === "import-form") {
      const csv = v("csv"),
        confirmed = f.dataset.preview === csv;
      const result = await api("/policies/import", "POST", {
        csv,
        confirm: confirmed,
      });
      if (confirmed) {
        close();
        await refresh();
        toast(result.imported + " policies imported.");
      } else {
        $("#import-preview").innerHTML =
          `<div class="csv-preview"><b>${result.items.length} valid policies · ${result.errors.length} errors</b>${result.errors.map((e) => `<p class="form-error">Row ${e.row}: ${esc(e.error)}</p>`).join("")}${result.items.map((p) => `<div>${esc(p.number)} · ${esc(p.insurer)} · ${date(p.effective)} – ${date(p.expiry)}</div>`).join("")}</div>`;
        if (!result.errors.length) {
          f.dataset.preview = csv;
          submit.textContent = "Confirm import";
        } else {
          delete f.dataset.preview;
          submit.textContent = "Preview import";
        }
      }
    }
  } catch (error) {
    const err = $("#login-error") || $("#form-error");
    if (err) err.textContent = error.message;
    else toast(error.message);
  } finally {
    if (submit?.isConnected) submit.disabled = false;
  }
});
document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.id === "month") {
    month = el.value;
    render();
  }
  if (el.id === "lead-status") {
    leadStatus = el.value;
    render();
  }
  if (el.id === "request-status") {
    requestStatus = el.value;
    render();
  }
  if (el.name === "channel" && $("#send-form")) updateTemplateOptions();
  if (el.name === "template") {
    const value = el.value,
      box = $("#template-parameters");
    if (value) {
      const [name, language] = value.split("|"),
        spec = S.integrations.whatsapp.templates.find(
          (t) => t.name === name && t.language === language,
        );
      box.innerHTML = spec.parameters
        .map((p, i) => field(p, "param" + i, ""))
        .join("");
      $("#send-form").elements.text.readOnly = true;
      updateTemplatePreview();
    } else {
      box.innerHTML = "";
      $("#send-form").elements.text.readOnly = false;
    }
  }
  if (el.id === "csv-file" && el.files[0]) {
    if (el.files[0].size > 800000) {
      toast("CSV must be smaller than 800 KB.");
      return;
    }
    $("#import-form").elements.csv.value = await el.files[0].text();
    delete $("#import-form").dataset.preview;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    const start = e.target.selectionStart;
    search = e.target.value;
    render();
    $("#search").focus();
    $("#search").setSelectionRange(start, start);
  }
  if (e.target.name?.startsWith("param")) updateTemplatePreview();
  if (e.target.name === "csv" && $("#import-form")) {
    delete $("#import-form").dataset.preview;
    $('#import-form button[type="submit"]').textContent = "Preview import";
  }
});
window.addEventListener("hashchange", () => {
  page = location.hash.slice(1) || "dashboard";
  render();
});
(async () => {
  try {
    const user = await api("/session");
    csrf = user.csrf;
    await refresh();
  } catch {
    login();
  }
})();
setInterval(async () => {
  if (
    !S ||
    $("#dialog").open ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
  )
    return;
  try {
    await refresh();
  } catch (e) {
    if (S) toast(e.message);
  }
}, 10000);
