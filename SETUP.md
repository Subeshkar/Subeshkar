# Dioma Live — setup guide

This puts the real Dioma online: you message it on WhatsApp, it reads your Gmail and Google Calendar, and it sends you **Approve / Cancel / Always allow** buttons before it sends an email or adds an event. A 7:00 am brief arrives every morning, and a password-protected dashboard shows everything it did.

Plan about 1–2 hours the first time. Do the steps in order; each step gives you values to paste in step 6.

---

## 1. GitHub — store the code (10 min)

1. Sign up or log in at **github.com**.
2. Click **+ → New repository**. Name it `dioma-live`, set it to **Private**, click **Create repository**.
3. On the empty repo page, click **uploading an existing file**.
4. Unzip `dioma-live.zip` on your computer and drag **everything inside the folder** (the `src` folder, `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `SETUP.md`, `README.md`) into the page. Click **Commit changes**.

## 2. Anthropic — the brain (5 min)

1. Go to **console.anthropic.com**, sign in, add a payment method under **Billing** (a demo costs a few dollars).
2. **API keys → Create key**. Copy it → this is `ANTHROPIC_API_KEY`.

## 3. Railway — put it on the internet (10 min)

1. Go to **railway.com**, sign in with GitHub.
2. **New Project → Deploy from GitHub repo → dioma-live**. It starts building.
3. Open the service → **Settings → Networking → Generate Domain**. Copy the address, e.g. `https://dioma-live-production.up.railway.app` → this is `BASE_URL` (no slash at the end).
4. Right-click the empty area of the project canvas → **Volume** (or **+ Create → Volume**), attach it to the service, mount path **`/data`**. This keeps the database when the app restarts.

Leave Railway open; you'll paste variables in step 6.

## 4. Meta — real WhatsApp (30 min)

1. Go to **developers.facebook.com**, log in with Facebook, click **My Apps → Create App**.
2. Choose **Other → Business** (or the "Connect with customers through WhatsApp" use case). Name it `Dioma`. Connect or create a **Meta Business portfolio** when asked.
3. In the app, add the **WhatsApp** product → **API Setup**.
4. From the API Setup page copy:
   - **Phone number ID** → `WA_PHONE_NUMBER_ID`
   - **Temporary access token** → `WA_TOKEN` (lasts 24 hours; permanent token in step 4.8)
5. Under **To**, click **Manage phone number list** and add **your own mobile number**. Enter the code WhatsApp sends you. The free test number can only talk to up to 5 numbers you add here, so add any investor you'll demo to.
6. Go to **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `BASE_URL/webhook` (e.g. `https://dioma-live-production.up.railway.app/webhook`)
   - Verify token: invent one, e.g. `dioma-verify-123` → `WA_VERIFY_TOKEN`
   - Click **Verify and save** (do this after step 6 below, once Railway has the variables; it fails if the app isn't running yet).
   - Under **Webhook fields**, click **Subscribe** next to **messages**.
7. **App settings → Basic → App secret → Show**. Copy → `WA_APP_SECRET`.
8. **Permanent token** (so it doesn't stop after 24 hours): go to **business.facebook.com → Settings → Users → System users → Add** (Admin). Click **Assign assets** → your app → full control. Then **Generate new token** → select your app → tick `whatsapp_business_messaging` and `whatsapp_business_management` → copy it and replace `WA_TOKEN`.

**Important:** don't register your personal +971 number with the API. A number on the WhatsApp Business API stops working in the normal WhatsApp app. Use the free test number for demos, and later a new SIM just for Dioma.

## 5. Google — Gmail and Calendar (20 min)

1. Go to **console.cloud.google.com**, create a project called `Dioma`.
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (may be called **Google Auth Platform → Branding/Audience**):
   - User type **External**, app name `Dioma`, your email as support and developer contact.
   - Under **Audience / Test users**, add **your Gmail address** (and any demo users). Leave it in **Testing** mode.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**
   - Authorized redirect URI: `BASE_URL/auth/google/callback`
   - Create → copy **Client ID** → `GOOGLE_CLIENT_ID`, **Client secret** → `GOOGLE_CLIENT_SECRET`.

When you connect, Google shows "Google hasn't verified this app". That's normal in testing mode: click **Continue**.

## 6. Paste the settings into Railway (5 min)

In Railway open the service → **Variables → Raw Editor** and paste this, filled in:

```
BASE_URL=https://your-app.up.railway.app
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=any-long-random-text-40-characters-or-more
DATA_DIR=/data
ALLOWED_NUMBERS=971XXXXXXXXX
DEFAULT_TIMEZONE=Asia/Dubai
DEFAULT_BRIEF_TIME=07:00
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-5-5
WA_TOKEN=EAAG...
WA_PHONE_NUMBER_ID=...
WA_VERIFY_TOKEN=dioma-verify-123
WA_APP_SECRET=...
WA_API_VERSION=v23.0
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

- `ALLOWED_NUMBERS`: your number with country code, no `+` or spaces (e.g. `971501234567`). Add more separated by commas. Only these numbers can use Dioma, which protects your API bill.
- `WA_API_VERSION`: use the version shown in Meta's API Setup code sample if it's newer.

Click **Deploy**. Now go back and finish step 4.6 (**Verify and save**).

## 7. Try it

Open WhatsApp on your phone and message the Meta test number:

1. `hi` → Dioma introduces itself.
2. `my name is Subesh` → it remembers.
3. `connect Google` → tap the link, sign in, allow. WhatsApp confirms "Google connected".
4. `what's on my calendar tomorrow?`
5. `summarise my unread emails`
6. `reply to the latest email from <name> and say I'll send it Monday` → you get **Approve / Cancel / Always allow** buttons. Tap **Approve** → the email is really sent.
7. `book 2 hours to study tomorrow at 4pm` → buttons → **Approve** → it's on your Google Calendar.
8. `remind me in 5 minutes to call my mum` → reminder arrives on WhatsApp.
9. Open `BASE_URL/dashboard` (any username, your `ADMIN_PASSWORD`) → see users, approvals, permissions and the activity log. Click **Send brief now** to demo the morning brief.

## The 24-hour rule (morning brief and reminders)

WhatsApp only lets a business send free messages within **24 hours of the user's last message**. If you message Dioma every day, briefs and reminders just work. To send them outside that window:

1. In **WhatsApp Manager → Message templates → Create template**: category **Utility**, name `dioma_update`, language English, body: `Dioma update: {{1}}`. Submit and wait for approval.
2. Add to Railway variables: `WA_TEMPLATE_NAME=dioma_update` and `WA_TEMPLATE_LANG=en`.

Template messages have a small per-message fee from Meta.

## Going beyond the demo

| To do this | You need |
| --- | --- |
| Use your own Dioma number (not the test number) | Add a new number in WhatsApp Manager, verify your Meta business |
| Open WhatsApp to the public | Meta business verification and a display name review |
| Let anyone connect Gmail | Google app verification; the Gmail read scope also needs a security assessment (weeks, paid) |
| Facebook and Instagram posting | Meta app review for `pages_manage_posts` / Instagram publishing |

## If something doesn't work

| Problem | Fix |
| --- | --- |
| Meta "Verify and save" fails | Railway must be deployed with `WA_VERIFY_TOKEN` set; URL must end in `/webhook` |
| No reply on WhatsApp | Check Railway **Deployments → Logs**. Token expired? Use the permanent token. Number in `ALLOWED_NUMBERS`? Subscribed to **messages**? |
| "WhatsApp API 401" in logs | `WA_TOKEN` is wrong or expired |
| Google says redirect_uri_mismatch | Redirect URI in Google must be exactly `BASE_URL/auth/google/callback` |
| Google "access blocked" | Add your Gmail as a test user (step 5.3) |
| Everything forgotten after a deploy | The Volume isn't mounted at `/data`, or `DATA_DIR` isn't `/data` |

## Personal WhatsApp (QR link, unofficial)

1. Railway → service → **Variables**: add `MCP_TOKEN` (any random text, 24+ characters). Keep `DATA_DIR=/data`.
2. Railway → service → **Volumes**: add a volume mounted at `/data`, so the WhatsApp link survives redeploys.
3. Open `https://<your-domain>/personal`, log in with the admin password, tap **Show QR code**.
4. Phone: WhatsApp → Settings → Linked devices → Link a device → scan.
5. Copy the connector link shown on that page into claude.ai → Settings → Connectors → Add custom connector (name: **Dioma WhatsApp**).

This uses the WhatsApp Web protocol, which WhatsApp's terms do not allow. WhatsApp may block the number.
