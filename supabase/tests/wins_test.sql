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
