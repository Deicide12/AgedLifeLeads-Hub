-- Self-contained test for submit_win / wins_board. Run in the Hub project's SQL editor (or MCP execute_sql).
-- Everything rolls back: success ends by raising 'WINS TESTS PASSED', which aborts the transaction.
-- Failure surfaces as an ASSERT error with the failing message.
do $$
declare
  v_email text := 'test-' || gen_random_uuid() || '@example.com';
  r       jsonb;
  b       jsonb;
  i       int;
begin
  -- 1. Submit -> public, stored normalized
  r := public.submit_win(jsonb_build_object(
    'submitter_email', upper(v_email), 'submitter_name', 'Test Agent', 'client_name', 'Test Client',
    'client_phone', '5551234567', 'client_email', 'Client@Example.com', 'lead_type', 'Final Expense',
    'annual_premium_cents', 120000, 'premium_mode', 'annual', 'show_name', true));
  assert r->>'status' = 'public', 'win should be public: ' || r::text;
  assert (select submitter_email from public.wins where id = (r->>'id')::uuid) = v_email, 'email not lowercased';
  assert (select client_email from public.wins where id = (r->>'id')::uuid) = 'client@example.com', 'client email not lowercased';
  assert not (select resale_retired from public.wins where id = (r->>'id')::uuid), 'resale_retired should default false';

  -- 2. Board lists the win and no private fields
  b := public.wins_board();
  assert jsonb_path_exists(b, '$.feed[*] ? (@.name == "Test Agent")'), 'win missing from feed';
  assert jsonb_path_exists(b, '$.leaderboard[*] ? (@.name == "Test Agent" && @.ap_cents == 120000)'), 'win missing from leaderboard';
  assert b::text not ilike '%client%' and b::text not ilike '%@%', 'private fields leaked: ' || b::text;

  -- 3. Hidden wins disappear from the board
  update public.wins set status = 'hidden' where id = (r->>'id')::uuid;
  b := public.wins_board();
  assert not jsonb_path_exists(b, '$.feed[*] ? (@.name == "Test Agent")'), 'hidden win still in feed';

  -- 4. Rate limit: 5 per email per 10 minutes (1 used above)
  for i in 1..4 loop
    r := public.submit_win(jsonb_build_object(
      'submitter_email', v_email, 'submitter_name', 'Test Agent', 'client_name', 'Y',
      'client_email', 'y@example.com', 'lead_type', 'IUL', 'annual_premium_cents', 100, 'premium_mode', 'annual'));
    assert r ? 'status', 'call ' || i || ' should succeed: ' || r::text;
  end loop;
  r := public.submit_win(jsonb_build_object(
    'submitter_email', v_email, 'submitter_name', 'Test Agent', 'client_name', 'Y',
    'client_email', 'y@example.com', 'lead_type', 'IUL', 'annual_premium_cents', 100, 'premium_mode', 'annual'));
  assert r->>'error' = 'rate_limited', 'sixth call should be rate limited: ' || r::text;

  raise exception 'WINS TESTS PASSED';
end $$;
