# Account setup without unnecessary early spending

The application can be tested locally before creating AWS resources or buying a domain. This is the recommended first validation step. Use synthetic clients and an agreed test mailbox/recipient first.

## 1. Local application

Use Node.js 24 and the setup instructions in README.md. It creates an empty local database, owner login, and encryption key. Initially use mock delivery, simulate incoming requests, add a client, and import a small policy CSV. No AWS or Meta account is required for these tests.

## 2. Google Cloud project for Gmail

The client already has a Google account because he uses Gmail. Create a client-controlled project through [Google Cloud Console](https://console.cloud.google.com/), enable Gmail API, configure the OAuth consent screen, and create an OAuth **web application** client.

For a local test, register exactly `http://localhost:3000/api/integrations/gmail/callback` and keep PUBLIC_URL=http://localhost:3000. For deployment, register the actual HTTPS domain callback separately. Redirect URLs must match the environment exactly.

Put GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GMAIL_ADDRESS into the local private `.env`. Keep the DATA_KEY generated at setup. Restart the app and connect Gmail through Connections & settings; only the configured mailbox can connect. The account owner completes Google consent in the browser. Do not give anyone the Gmail password.

To test actual mailbox synchronization, set MESSAGING_MODE=live and keep ALLOW_LIVE_SENDS=false. It can read/sync but outgoing API sends remain disabled. Review the first recent-message import before enabling anything automatic. The acknowledgement setting is disabled by default.

Before a real supervised send, explicitly enable ALLOW_LIVE_SENDS=true, record the test recipient's consent, and confirm that the intended mailbox/recipient is selected. Gmail scopes can require verification or assessments depending on publication/use. Testing-mode token expiry and verification costs must be resolved before long-term client operation. Do not assume a test-user setup is a permanent production exception.

The initial import includes at most 20 recent inbox/sent messages from seven days. Replies sent from Gmail itself are synchronized for single-recipient messages. Multi-recipient outbound conversations remain in Gmail for manual review. External Gmail sends do not automatically infer a sales outcome or alter lead dates.

## 3. Existing WhatsApp Business phone app

Use the manual handoff first if cost and uninterrupted phone use are the priority. Add the client's E.164 phone number and recorded WhatsApp consent. Compose a draft, choose **Prepare for my WhatsApp app**, open the link on the device with WhatsApp, and send there. Return to the CRM and explicitly confirm sending to update the follow-up date. No Meta API account is necessary for that handoff. It is not automatic sending, history sync or a provider delivery receipt.

For automatic WhatsApp and incoming-message synchronization, separately establish Meta business ownership, API access and the number's eligibility for supported phone-app coexistence. The business phone app is not itself the API connection. If a BSP/partner is required, obtain a fee quote and validate its adapter/event contract. Do not migrate or disconnect the client's current number until a concrete plan has been reviewed.

Official references to check against current onboarding requirements:

- [WhatsApp Cloud API documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [WhatsApp Embedded Signup documentation](https://developers.facebook.com/docs/whatsapp/embedded-signup/)
- [Gmail API authentication scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

No code in this repository proves the current number qualifies for coexistence.

## 4. AWS and domain after local validation

Create a client-owned [AWS account](https://aws.amazon.com/) with MFA and billing alerts. Free-tier or trial credits depend on eligibility; do not assume a zero bill. Use a short-lived operator identity rather than root access keys. Create/choose a domain only when the broker is ready for the hosted pilot.

The infrastructure files target Canada Central. Review `terraform plan` and current prices before applying anything. Estimated infrastructure allowance is CAD 40–100/month plus a domain and external service fees, not a provider quote. The example budget alert is not a spending cap.

After the account is available, establish secure operator access, deploy the reviewed configuration, configure HTTPS, connect providers, and validate encrypted backups and recovery. The repository contains code and instructions; it does not claim those steps have already happened.

## What to share and where

Availability information, an intended public domain and a mailbox provider can be discussed in chat. Enter AWS authentication, Google client secrets, Meta tokens, encryption keys, passwords and authenticator seeds only through the appropriate secure account/host configuration. Never paste them into chat, GitHub commits, issues, or screenshots.
