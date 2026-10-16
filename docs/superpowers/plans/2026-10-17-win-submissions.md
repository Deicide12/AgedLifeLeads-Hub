# Win Submissions ("Ring the Bell") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, no-login page where agents log closed deals; each win retires the client from resale, ranks the agent on a monthly AP leaderboard, and rings a read-only Discord channel.

**Architecture:** Static `index.html` + two Vercel Node serverless functions (`api/submit-win.mjs`, `api/wins.mjs`) calling two `security definer` Postgres functions (`submit_win`, `wins_board`) in the existing Supabase project over REST with the service-role key. Pure validation/formatting lives in `lib/win.mjs`, shared by the API and the page.

**Tech Stack:** Vanilla HTML/CSS/JS (ES modules), Node 24 (`node:test`), Vercel serverless (`export default handler(req, res)`), Supabase Postgres (PL/pgSQL) via PostgREST RPC. Zero npm dependencies (matches the main site's `api/*.mjs` style).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-17-win-submissions-design.md`.
- Supabase project ref: `fhxajizqumguubgitrlf`. Changes are additive only (new table + 2 functions).
- Service-role key is server-side only (`process.env.SUPABASE_SERVICE_ROLE_KEY`); nothing secret in `lib/` (Vercel serves it statically).
- Public responses never include client name/phone/email, submitter email/phone, or testimonial.
- AP bounds: 100–10,000,000 cents ($1–$100,000). Monthly × 12.
- Rate limit: 5 wins per submitter email per 10 minutes.
- Leaderboard: current calendar month in `America/New_York`, top 10 by AP; feed: latest 20.
- Discord posts use `allowed_mentions: { parse: [] }`; failure never fails the submit.
- Commits authored as `Deicide12 <Deicide12@users.noreply.github.com>` (Vercel Hobby author gate), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Older delivered leads have no `lead_sales` link (0 rows) — inventory retirement must also match by the lead's phone/email.

## File Structure

```
.gitignore                 node_modules, .vercel, .env*
.vercelignore              keep docs/test/supabase out of the deployment
lib/win.mjs                pure helpers (browser-safe): LEAD_TYPES, validate, normalizePhone,
                           toAnnualCents, displayName, formatAP, bellMessage, toPublicBoard
lib/supabase.mjs           rpc(name, args) — PostgREST call with service-role key
api/submit-win.mjs         POST handler
api/wins.mjs               GET handler
index.html                 form + leaderboard + feed
supabase/migrations/20261017000000_wins.sql   wins table, submit_win, wins_board
supabase/tests/wins_test.sql                  self-rolling-back DO-block test
test/win.test.mjs          lib/win.mjs tests
test/api.test.mjs          handler tests with stubbed fetch
.claude/launch.json        local static preview
```

---

### Task 1: Pure helpers (`lib/win.mjs`)

**Files:**
- Create: `.gitignore`, `.vercelignore`, `lib/win.mjs`
- Test: `test/win.test.mjs`

**Interfaces:**
- Produces:
  - `LEAD_TYPES: string[]` (10 items)
  - `normalizePhone(raw: any): string | null` — last-10-digit US phone or null
  - `toAnnualCents(amount: any, mode: "monthly"|"annual"): number` (NaN if not numeric)
  - `displayName(name: string, showName: boolean): string` — "Mike R." / "An agent"
  - `formatAP(cents: number): string` — "$1,200"
  - `bellMessage({ name, showName, state, leadType, apCents }): string`
  - `validate(body): { ok: true, value: Win } | { ok: false, errors: Record<string,string> }` where `Win = { submitter_email, submitter_name, submitter_phone|null, client_name, client_phone|null, client_email|null, lead_type, carrier|null, premium_mode, annual_premium_cents, testimonial|null, show_name }`
  - `toPublicBoard(raw): { leaderboard: {name, ap_cents, wins}[], feed: {name, state, lead_type, ap_cents, created_at}[] }`

- [ ] **Step 1: Write ignore files**

`.gitignore`:
```
node_modules
.vercel
.env*
```

`.vercelignore`:
```
docs
test
supabase
.claude
```

- [ ] **Step 2: Write the failing test** — `test/win.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, normalizePhone, toAnnualCents, displayName, bellMessage, toPublicBoard } from "../lib/win.mjs";

const good = {
  submitter_email: " Mike@Example.com ",
  submitter_name: "Mike Ross",
  client_name: "Jane Doe",
  client_phone: "(555) 123-4567",
  lead_type: "Final Expense",
  premium: "100",
  premium_mode: "monthly",
  show_name: true,
};

test("validate: happy path normalizes values", () => {
  const r = validate(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.submitter_email, "mike@example.com");
  assert.equal(r.value.client_phone, "5551234567");
  assert.equal(r.value.annual_premium_cents, 120000);
  assert.equal(r.value.premium_mode, "monthly");
  assert.equal(r.value.client_email, null);
  assert.equal(r.value.submitter_phone, null);
  assert.equal(r.value.show_name, true);
});

test("validate: rejects each bad field", () => {
  const cases = [
    [{ submitter_email: "nope" }, "submitter_email"],
    [{ submitter_name: " " }, "submitter_name"],
    [{ client_name: "" }, "client_name"],
    [{ client_phone: "123" }, "client_phone"],
    [{ client_phone: "", client_email: "" }, "client_phone"],
    [{ client_phone: "", client_email: "bad@" }, "client_email"],
    [{ lead_type: "Health" }, "lead_type"],
    [{ premium: "0" }, "premium"],
    [{ premium: "abc" }, "premium"],
    [{ premium: "9000", premium_mode: "monthly" }, "premium"], // $108k AP > cap
  ];
  for (const [patch, field] of cases) {
    const r = validate({ ...good, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors[field], `${field} for ${JSON.stringify(patch)}`);
  }
});

test("validate: honeypot and non-object bodies are rejected", () => {
  assert.equal(validate({ ...good, website: "http://spam" }).ok, false);
  assert.equal(validate(null).ok, false);
});

test("validate: client email alone is enough", () => {
  const r = validate({ ...good, client_phone: "", client_email: "JANE@x.com" });
  assert.equal(r.ok, true);
  assert.equal(r.value.client_email, "jane@x.com");
  assert.equal(r.value.client_phone, null);
});

test("validate: show_name defaults on, only false turns it off", () => {
  const { show_name, ...rest } = good;
  assert.equal(validate(rest).value.show_name, true);
  assert.equal(validate({ ...good, show_name: false }).value.show_name, false);
});

test("normalizePhone", () => {
  assert.equal(normalizePhone("555-123-4567"), "5551234567");
  assert.equal(normalizePhone("+1 (555) 123-4567"), "5551234567");
  assert.equal(normalizePhone("15551234567"), "5551234567");
  assert.equal(normalizePhone("25551234567"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(undefined), null);
});

test("toAnnualCents", () => {
  assert.equal(toAnnualCents("1200", "annual"), 120000);
  assert.equal(toAnnualCents("49.99", "monthly"), 59988);
  assert.ok(Number.isNaN(toAnnualCents("x", "annual")));
});

test("displayName", () => {
  assert.equal(displayName("Mike Ross", true), "Mike R.");
  assert.equal(displayName("  mary ann smith ", true), "mary S.");
  assert.equal(displayName("Cher", true), "Cher");
  assert.equal(displayName("Mike Ross", false), "An agent");
  assert.equal(displayName("", true), "An agent");
});

test("bellMessage", () => {
  assert.equal(
    bellMessage({ name: "Mike Ross", showName: true, state: "TX", leadType: "Final Expense", apCents: 120000 }),
    "🔔 Mike R. (TX) just closed a Final Expense deal — $1,200 AP!"
  );
  assert.equal(
    bellMessage({ name: "Mike Ross", showName: false, state: null, leadType: "IUL", apCents: 99950 }),
    "🔔 An agent just closed an IUL deal — $1,000 AP!"
  );
});

test("toPublicBoard keeps only safe fields", () => {
  const out = toPublicBoard({
    leaderboard: [{ name: "Mike Ross", show_name: true, ap_cents: "240000", wins: 2, submitter_email: "x@y.com" }],
    feed: [{ name: "Jane Roe", show_name: false, state: "", lead_type: "IUL", ap_cents: 5000, created_at: "2026-10-17T00:00:00Z", client_phone: "5551234567" }],
  });
  assert.deepEqual(out, {
    leaderboard: [{ name: "Mike R.", ap_cents: 240000, wins: 2 }],
    feed: [{ name: "An agent", state: null, lead_type: "IUL", ap_cents: 5000, created_at: "2026-10-17T00:00:00Z" }],
  });
  assert.deepEqual(toPublicBoard(null), { leaderboard: [], feed: [] });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/win.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/win.mjs'`

- [ ] **Step 4: Write implementation** — `lib/win.mjs`

```js
// Pure helpers shared by the API and index.html. Keep browser-safe: no Node APIs, no secrets.

export const LEAD_TYPES = [
  "Final Expense",
  "Semi-Fresh Final Expense",
  "IUL",
  "Mortgage Protection",
  "Veteran Protection",
  "OTP-Verified Final Expense (FEX)",
  "OTP-Verified Indexed Universal Life (IUL)",
  "OTP-Verified Mortgage Protection (MTG)",
  "OTP-Verified Veteran Protection (VET)",
  "OTP-Verified Semi-Fresh Veteran Protection",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_AP_CENTS = 100;
const MAX_AP_CENTS = 10_000_000;

const str = (v, max) => String(v ?? "").trim().slice(0, max);

export function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return d.length === 10 ? d : null;
}

export function toAnnualCents(amount, mode) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * (mode === "monthly" ? 12 : 1) * 100);
}

export function displayName(name, showName) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!showName || !parts.length) return "An agent";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`;
}

export function formatAP(cents) {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

export function bellMessage({ name, showName, state, leadType, apCents }) {
  const where = state ? ` (${state})` : "";
  const article = /^[aeiou]/i.test(leadType) ? "an" : "a";
  return `🔔 ${displayName(name, showName)}${where} just closed ${article} ${leadType} deal — ${formatAP(apCents)} AP!`;
}

export function validate(body) {
  const b = body && typeof body === "object" ? body : null;
  if (!b || str(b.website, 200)) return { ok: false, errors: { form: "Submission rejected." } };

  const mode = b.premium_mode === "monthly" ? "monthly" : "annual";
  const rawClientPhone = str(b.client_phone, 30);
  const value = {
    submitter_email: str(b.submitter_email, 200).toLowerCase(),
    submitter_name: str(b.submitter_name, 100),
    submitter_phone: str(b.submitter_phone, 30) || null,
    client_name: str(b.client_name, 100),
    client_phone: rawClientPhone ? normalizePhone(rawClientPhone) : null,
    client_email: str(b.client_email, 200).toLowerCase() || null,
    lead_type: str(b.lead_type, 100),
    carrier: str(b.carrier, 100) || null,
    premium_mode: mode,
    annual_premium_cents: toAnnualCents(b.premium, mode),
    testimonial: str(b.testimonial, 500) || null,
    show_name: b.show_name !== false,
  };

  const errors = {};
  if (!EMAIL.test(value.submitter_email)) errors.submitter_email = "Enter a valid email.";
  if (!value.submitter_name) errors.submitter_name = "Enter your name.";
  if (!value.client_name) errors.client_name = "Enter the client's name.";
  if (rawClientPhone && !value.client_phone) errors.client_phone = "Enter a 10-digit phone number.";
  if (!rawClientPhone && !value.client_email) errors.client_phone = "Enter the client's phone or email.";
  if (value.client_email && !EMAIL.test(value.client_email)) errors.client_email = "Enter a valid email.";
  if (!LEAD_TYPES.includes(value.lead_type)) errors.lead_type = "Pick a lead type.";
  const ap = value.annual_premium_cents;
  if (!(ap >= MIN_AP_CENTS && ap <= MAX_AP_CENTS)) errors.premium = "Annual premium must be $1–$100,000.";

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

// Whitelists public-safe fields from the wins_board() RPC result.
export function toPublicBoard(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    leaderboard: (r.leaderboard ?? []).map((x) => ({
      name: displayName(x.name, x.show_name),
      ap_cents: Number(x.ap_cents),
      wins: Number(x.wins),
    })),
    feed: (r.feed ?? []).map((x) => ({
      name: displayName(x.name, x.show_name),
      state: x.state || null,
      lead_type: x.lead_type,
      ap_cents: Number(x.ap_cents),
      created_at: x.created_at,
    })),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/win.test.mjs`
Expected: all tests pass, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add .gitignore .vercelignore lib/win.mjs test/win.test.mjs
git -c user.name=Deicide12 -c user.email=Deicide12@users.noreply.github.com commit -m "feat: win validation and formatting helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database (`wins` table, `submit_win`, `wins_board`)

**Files:**
- Create: `supabase/migrations/20261017000000_wins.sql`
- Test: `supabase/tests/wins_test.sql`

**Interfaces:**
- Consumes: `Win` object shape from Task 1 (`validate().value`) as the `p jsonb` argument.
- Produces (PostgREST RPC, service_role only):
  - `POST /rest/v1/rpc/submit_win` body `{ "p": Win }` → `{ id, status: "public"|"pending", protected: boolean, state: string|null, matched_lead_type: string|null }` or `{ error: "rate_limited" }`
  - `POST /rest/v1/rpc/wins_board` body `{}` → `{ leaderboard: [{ name, show_name, ap_cents, wins }], feed: [{ name, show_name, state, lead_type, ap_cents, created_at }] }` (raw names; API applies `displayName`)

- [ ] **Step 1: Write the test** — `supabase/tests/wins_test.sql`

```sql
-- Self-contained test for submit_win / wins_board. Run in Supabase SQL (MCP execute_sql or SQL editor).
-- Everything rolls back: success ends by raising 'WINS TESTS PASSED', which aborts the transaction.
-- Failure surfaces as an ASSERT error with the failing message.
do $$
declare
  v_lead  record;
  v_email text;
  r       jsonb;
  b       jsonb;
  i       int;
begin
  select al.id, al.agent_id, al.lead_type, right(regexp_replace(al.phone, '\D', '', 'g'), 10) as phone
    into v_lead
  from public.agent_leads al
  where length(regexp_replace(al.phone, '\D', '', 'g')) >= 10
    and exists (select 1 from public.lead_inventory li
                where right(regexp_replace(li.phone, '\D', '', 'g'), 10) = right(regexp_replace(al.phone, '\D', '', 'g'), 10))
  limit 1;
  assert v_lead.id is not null, 'no agent lead with matching inventory to test against';
  select email into v_email from public.profiles where id = v_lead.agent_id;

  -- 1. Matched agent + lead -> public, lead sold, inventory retired
  r := public.submit_win(jsonb_build_object(
    'submitter_email', upper(v_email), 'submitter_name', 'Test Agent', 'client_name', 'Test Client',
    'client_phone', v_lead.phone, 'lead_type', 'Final Expense',
    'annual_premium_cents', 120000, 'premium_mode', 'annual', 'show_name', true));
  assert r->>'status' = 'public', 'matched win should be public: ' || r::text;
  assert (r->>'protected')::boolean, 'lead should be retired: ' || r::text;
  assert r->>'matched_lead_type' = v_lead.lead_type, 'matched_lead_type wrong: ' || r::text;
  assert (select disposition from public.agent_leads where id = v_lead.id) = 'sold', 'lead not marked sold';
  assert not exists (select 1 from public.lead_inventory li
                     where li.active and right(regexp_replace(li.phone, '\D', '', 'g'), 10) = v_lead.phone),
    'inventory still active';

  -- 2. Unknown email -> pending, nothing retired
  r := public.submit_win(jsonb_build_object(
    'submitter_email', 'nobody-' || gen_random_uuid() || '@example.com', 'submitter_name', 'Nobody Here',
    'client_name', 'X', 'client_email', 'x@example.com', 'lead_type', 'IUL',
    'annual_premium_cents', 5000, 'premium_mode', 'monthly', 'show_name', false));
  assert r->>'status' = 'pending', 'unknown email should be pending: ' || r::text;
  assert not (r->>'protected')::boolean, 'unknown email must not retire leads';

  -- 3. Board lists public wins only and no private fields
  b := public.wins_board();
  assert jsonb_path_exists(b, '$.feed[*] ? (@.name == "Test Agent")'), 'public win missing from feed';
  assert jsonb_path_exists(b, '$.leaderboard[*] ? (@.name == "Test Agent")'), 'public win missing from leaderboard';
  assert not jsonb_path_exists(b, '$.feed[*] ? (@.name == "Nobody Here")'), 'pending win leaked into feed';
  assert b::text not ilike '%client%' and b::text not ilike '%@%', 'private fields leaked: ' || b::text;

  -- 4. Rate limit: 5 per email per 10 minutes (1 used in step 1)
  for i in 1..4 loop
    r := public.submit_win(jsonb_build_object(
      'submitter_email', v_email, 'submitter_name', 'Test Agent', 'client_name', 'Y',
      'client_email', 'y-' || i || '@example.com', 'lead_type', 'IUL',
      'annual_premium_cents', 100, 'premium_mode', 'annual'));
    assert r ? 'status', 'call ' || i || ' should succeed: ' || r::text;
  end loop;
  r := public.submit_win(jsonb_build_object(
    'submitter_email', v_email, 'submitter_name', 'Test Agent', 'client_name', 'Y',
    'client_email', 'y@example.com', 'lead_type', 'IUL', 'annual_premium_cents', 100, 'premium_mode', 'annual'));
  assert r->>'error' = 'rate_limited', 'sixth call should be rate limited: ' || r::text;

  raise exception 'WINS TESTS PASSED';
end $$;
```

- [ ] **Step 2: Run test to verify it fails**

Run the file contents via Supabase MCP `execute_sql` (project `fhxajizqumguubgitrlf`).
Expected: ERROR `function public.submit_win(jsonb) does not exist`

- [ ] **Step 3: Write the migration** — `supabase/migrations/20261017000000_wins.sql`

```sql
-- Win submissions ("Ring the Bell"). Written only by the Hub API via the service-role key.

create table public.wins (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  status               text not null default 'pending'
                       check (status in ('pending', 'public', 'rejected')),
  agent_id             uuid references public.profiles(id),
  agent_lead_id        uuid references public.agent_leads(id),
  inventory_id         uuid references public.lead_inventory(id),
  submitter_email      text not null,
  submitter_name       text not null,
  submitter_phone      text,
  client_name          text not null,
  client_phone         text,
  client_email         text,
  lead_type            text not null,
  matched_lead_type    text,
  state                text,
  carrier              text,
  annual_premium_cents integer not null check (annual_premium_cents between 100 and 10000000),
  premium_mode         text not null check (premium_mode in ('monthly', 'annual')),
  testimonial          text,
  show_name            boolean not null default true
);
alter table public.wins enable row level security; -- no policies: service role only
create index wins_status_created_idx on public.wins (status, created_at desc);
create index wins_submitter_created_idx on public.wins (lower(submitter_email), created_at desc);

create or replace function public.submit_win(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email  text := lower(p->>'submitter_email');
  v_phone  text := nullif(p->>'client_phone', '');
  v_cemail text := nullif(lower(p->>'client_email'), '');
  v_agent  uuid;
  v_lead   public.agent_leads%rowtype;
  v_lphone text;
  v_lemail text;
  v_inv    uuid;
  v_status text;
  v_id     uuid;
begin
  -- Stateless rate limit: 5 wins per submitter email per 10 minutes.
  if (select count(*) from public.wins
      where lower(submitter_email) = v_email
        and created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select id into v_agent from public.profiles where lower(email) = v_email limit 1;

  if v_agent is not null then
    select * into v_lead from public.agent_leads al
    where al.agent_id = v_agent
      and ((v_phone is not null and right(regexp_replace(al.phone, '\D', '', 'g'), 10) = v_phone)
        or (v_cemail is not null and lower(al.email) = v_cemail))
    order by al.delivered_at desc nulls last, al.created_at desc
    limit 1;

    if v_lead.id is not null then
      update public.agent_leads
      set disposition = 'sold', disposition_updated_at = now()
      where id = v_lead.id;

      -- Retire every inventory copy of this client: the linked sale (newer orders) plus
      -- matches on the lead's own phone/email (older orders have no lead_sales link).
      v_lphone := right(regexp_replace(v_lead.phone, '\D', '', 'g'), 10);
      if length(v_lphone) <> 10 then v_lphone := null; end if;
      v_lemail := nullif(lower(v_lead.email), '');

      -- ponytail: seq scan over lead_inventory (~75k rows); add an expression index on the normalized phone if it gets slow.
      with retired as (
        update public.lead_inventory li
        set active = false
        where li.id in (select s.inventory_id from public.lead_sales s where s.agent_lead_id = v_lead.id)
           or (v_lphone is not null and right(regexp_replace(li.phone, '\D', '', 'g'), 10) = v_lphone)
           or (v_lemail is not null and lower(li.email) = v_lemail)
        returning li.id
      )
      select id into v_inv from retired limit 1;
    end if;
  end if;

  v_status := case when v_agent is not null then 'public' else 'pending' end;

  insert into public.wins (
    status, agent_id, agent_lead_id, inventory_id,
    submitter_email, submitter_name, submitter_phone,
    client_name, client_phone, client_email,
    lead_type, matched_lead_type, state, carrier,
    annual_premium_cents, premium_mode, testimonial, show_name)
  values (
    v_status, v_agent, v_lead.id, v_inv,
    v_email, p->>'submitter_name', nullif(p->>'submitter_phone', ''),
    p->>'client_name', v_phone, v_cemail,
    p->>'lead_type', nullif(v_lead.lead_type, ''), nullif(v_lead.state, ''), nullif(p->>'carrier', ''),
    (p->>'annual_premium_cents')::int, p->>'premium_mode', nullif(p->>'testimonial', ''),
    coalesce((p->>'show_name')::boolean, true))
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'status', v_status,
    'protected', v_inv is not null,
    'state', nullif(v_lead.state, ''),
    'matched_lead_type', nullif(v_lead.lead_type, ''));
end;
$$;

create or replace function public.wins_board()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'leaderboard', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.ap_cents desc)
      from (
        select (array_agg(submitter_name order by created_at desc))[1] as name,
               (array_agg(show_name order by created_at desc))[1]      as show_name,
               sum(annual_premium_cents)::bigint                         as ap_cents,
               count(*)::int                                             as wins
        from public.wins
        where status = 'public'
          and created_at >= (date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York')
        group by coalesce(agent_id::text, lower(submitter_email))
        order by ap_cents desc
        limit 10
      ) b), '[]'::jsonb),
    'feed', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at desc)
      from (
        select submitter_name                         as name,
               show_name,
               state,
               coalesce(matched_lead_type, lead_type) as lead_type,
               annual_premium_cents                   as ap_cents,
               created_at
        from public.wins
        where status = 'public'
        order by created_at desc
        limit 20
      ) f), '[]'::jsonb));
$$;

revoke all on function public.submit_win(jsonb) from public, anon, authenticated;
revoke all on function public.wins_board() from public, anon, authenticated;
grant execute on function public.submit_win(jsonb) to service_role;
grant execute on function public.wins_board() to service_role;
```

- [ ] **Step 4: Apply migration**

Supabase MCP `apply_migration` with `name: "wins"` and the file contents.
Expected: success.

- [ ] **Step 5: Run test to verify it passes**

Run `supabase/tests/wins_test.sql` via `execute_sql`.
Expected: ERROR `P0001: WINS TESTS PASSED` (and nothing persisted: `select count(*) from wins` → 0).

- [ ] **Step 6: Check advisors**

Supabase MCP `get_advisors` (security). Expected: no new warnings about `wins` / `submit_win` / `wins_board` beyond "RLS enabled, no policy" on `wins` (intentional).

- [ ] **Step 7: Commit**

```bash
git add supabase
git -c user.name=Deicide12 -c user.email=Deicide12@users.noreply.github.com commit -m "feat: wins table, submit_win and wins_board functions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: API handlers

**Files:**
- Create: `lib/supabase.mjs`, `api/submit-win.mjs`, `api/wins.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `validate`, `bellMessage`, `toPublicBoard` (Task 1); RPCs `submit_win`, `wins_board` (Task 2).
- Produces:
  - `rpc(name: string, args?: object): Promise<any>` — throws on non-2xx
  - `POST /api/submit-win` JSON body = form fields (`submitter_email, submitter_name, submitter_phone, client_name, client_phone, client_email, lead_type, carrier, premium, premium_mode, testimonial, show_name, website`) → `200 {status, protected}` | `400 {errors}` | `429 {error}` | `500 {error}` | `503 {error}`
  - `GET /api/wins` → `200 {leaderboard, feed}` (shape of `toPublicBoard`) | `502 {error}`

- [ ] **Step 1: Write the failing test** — `test/api.test.mjs`

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import submitWin from "../api/submit-win.mjs";
import wins from "../api/wins.mjs";

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
}

let calls;
function stubFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, fn] of routes) if (String(url).includes(match)) return fn();
    throw new Error("unexpected fetch " + url);
  };
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const body = {
  submitter_email: "mike@example.com",
  submitter_name: "Mike Ross",
  client_name: "Jane Doe",
  client_phone: "5551234567",
  lead_type: "Final Expense",
  premium: "1200",
  premium_mode: "annual",
};

beforeEach(() => {
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.DISCORD_WEBHOOK_URL = "https://discord.test/hook";
});

test("submit-win: 405 on GET", async () => {
  const res = mockRes();
  await submitWin({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
});

test("submit-win: 503 when not configured", async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 503);
});

test("submit-win: 400 with field errors and no DB call", async () => {
  stubFetch([]);
  const res = mockRes();
  await submitWin({ method: "POST", body: { ...body, submitter_email: "bad" } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.submitter_email);
  assert.equal(calls.length, 0);
});

test("submit-win: public win calls RPC and rings Discord without mentions", async () => {
  stubFetch([
    ["/rest/v1/rpc/submit_win", () => json({ id: "w1", status: "public", protected: true, state: "TX", matched_lead_type: "Final Expense" })],
    ["discord.test", () => new Response(null, { status: 204 })],
  ]);
  const res = mockRes();
  await submitWin({ method: "POST", body: JSON.stringify(body) }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: "public", protected: true });
  assert.equal(calls[0].init.headers.Authorization, "Bearer service-key");
  assert.equal(JSON.parse(calls[0].init.body).p.client_phone, "5551234567");
  const discord = JSON.parse(calls[1].init.body);
  assert.equal(discord.content, "🔔 Mike R. (TX) just closed a Final Expense deal — $1,200 AP!");
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
});

test("submit-win: pending win does not ring Discord", async () => {
  stubFetch([["/rest/v1/rpc/submit_win", () => json({ id: "w2", status: "pending", protected: false, state: null, matched_lead_type: null })]]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.deepEqual(res.body, { status: "pending", protected: false });
  assert.equal(calls.length, 1);
});

test("submit-win: Discord failure still returns 200", async () => {
  stubFetch([
    ["/rest/v1/rpc/submit_win", () => json({ id: "w3", status: "public", protected: false, state: null, matched_lead_type: null })],
    ["discord.test", () => { throw new Error("down"); }],
  ]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 200);
});

test("submit-win: rate limited -> 429", async () => {
  stubFetch([["/rest/v1/rpc/submit_win", () => json({ error: "rate_limited" })]]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 429);
});

test("submit-win: DB error -> 500", async () => {
  stubFetch([["/rest/v1/rpc/submit_win", () => json({ message: "boom" }, 500)]]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 500);
});

test("wins: only public-safe fields, cached", async () => {
  stubFetch([["/rest/v1/rpc/wins_board", () => json({
    leaderboard: [{ name: "Mike Ross", show_name: true, ap_cents: 120000, wins: 1, submitter_email: "leak@x.com" }],
    feed: [],
  })]]);
  const res = mockRes();
  await wins({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { leaderboard: [{ name: "Mike R.", ap_cents: 120000, wins: 1 }], feed: [] });
  assert.match(res.headers["cache-control"], /s-maxage=30/);
});

test("wins: DB error -> 502", async () => {
  stubFetch([["/rest/v1/rpc/wins_board", () => json({}, 500)]]);
  const res = mockRes();
  await wins({ method: "GET" }, res);
  assert.equal(res.statusCode, 502);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.test.mjs`
Expected: FAIL — `Cannot find module '.../api/submit-win.mjs'`

- [ ] **Step 3: Write `lib/supabase.mjs`**

```js
// Server-only: calls a Postgres function through PostgREST with the service-role key.
export async function rpc(name, args = {}) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${name} ${r.status}: ${await r.text()}`);
  return r.json();
}
```

- [ ] **Step 4: Write `api/submit-win.mjs`**

```js
import { validate, bellMessage } from "../lib/win.mjs";
import { rpc } from "../lib/supabase.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DISCORD_WEBHOOK_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: "Not configured." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const check = validate(body);
  if (!check.ok) return res.status(400).json({ errors: check.errors });
  const win = check.value;

  let out;
  try {
    out = await rpc("submit_win", { p: win });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Couldn't save — please try again." });
  }
  if (out.error === "rate_limited") {
    return res.status(429).json({ error: "Too many submissions — try again in a few minutes." });
  }

  if (out.status === "public" && DISCORD_WEBHOOK_URL) {
    const content = bellMessage({
      name: win.submitter_name,
      showName: win.show_name,
      state: out.state,
      leadType: out.matched_lead_type || win.lead_type,
      apCents: win.annual_premium_cents,
    });
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(3000),
    }).catch((e) => console.error("discord", e));
  }

  return res.status(200).json({ status: out.status, protected: out.protected });
}
```

- [ ] **Step 5: Write `api/wins.mjs`**

```js
import { toPublicBoard } from "../lib/win.mjs";
import { rpc } from "../lib/supabase.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: "Not configured." });

  try {
    const board = toPublicBoard(await rpc("wins_board"));
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(board);
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "Couldn't load wins." });
  }
}
```

- [ ] **Step 6: Run all tests**

Run: `node --test test/win.test.mjs test/api.test.mjs`
Expected: `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add lib/supabase.mjs api test/api.test.mjs
git -c user.name=Deicide12 -c user.email=Deicide12@users.noreply.github.com commit -m "feat: submit-win and wins API handlers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Page (`index.html`)

**Files:**
- Create: `index.html`, `.claude/launch.json`

**Interfaces:**
- Consumes: `LEAD_TYPES`, `formatAP` from `/lib/win.mjs`; `POST /api/submit-win`, `GET /api/wins` (Task 3).

- [ ] **Step 1: Write `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Submit a Sale — Aged Life Leads Hub</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--navy-900:#131d3f;--navy-700:#253571;--red-600:#c81e2e;--red-500:#d92435;--red-50:#fdeef0;--ink:#131d3f;--ink-soft:#3f4a6e;--ink-mute:#5a6482;--paper:#fbfaf7;--surface:#fff;--line:#e6e4dd;--cloud:#eef1fb;--font-display:"Bricolage Grotesque","Inter",system-ui,sans-serif;--font-body:"Inter",system-ui,-apple-system,sans-serif;--radius:16px;--shadow-md:0 2px 4px rgba(19,29,63,.04),0 12px 32px rgba(19,29,63,.09)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--font-body)}
header{background:var(--navy-900);color:#fff;padding:40px 20px 96px;text-align:center}
header h1{font:700 clamp(28px,6vw,40px)/1.1 var(--font-display);margin:0 0 8px}
header p{margin:0 auto;max-width:34rem;color:#c9d0ea}
main{max-width:560px;margin:-64px auto 48px;padding:0 16px;display:grid;gap:20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-md);padding:24px}
h2{font:700 20px/1.2 var(--font-display);margin:0 0 12px}
label{display:block;font-weight:600;font-size:14px;margin:0 0 6px}
.field{margin-bottom:16px}
.hint{font-size:12px;color:var(--ink-mute);margin-top:4px}
input,select,textarea{width:100%;font:inherit;color:inherit;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--navy-700);outline-offset:1px;border-color:transparent}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:480px){.row{grid-template-columns:1fr}}
.private{background:var(--cloud);border-radius:12px;padding:16px;margin-bottom:16px}
.toggle{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.toggle button{font:600 15px var(--font-body);padding:10px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);cursor:pointer}
.toggle button[aria-pressed="true"]{background:var(--navy-900);color:#fff;border-color:var(--navy-900)}
.money{position:relative}
.money span{position:absolute;top:50%;transform:translateY(-50%);color:var(--ink-mute)}
.money .pre{left:14px}.money .suf{right:14px}
.money input{padding-left:28px;padding-right:44px}
.check{display:flex;gap:10px;align-items:center;font-weight:500}
.check input{width:auto}
.err{color:var(--red-600);font-size:13px;margin-top:4px}
.err:empty,.msg:empty{display:none}
.hp{position:absolute;left:-9999px}
button.bell{width:100%;font:700 17px var(--font-display);padding:16px;border:0;border-radius:12px;background:var(--red-500);color:#fff;cursor:pointer}
button.bell:hover{background:var(--red-600)}
button.bell:disabled{opacity:.6;cursor:wait}
.msg{margin-top:12px;padding:12px 14px;border-radius:10px;font-weight:500}
.msg.ok{background:#e8f6ee;color:#14532d}.msg.bad{background:var(--red-50);color:var(--red-600)}
ol.board,ul.feed{list-style:none;margin:0;padding:0}
ol.board li,ul.feed li{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
ol.board li:first-child,ul.feed li:first-child{border-top:0}
.rank{font:700 16px var(--font-display);color:var(--ink-mute);width:24px}
.who{flex:1;min-width:0}.who .sub{display:block}
.ap{font-weight:600;white-space:nowrap}
.sub{font-size:13px;color:var(--ink-mute)}
.empty{color:var(--ink-mute)}
.confetti{position:fixed;top:-12px;width:10px;height:14px;pointer-events:none;z-index:10;animation:fall 1.8s ease-in forwards}
@keyframes fall{to{transform:translateY(105vh) rotate(720deg);opacity:.7}}
@media (prefers-reduced-motion:reduce){.confetti{display:none}}
</style>
</head>
<body>
<header>
  <h1>Submit a Sale 🔔</h1>
  <p>Log your sale. It hits the leaderboard, rings the bell, and we pull your client from resale.</p>
</header>
<main>
  <form class="card" id="win-form" novalidate>
    <div class="row">
      <div class="field">
        <label for="submitter_name">Your name</label>
        <input id="submitter_name" name="submitter_name" autocomplete="name" required>
        <div class="err" data-err="submitter_name"></div>
      </div>
      <div class="field">
        <label for="submitter_phone">Your phone <span class="sub">(optional)</span></label>
        <input id="submitter_phone" name="submitter_phone" type="tel" autocomplete="tel">
      </div>
    </div>
    <div class="field">
      <label for="submitter_email">Your email</label>
      <input id="submitter_email" name="submitter_email" type="email" autocomplete="email" required>
      <div class="hint">Use the email you order leads with.</div>
      <div class="err" data-err="submitter_email"></div>
    </div>

    <div class="private">
      <div class="field">
        <label for="client_name">Client name</label>
        <input id="client_name" name="client_name" autocomplete="off" required>
        <div class="err" data-err="client_name"></div>
      </div>
      <div class="row">
        <div class="field">
          <label for="client_phone">Client phone</label>
          <input id="client_phone" name="client_phone" type="tel" autocomplete="off">
          <div class="err" data-err="client_phone"></div>
        </div>
        <div class="field">
          <label for="client_email">Client email</label>
          <input id="client_email" name="client_email" type="email" autocomplete="off">
          <div class="err" data-err="client_email"></div>
        </div>
      </div>
      <div class="hint">🔒 Private — never shown publicly. Phone or email lets us pull this client from resale.</div>
    </div>

    <div class="row">
      <div class="field">
        <label for="lead_type">Lead type</label>
        <select id="lead_type" name="lead_type" required><option value="">Select lead type…</option></select>
        <div class="err" data-err="lead_type"></div>
      </div>
      <div class="field">
        <label for="carrier">Carrier <span class="sub">(optional)</span></label>
        <input id="carrier" name="carrier" placeholder="e.g. Mutual of Omaha">
      </div>
    </div>

    <div class="field">
      <label id="premium-label" for="premium">Premium</label>
      <div class="toggle" role="group" aria-labelledby="premium-label">
        <button type="button" data-mode="monthly" aria-pressed="false">Monthly</button>
        <button type="button" data-mode="annual" aria-pressed="true">Annual</button>
      </div>
      <div class="money">
        <span class="pre">$</span>
        <input id="premium" name="premium" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" required>
        <span class="suf" id="premium-suffix">/yr</span>
      </div>
      <div class="hint">Scored on annual premium. Selling monthly? Tap Monthly and we'll do the math.</div>
      <div class="err" data-err="premium"></div>
    </div>

    <div class="field">
      <label for="testimonial">How were the leads? <span class="sub">(optional)</span></label>
      <textarea id="testimonial" name="testimonial" rows="3" maxlength="500"></textarea>
    </div>
    <div class="field">
      <label class="check"><input type="checkbox" id="show_name" checked> Show my name on the leaderboard</label>
    </div>
    <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">

    <button class="bell" type="submit">Ring the Bell 🔔</button>
    <div class="msg" id="form-msg" role="status" aria-live="polite"></div>
  </form>

  <section class="card">
    <h2>🏆 This month's leaderboard</h2>
    <ol class="board" id="board"><li class="empty">Loading…</li></ol>
  </section>
  <section class="card">
    <h2>Recent wins</h2>
    <ul class="feed" id="feed"><li class="empty">Loading…</li></ul>
  </section>
</main>

<script type="module">
import { LEAD_TYPES, formatAP } from "/lib/win.mjs";

const form = document.getElementById("win-form");
const msg = document.getElementById("form-msg");
const suffix = document.getElementById("premium-suffix");
const toggles = form.querySelectorAll(".toggle button");
let mode = "annual";

for (const t of LEAD_TYPES) document.getElementById("lead_type").add(new Option(t, t));

for (const btn of toggles) {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    for (const b of toggles) b.setAttribute("aria-pressed", String(b === btn));
    suffix.textContent = mode === "monthly" ? "/mo" : "/yr";
  });
}

function showErrors(errors = {}) {
  for (const el of form.querySelectorAll("[data-err]")) el.textContent = errors[el.dataset.err] || "";
  const first = Object.keys(errors).find((k) => document.getElementById(k));
  if (first) document.getElementById(first).focus();
}

function setMsg(text, ok) {
  msg.textContent = text;
  msg.className = "msg " + (ok ? "ok" : "bad");
}

function confetti() {
  const colors = ["#d92435", "#131d3f", "#f5b301", "#8fa3e8"];
  for (let i = 0; i < 40; i++) {
    const c = document.createElement("span");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = Math.random() * 0.4 + "s";
    document.body.append(c);
    setTimeout(() => c.remove(), 2600);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.premium_mode = mode;
  data.show_name = document.getElementById("show_name").checked;
  const btn = form.querySelector("button.bell");
  btn.disabled = true;
  showErrors();
  msg.textContent = "";
  try {
    const r = await fetch("/api/submit-win", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 400) {
      showErrors(out.errors);
      if (out.errors?.form) setMsg(out.errors.form, false);
      return;
    }
    if (!r.ok) return setMsg(out.error || "Couldn't save — please try again.", false);
    confetti();
    setMsg(
      out.status === "pending" ? "Logged! We'll review it shortly."
        : out.protected ? "🔔 Bell rung! Your client is now protected from resale."
        : "🔔 Bell rung! Your win is on the board.",
      true
    );
    form.reset();
    form.querySelector('[data-mode="annual"]').click();
    loadBoard();
  } catch {
    setMsg("Network error — please try again.", false);
  } finally {
    btn.disabled = false;
  }
});

const rel = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, n] of [["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= n) return rel.format(Math.round(s / n), unit);
  }
  return "just now";
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function row(...children) {
  const li = el("li");
  li.append(...children);
  return li;
}
function who(main, sub) {
  const d = el("div", "who");
  d.append(el("span", "", main), el("span", "sub", sub));
  return d;
}

async function loadBoard() {
  const board = document.getElementById("board");
  const feed = document.getElementById("feed");
  try {
    const r = await fetch("/api/wins");
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    board.replaceChildren(...(data.leaderboard.length
      ? data.leaderboard.map((x, i) => row(
          el("span", "rank", String(i + 1)),
          who(x.name, `${x.wins} ${x.wins === 1 ? "win" : "wins"}`),
          el("span", "ap", formatAP(x.ap_cents))))
      : [row(el("span", "empty", "No wins yet this month — be the first!"))]));
    feed.replaceChildren(...(data.feed.length
      ? data.feed.map((x) => row(
          who(x.state ? `${x.name} · ${x.state}` : x.name, `${x.lead_type} · ${ago(x.created_at)}`),
          el("span", "ap", formatAP(x.ap_cents))))
      : [row(el("span", "empty", "No wins yet."))]));
  } catch {
    board.replaceChildren(row(el("span", "empty", "Couldn't load the leaderboard.")));
    feed.replaceChildren(row(el("span", "empty", "Couldn't load recent wins.")));
  }
}

loadBoard();
setInterval(loadBoard, 60_000);
</script>
</body>
</html>
```

- [ ] **Step 2: Write `.claude/launch.json`** (static preview; API calls fail gracefully locally)

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "hub-static", "runtimeExecutable": "npx", "runtimeArgs": ["--yes", "serve", "-l", "4321", "."], "port": 4321 }
  ]
}
```

- [ ] **Step 3: Verify in the browser pane**

`preview_start { name: "hub-static" }`, then check:
- Lead type dropdown has 11 options (placeholder + 10).
- Monthly toggle flips suffix to `/mo` and `aria-pressed`.
- Locally there is no API (404), so submitting shows the form-level "Couldn't save — please try again." and the leaderboard shows "Couldn't load the leaderboard." No console errors other than those 404s. (Field-level 400 errors are covered by `test/api.test.mjs` and checked on the deployment in Task 5.)
- Screenshot at mobile width (375) and desktop.

- [ ] **Step 4: Commit**

```bash
git add index.html .claude/launch.json
git -c user.name=Deicide12 -c user.email=Deicide12@users.noreply.github.com commit -m "feat: Submit a Sale page with leaderboard and feed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Deploy + end-to-end check

- [ ] **Step 1: Push** — `git push -u origin main`
- [ ] **Step 2: Create Vercel project** linked to `Deicide12/AgedLifeLeads-Hub` (Vercel MCP, or dashboard → Add New → Project → Import). Framework preset: Other; no build command.
- [ ] **Step 3: Env vars.** Set `SUPABASE_URL = https://fhxajizqumguubgitrlf.supabase.co` (non-secret, via MCP). **Owner sets secrets in the Vercel dashboard** (Project → Settings → Environment Variables): `SUPABASE_SERVICE_ROLE_KEY` (same value as the aged-life-leads-website project) and `DISCORD_WEBHOOK_URL` (after Discord setup below). Redeploy.
- [ ] **Step 4: Discord (owner).** Create `#wins`; Edit Channel → Permissions → `@everyone`: deny Send Messages, allow View Channel + Add Reactions; Integrations → Webhooks → New Webhook → Copy URL → `DISCORD_WEBHOOK_URL`.
- [ ] **Step 5: E2E on the deployment** (browser pane):
  - `GET /api/wins` → 200 `{"leaderboard":[],"feed":[]}`.
  - Submit the form with `e2e-test@example.com`, client email `client@example.com`, IUL, $100 annual → "Logged! We'll review it shortly." (pending path; no Discord; no real lead touched).
  - Verify via SQL: `select status, agent_id from wins where submitter_email = 'e2e-test@example.com'` → `pending`, null.
  - Delete it: `delete from wins where submitter_email = 'e2e-test@example.com'`.
  - (Matched path is covered by `supabase/tests/wins_test.sql`, which rolls back — never submit as a real agent, it would mark their lead sold and ping Discord.)
- [ ] **Step 6: Domain.** Add `hub.agedlifeleads.com` to the project; if DNS is not on Vercel, owner adds `CNAME hub → cname.vercel-dns.com`.
