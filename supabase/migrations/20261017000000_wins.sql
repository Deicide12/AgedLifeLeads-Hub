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
