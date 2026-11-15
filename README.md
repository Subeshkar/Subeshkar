# Dioma Cloud

The customer version of Dioma. People sign up at **app.dioma.life** with their email, connect their own Google account, and use Dioma: brief, Ask, to-do, files. The AI behind it is Claude (Anthropic API); customers only see "Dioma".

It is a **separate service with its own database**. It does not read or change the owner's live Dioma (branch `dioma-live`).

No npm dependencies — Node 22.13+ only (built-in `node:sqlite`, `fetch`).

## Run locally (test mode)

```
npm run dev        # http://localhost:8080 — sign-in code is filled in, AI answers with a stand-in
```

## Deploy on Railway (needs owner approval: these cost money)

1. New service from this repo, branch `dioma-cloud`. Start command: `npm start`.
2. Add a **volume** mounted at `/data`.
3. Variables (the owner pastes the secret values — never commit them):

| Variable | What |
|---|---|
| `APP_SECRET` | 40+ random characters. Encrypts Google tokens. Never change it after launch. |
| `DATA_DIR` | `/data` |
| `PUBLIC_URL` | `https://app.dioma.life` |
| `ANTHROPIC_API_KEY` | From console.anthropic.com. Without it, Dioma runs in test mode. |
| `DIOMA_MODEL` | optional, default `claude-sonnet-5-5` |
| `AI_DAILY_CAP` | optional, asks per user per day (default 30) |
| `MAX_USERS` | optional, early-access seats (default 100); later sign-ups join a waitlist |
| `RESEND_API_KEY` | From resend.com, with `dioma.life` verified as a sending domain |
| `MAIL_FROM` | optional, default `Dioma <noreply@dioma.life>` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client (Web). Redirect URI: `https://app.dioma.life/auth/google/callback` |

4. Custom domain `app.dioma.life` → CNAME to the Railway domain.

## Google OAuth notes

Scopes: `openid email gmail.readonly calendar.readonly`. Until Google verifies the app, it works only for up to 100 test users you add in the OAuth consent screen. `gmail.readonly` is a restricted scope: public launch needs Google's verification and a yearly security assessment. Privacy policy: `/privacy`, terms: `/terms`.

## API (all JSON, state-changing calls need header `x-dioma: 1`)

`POST /api/auth/start {email}` · `POST /api/auth/verify {email, code}` · `POST /api/auth/logout`
`GET|POST|DELETE /api/me` · `GET /api/home` · `GET|POST|DELETE /api/chat`
`GET|POST /api/todos` · `PATCH|DELETE /api/todos/:id`
`GET|POST /api/files` · `GET|PATCH|DELETE /api/files/:id` · `GET /auth/google` · `DELETE /api/google`
