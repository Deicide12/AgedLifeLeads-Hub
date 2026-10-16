# Aged Life Leads Hub

"Submit a Sale" page: agents log wins → monthly AP leaderboard, live feed, Discord bell.
Standalone: own Vercel project + own Supabase project. Touches no existing site or the CRM.
Design: [docs/superpowers/specs/2026-10-17-win-submissions-design.md](docs/superpowers/specs/2026-10-17-win-submissions-design.md)

## One-time setup

1. **Supabase** (separate free account): New project "Aged Life Leads Hub", region West US (N. California).
   SQL Editor → paste `supabase/migrations/20261017000000_wins.sql` → Run.
   Optional check: paste `supabase/tests/wins_test.sql` → Run → expect error `WINS TESTS PASSED` (it rolls back).
2. **Copy keys**: Project Settings → API → Project URL, and the `service_role` (secret) key.
3. **Discord**: create `#wins` → Edit Channel → Permissions → `@everyone`: deny *Send Messages*, allow *View Channel* + *Add Reactions* → Integrations → Webhooks → New Webhook → Copy URL.
4. **Vercel**: Add New → Project → import `Deicide12/AgedLifeLeads-Hub` (Framework: Other, no build command). Environment Variables:
   - `SUPABASE_URL` — Project URL from step 2
   - `SUPABASE_SERVICE_ROLE_KEY` — service_role key from step 2
   - `DISCORD_WEBHOOK_URL` — webhook URL from step 3
   Deploy. Optional domain: `hub.agedlifeleads.com`.

## Owner workflow (Supabase → Table Editor → `wins`)

- **Pull from resale:** filter `resale_retired = false` → retire that client in the CRM → tick `resale_retired`.
- **Fake win:** set `status` to `hidden` (gone from the board within ~30s).

## Dev

```bash
node --test test/win.test.mjs test/api.test.mjs
```
