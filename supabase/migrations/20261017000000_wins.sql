-- Win submissions ("Ring the Bell"). Standalone Hub database: no links to the CRM.
-- Written only by the Hub API via the service-role key.

create table public.wins (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  status               text not null default 'public'
                       check (status in ('public', 'hidden')), -- set 'hidden' to pull a fake win
  resale_retired       boolean not null default false,        -- tick once the client is pulled from resale in the CRM
  submitter_email      text not null,
  submitter_name       text not null,
  submitter_phone      text,
  client_name          text not null,
  client_phone         text,
  client_email         text,
  lead_type            text not null,
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
  v_email text := lower(p->>'submitter_email');
  v_id    uuid;
begin
  -- Stateless rate limit: 5 wins per submitter email per 10 minutes.
  if (select count(*) from public.wins
      where lower(submitter_email) = v_email
        and created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  insert into public.wins (
    submitter_email, submitter_name, submitter_phone,
    client_name, client_phone, client_email,
    lead_type, carrier, annual_premium_cents, premium_mode, testimonial, show_name)
  values (
    v_email, p->>'submitter_name', nullif(p->>'submitter_phone', ''),
    p->>'client_name', nullif(p->>'client_phone', ''), nullif(lower(p->>'client_email'), ''),
    p->>'lead_type', nullif(p->>'carrier', ''), (p->>'annual_premium_cents')::int, p->>'premium_mode',
    nullif(p->>'testimonial', ''), coalesce((p->>'show_name')::boolean, true))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'status', 'public');
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
        group by lower(submitter_email)
        order by ap_cents desc
        limit 10
      ) b), '[]'::jsonb),
    'feed', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at desc)
      from (
        select submitter_name       as name,
               show_name,
               lead_type,
               annual_premium_cents as ap_cents,
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
