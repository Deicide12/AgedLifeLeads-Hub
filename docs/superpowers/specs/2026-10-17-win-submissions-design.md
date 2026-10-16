# Win Submissions ("Ring the Bell") — Design Spec

**Date:** 2026-10-17
**Owner:** Aged Life Leads (support@agedlifeleads.com)
**Repo:** `Deicide12/AgedLifeLeads-Hub` (first feature of the Hub)

---

## Goal

Agents who buy our leads log closed deals on one public page. Each win:

1. **Protects the agent's lead** — the client is retired from resale (the agent's selfish reason to submit).
2. **Ranks them** on a monthly AP leaderboard + live wins feed (hype).
3. **Rings the bell** in a read-only Discord `#wins` channel (hype, social proof).
4. **Feeds lead-quality data** — wins and AP per lead type / order, for ROI proof.

Inspired by a competitor's "Submit a Sale" page; we copy the resale-protection hook, private client fields, Monthly/Annual toggle, and bell.

## Users

- **Agent** (lead buyer). No login. Already has a CRM profile (`public.profiles`) keyed by email.
- **Owner/admin.** Reviews data in Supabase; approves unmatched wins.

## Page layout (single page, mobile-first)

```
Submit a Sale
"Log your sale — it hits the leaderboard, rings the bell, and we pull
 your client from resale."

[ form ]
[ Leaderboard — this month, by AP ]
[ Recent wins feed ]
```

Visual style matches agedlifeleads.com (navy/red tokens), not the competitor's green.

## Form fields

| Field | Required | Notes |
|---|---|---|
| Your email | yes | Matched to `profiles.email` (case-insensitive) |
| Your name | yes | Used for display name ("Mike R.") |
| Your phone | no | Stored on the win only |
| Client name | yes | *Private — never shown publicly* |
| Client phone | one of phone/email | *Private.* Used to find the exact lead |
| Client email | one of phone/email | *Private.* Used to find the exact lead |
| Lead type | yes | Dropdown, see list below |
| Carrier | no | Free text, e.g. "Mutual of Omaha" |
| Premium | yes | Toggle **Monthly / Annual**; monthly × 12 → stored as annual (AP). $1–$100,000 AP |
| Testimonial | no | ≤ 500 chars, about the leads |
| Show my name publicly | default on | Off → "An agent" on leaderboard/feed/Discord |
| Hidden honeypot | — | Must be empty |

**Lead type dropdown** (matches `orders.lead_type` values in use today):
Final Expense · Semi-Fresh Final Expense · IUL · Mortgage Protection · Veteran Protection · OTP-Verified Final Expense (FEX) · OTP-Verified Indexed Universal Life (IUL) · OTP-Verified Mortgage Protection (MTG) · OTP-Verified Veteran Protection (VET) · OTP-Verified Semi-Fresh Veteran Protection

Submit button: **Ring the Bell 🔔** → confetti + "Logged! Your client is protected from resale." (or "Logged — we'll review it shortly." when unmatched).

## Architecture

Static page + two Vercel serverless functions in the Hub repo, writing to the existing Supabase project `fhxajizqumguubgitrlf` with the service-role key (server-side only).

```
index.html (form + leaderboard + feed, vanilla JS)
api/submit-win.mjs   POST — validate, match, retire lead, insert win, ping Discord
api/wins.mjs         GET  — leaderboard + feed (public-safe fields only), cached 30s
lib/win.mjs          pure helpers: validate(), normalizePhone(), displayName(), toAnnual()
test/win.test.mjs    node --test checks for lib/win.mjs
```

Env vars (Vercel): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DISCORD_WEBHOOK_URL` (optional).
No Supabase key ever reaches the browser.

## Submit flow (`POST /api/submit-win`)

1. **Validate** with `lib/win.mjs`: required fields, email format, one of client phone/email, lead type in list, AP range, lengths capped, honeypot empty. Fail → 400 with field errors.
2. **Rate limit (stateless):** reject if the same submitter email has ≥ 5 wins in the last 10 minutes → 429.
3. **Match agent:** `profiles` where `lower(email) = lower(input)`. Not found → `agent_id = null`, `status = 'pending'`.
4. **Match lead** (only if agent matched): among that agent's `agent_leads`, find a row whose normalized phone (last 10 digits) equals the client phone, or whose `lower(email)` equals the client email. Most recent `delivered_at` wins.
   - Found → set `agent_leads.disposition = 'sold'`, `disposition_updated_at = now()`.
   - Retire from resale: `lead_inventory.active = false` for the inventory row linked via `lead_sales.agent_lead_id`; if no `lead_sales` link, match `lead_inventory` by normalized phone/email. The allocator (`allocate_and_stage`) only selects `where li.active`, so this stops resale.
5. **Insert** into `wins` (below). `status = 'public'` when the agent matched; `'pending'` otherwise.
6. **Discord** (only when `status = 'public'` and `DISCORD_WEBHOOK_URL` set): post
   `🔔 Mike R. (TX) just closed a Final Expense deal — $1,200 AP!`
   (the `(TX)` part is omitted when no lead matched, since state is unknown)
   with `allowed_mentions: { parse: [] }` so user text can't ping anyone. Discord failure is logged and ignored — the win is already saved.
7. Respond `200 { status, protected: <lead retired?> }`.

Steps 4–5 run in one Postgres function `submit_win(...)` (`security definer`, callable only by service role) so the lead update, inventory retirement, and insert commit atomically.

## Data model (new, in existing Supabase project)

```sql
create table public.wins (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  status           text not null default 'pending'
                   check (status in ('pending','public','rejected')),
  agent_id         uuid references public.profiles(id),
  agent_lead_id    uuid references public.agent_leads(id),
  inventory_id     uuid references public.lead_inventory(id),
  submitter_email  text not null,
  submitter_name   text not null,
  submitter_phone  text,
  client_name      text not null,
  client_phone     text,
  client_email     text,
  lead_type        text not null,          -- as selected by agent
  matched_lead_type text,                  -- from agent_leads when matched (trusted)
  state            text,                   -- from matched lead, if any
  carrier          text,
  annual_premium_cents integer not null check (annual_premium_cents between 100 and 10000000),
  premium_mode     text not null check (premium_mode in ('monthly','annual')),
  testimonial      text,
  show_name        boolean not null default true
);
alter table public.wins enable row level security;  -- no policies: service role only
create index on public.wins (status, created_at desc);
create index on public.wins (lower(submitter_email), created_at desc);
```

Admin approves a pending win by setting `status = 'public'` in the Supabase table editor (admin UI is out of scope).

## Read flow (`GET /api/wins`)

Returns only public-safe fields from `status = 'public'` wins:

- **leaderboard:** current calendar month (America/New_York), grouped by `coalesce(agent_id::text, lower(submitter_email))` (so admin-approved unmatched wins still group per person), `sum(AP)` and count, top 10. Agents with `show_name = false` appear as "An agent".
- **feed:** latest 20 wins: display name, state, lead type, AP, relative time.

Never returns client name/phone/email, submitter email/phone, or testimonial.
Response header `Cache-Control: s-maxage=30, stale-while-revalidate=60`. The page refreshes the feed after a successful submit and every 60s.

**Display name:** first name + last initial from `submitter_name` ("Mike Ross" → "Mike R."); `show_name = false` → "An agent".

## Discord setup (owner, one-time)

1. Create channel `#wins`.
2. Channel → Edit → Permissions → `@everyone`: **deny Send Messages**, allow View Channel + Add Reactions.
3. Channel → Integrations → Webhooks → New Webhook → copy URL → set `DISCORD_WEBHOOK_URL` in Vercel.

Webhooks post regardless of the Send Messages deny.

## Error handling

| Case | Behavior |
|---|---|
| Validation error | 400, inline field messages, form keeps values |
| Rate limited | 429, "Too many submissions — try again in a few minutes" |
| Unknown email | Saved as `pending`, success message says it's under review |
| Client not found in agent's leads | Win still saved/public; `protected: false`; message omits resale line |
| Discord down / unset | Ignored; win saved |
| Supabase error | 500, "Couldn't save — please try again"; nothing partially written (atomic function) |

## Testing

- `test/win.test.mjs` (`node --test`): `validate()` happy path + each rejection, `normalizePhone()` (10/11-digit, formatted input), `toAnnual()` monthly×12, `displayName()` edge cases (single name, consent off).
- Manual end-to-end on a Vercel preview: submit with a throwaway `example.com` email (→ pending, no Discord), then with a real test profile + a known staged lead (→ public, lead `sold`, inventory inactive, Discord post). Delete test rows afterward.

## Deployment

- New Vercel project linked to `Deicide12/AgedLifeLeads-Hub`; suggested domain `hub.agedlifeleads.com`.
- Hobby author gate: commits authored as `Deicide12 <Deicide12@users.noreply.github.com>`.
- Migration (`wins` table + `submit_win` function) applied via Supabase migration.

## Out of scope (YAGNI)

- Agent login / personal win history
- Admin dashboard (use Supabase table editor)
- Photo uploads
- Showing testimonials on agedlifeleads.com (data is collected; display is a later task)
- Review-engine trigger on win (possible follow-up — a win is the "deal closed" signal that spec lacked)
- Name typeahead (competitor's) — email match replaces it
