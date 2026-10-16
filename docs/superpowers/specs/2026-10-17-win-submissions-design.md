# Win Submissions ("Ring the Bell") — Design Spec

**Date:** 2026-10-17 (revised same day: fully standalone)
**Owner:** Aged Life Leads (support@agedlifeleads.com)
**Repo:** `Deicide12/AgedLifeLeads-Hub` (first feature of the Hub)

> **Revision:** The Hub must not affect any existing site. It runs on its **own Vercel project and its own Supabase project**, with no reads or writes to the CRM (`fhxajizqumguubgitrlf`). Consequences: no automatic agent/lead matching and no automatic resale retirement. Wins go public instantly; the owner pulls sold clients from resale in the CRM manually, tracked with a `resale_retired` flag. A one-way sync into the CRM is a possible later, separate task.

---

## Goal

Agents who buy our leads log closed deals on one public page. Each win:

1. **Rings the bell** in a read-only Discord `#wins` channel and on the page (confetti).
2. **Ranks them** on a monthly AP leaderboard + live wins feed.
3. **Flags the client for resale removal** — the owner retires them in the CRM by hand.
4. **Collects lead-quality data** — wins and AP per lead type.

Inspired by a competitor's "Submit a Sale" page (resale-protection hook, private client fields, Monthly/Annual toggle, bell).

## Users

- **Agent** (lead buyer). No login; identifies by email (not verified).
- **Owner.** Works in the Hub's Supabase table editor: hides fake wins, ticks `resale_retired`.

## Page layout (single page, mobile-first)

```
Submit a Sale 🔔
"Log your sale. It hits the leaderboard, rings the bell, and we'll pull
 your client from resale."
[ form ]
[ Leaderboard — this month, by AP ]
[ Recent wins feed ]
```

Visual style matches agedlifeleads.com (navy/red tokens).

## Form fields

| Field | Required | Notes |
|---|---|---|
| Your email | yes | Groups the agent's wins on the leaderboard |
| Your name | yes | Display name ("Mike R.") |
| Your phone | no | |
| Client name | yes | *Private* |
| Client phone | one of phone/email | *Private.* Used by owner to find the lead in the CRM |
| Client email | one of phone/email | *Private* |
| Lead type | yes | Dropdown, list below |
| Carrier | no | |
| Premium | yes | **Monthly / Annual** toggle; monthly × 12 → AP. $1–$100,000 AP |
| Testimonial | no | ≤ 500 chars |
| Show my name publicly | default on | Off → "An agent" |
| Hidden honeypot | — | Must be empty |

**Lead types:** Final Expense · Semi-Fresh Final Expense · IUL · Mortgage Protection · Veteran Protection · OTP-Verified Final Expense (FEX) · OTP-Verified Indexed Universal Life (IUL) · OTP-Verified Mortgage Protection (MTG) · OTP-Verified Veteran Protection (VET) · OTP-Verified Semi-Fresh Veteran Protection

Submit: **Ring the Bell 🔔** → confetti + "🔔 Bell rung! Your win is on the board — we'll pull your client from resale."

## Architecture

Static page + two Vercel serverless functions in a **new Vercel project**, talking to a **new Supabase project** over PostgREST with that project's service-role key (server-side only). Zero npm dependencies.

```
index.html           form + leaderboard + feed (vanilla JS)
api/submit-win.mjs   POST — validate, save, ring Discord
api/wins.mjs         GET  — leaderboard + feed (public-safe fields), cached 30s
lib/win.mjs          pure, browser-safe helpers (shared with the page)
lib/supabase.mjs     rpc(name, args)
supabase/migrations/20261017000000_wins.sql
supabase/tests/wins_test.sql
test/*.test.mjs      node --test
```

Env vars (Hub Vercel project): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (both from the **Hub** Supabase project), `DISCORD_WEBHOOK_URL` (optional).

## Submit flow (`POST /api/submit-win`)

1. Validate (`lib/win.mjs`): required fields, email formats, client phone/email, lead type in list, AP range, length caps, honeypot. Fail → 400 with field errors.
2. `submit_win(p)` RPC: rate limit (≥ 5 wins per submitter email in 10 min → `{error:"rate_limited"}` → 429), else insert with `status='public'`.
3. Discord (if `DISCORD_WEBHOOK_URL`): `🔔 Mike R. just closed a Final Expense deal — $1,200 AP!` with `allowed_mentions: { parse: [] }`, 3s timeout. Failure is logged and ignored.
4. Respond `200 { status: "public" }`.

## Data model (Hub Supabase project)

`wins`: `id, created_at, status ('public'|'hidden'), resale_retired (bool, default false), submitter_email, submitter_name, submitter_phone, client_name, client_phone, client_email, lead_type, carrier, annual_premium_cents (100–10,000,000), premium_mode ('monthly'|'annual'), testimonial, show_name`.
RLS enabled, no policies (service role only). Functions `submit_win(jsonb)` and `wins_board()` are `security definer`, executable by `service_role` only.

**Owner workflow (Supabase table editor → `wins`):**
- Resale to-do: filter `resale_retired = false` → retire the client in the CRM → tick `resale_retired`.
- Fake win: set `status = 'hidden'` (disappears from leaderboard/feed within ~30s).

## Read flow (`GET /api/wins`)

- **leaderboard:** current calendar month (America/New_York), `status='public'`, grouped by `lower(submitter_email)`, `sum(AP)` + count, top 10.
- **feed:** latest 20 public wins: display name, lead type, AP, relative time.
- Only whitelisted fields leave the API (`toPublicBoard`); never client data, submitter email/phone, or testimonial.
- `Cache-Control: s-maxage=30, stale-while-revalidate=60`. Page refreshes after submit and every 60s.

## Error handling

| Case | Behavior |
|---|---|
| Validation error | 400, inline field messages |
| Rate limited | 429, "Too many submissions — try again in a few minutes." |
| Discord down / unset | Ignored; win saved |
| DB error | 500 "Couldn't save — please try again." (single-statement insert; nothing partial) |
| Board load error | 502; page shows "Couldn't load the leaderboard." |

## Testing

- `node --test test/win.test.mjs test/api.test.mjs` — validation, phone normalization, AP math, display names, bell text, public-field whitelist, handler status codes, Discord behavior.
- `supabase/tests/wins_test.sql` — insert/normalize, board contents, hidden wins, private-field leak check, rate limit; rolls itself back.
- Deployed E2E: submit a throwaway `example.com` win, confirm it on the board and in the table, delete it.

## Deployment

- New Supabase project "Aged Life Leads Hub" (needs a free slot: the owner's account is at the free-tier 2-project limit — options: a separate Supabase account, or upgrading the org).
- New Vercel project linked to `Deicide12/AgedLifeLeads-Hub`; suggested domain `hub.agedlifeleads.com`.
- Commits authored as `Deicide12 <Deicide12@users.noreply.github.com>`.

## Out of scope (YAGNI)

- Any read/write to the CRM or existing sites (sync is a separate future task)
- Agent login, admin dashboard, photo uploads
- Showing testimonials on agedlifeleads.com
- Review-engine trigger on win
