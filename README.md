# MapleDesk · Interactive design prototype

A clickable subscription workspace for Canadian insurance brokers. All clients, policies, conversations, acknowledgements, and billing are simulated. No messages are sent and no insurer accounts are accessed.

## Try it

For a **single-file demo**, open [`mockups/MapleDesk-Interactive.html`](mockups/MapleDesk-Interactive.html) on GitHub and choose **Download raw file**. Open the downloaded HTML in a browser. It includes all app code, styles, and sample data; no network connection is needed. Direct local-file opening may be restricted by managed browser policies; in that case use the local server below.

Or download this branch with **Code → Download ZIP**, unzip it, and open `index.html` in your browser. No installation or accounts are required. Keep `app.js` and `styles.css` beside `index.html`.

Alternatively, with Node.js 18 or newer:

```sh
npm start
```

Open the server on port 3000. There are no runtime npm dependencies or build step; Playwright is a development-only test dependency. Optional Google Fonts improve typography; system fonts work offline. Use a local server if your browser restricts storage for local files.

## Click through the workflows

- **Dashboard:** choose a client, switch between WhatsApp and email drafts, edit the message, and confirm a mock send. The next follow-up moves forward by the lead’s 2- or 4-day cadence.
- **Leads & follow-ups:** search or filter leads; add a lead, edit notes and contact details, schedule a date (including another month), or close a lead as won/lost. Closed leads stop appearing in the follow-up queue.
- **Unified inbox:** switch between WhatsApp and email, read conversation history, and send simulated replies. Use **Simulate incoming** for a general enquiry or a DOB, address, phone, or policy date change.
- **Change requests:** incoming change requests create tasks and, when enabled, a personalized acknowledgement on the same channel. Review the request, add internal notes, and update its status. This never changes an insurer’s policy.
- **Policies & reminders:** review 30-day and 7-day reminders for effective/expiry dates, edit the text, choose WhatsApp or email, and send to the mock inbox.
- **Integrations & settings:** toggle mock channel connections and acknowledgement/reminder workflows. Disconnecting a channel blocks simulated sends and incoming messages on that channel.
- **Subscription:** switch illustrative CAD plans without checkout or payment. Plan choices do not enforce feature limits in this design prototype.
- **Activity:** inspect a record of actions taken in the demo.

Changes persist in this browser’s local storage. The top-bar reset button restores sample data. The demo date is fixed at **October 20, 2026** so reminders remain predictable. Use sample information only: this prototype has no authentication or production data security. There is no background scheduler; actions run when clicked.

## Original visual concepts

The PNG, PDF, and standalone HTML image concept are in [`mockups/`](mockups/).

## Development checks

Run `npm run check` for JavaScript syntax checks and `npm run export` to refresh the self-contained HTML after changes.

For browser workflow checks, run `npm ci`, then `npx playwright install chromium` if Chromium is not installed, then `npm test`. Tests start a separate server on port 3100 and use a fresh browser profile. You can set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium binary. Tests cover follow-ups, lead updates, both messaging channels, acknowledgements, task completion, reminders, disconnected-channel blocking, persistence, reset, responsive navigation, and the single-file export.
