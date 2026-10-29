-- Disposable database only. Single-statement test; synthetic data is rolled back.
DO $$
DECLARE
  operator uuid := gen_random_uuid();
  other_operator uuid := gen_random_uuid();
  account uuid;
  other_account uuid;
  first_session uuid;
  second_session uuid;
  result public.copilot_sessions;
BEGIN
  -- A subtransaction rolls every fixture change back after successful checks.
  -- Keep this file a single statement for Supabase CLI prepared execution.
  BEGIN
  INSERT INTO auth.users(id, email) VALUES
    (operator, 'copilot-fixture-a@example.invalid'),
    (other_operator, 'copilot-fixture-b@example.invalid');
  SELECT account_id INTO STRICT account FROM public.profiles WHERE user_id = operator;
  SELECT account_id INTO STRICT other_account FROM public.profiles WHERE user_id = other_operator;

  PERFORM set_config('request.jwt.claim.sub', other_operator::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.transition_copilot_session('start');

  PERFORM set_config('request.jwt.claim.sub', operator::text, true);
  SET LOCAL ROLE authenticated;
  IF (public.get_copilot_session(account, operator)->>'state' = 'inactive') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: starts inactive'; END IF;
  SELECT * INTO result FROM public.transition_copilot_session('start');
  first_session := result.session_id;
  IF (result.state = 'active' AND result.operator_id = operator AND result.account_id = account) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: identity derived from auth'; END IF;
  IF (result.expires_at > clock_timestamp() AND result.expires_at <= clock_timestamp() + interval '90 seconds') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: bounded lease'; END IF;
  SELECT * INTO result FROM public.transition_copilot_session('heartbeat', first_session);
  IF (result.session_id = first_session) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: heartbeat keeps generation'; END IF;
  SELECT * INTO result FROM public.transition_copilot_session('pause', first_session);
  IF (public.get_copilot_session(account, operator)->>'state' = 'paused') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: pause visible'; END IF;
  BEGIN
    PERFORM public.transition_copilot_session('heartbeat', first_session);
    RAISE EXCEPTION 'paused heartbeat accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'paused heartbeat accepted' THEN RAISE; END IF;
  END;
  SELECT * INTO result FROM public.transition_copilot_session('start');
  second_session := result.session_id;
  IF (second_session <> first_session) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: explicit restart rotates ID'; END IF;
  BEGIN
    PERFORM public.transition_copilot_session('pause', first_session);
    RAISE EXCEPTION 'stale tab paused new session';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'stale tab paused new session' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.copilot_sessions SET expires_at = clock_timestamp() + interval '1 year';
    RAISE EXCEPTION 'direct mutation accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (public.get_copilot_session(other_account, other_operator)->>'state' = 'inactive') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: cross-account read hidden'; END IF;
  PERFORM set_config('request.jwt.claim.sub', other_operator::text, true);
  IF ((SELECT count(*) FROM public.copilot_sessions WHERE operator_id = operator) = 0) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: RLS hides another operator'; END IF;
  BEGIN
    PERFORM public.transition_copilot_session('heartbeat', second_session);
    RAISE EXCEPTION 'other operator renewed session';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'other operator renewed session' THEN RAISE; END IF;
  END;

  SET LOCAL ROLE postgres;
  -- A teammate also cannot read or renew another human's session.
  UPDATE public.profiles SET account_id = account, account_role = 'agent' WHERE user_id = other_operator;
  SET LOCAL ROLE authenticated;
  IF (public.get_copilot_session(account, operator)->>'state' = 'inactive') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: same-account operator read hidden'; END IF;
  BEGIN
    PERFORM public.transition_copilot_session('heartbeat', second_session);
    RAISE EXCEPTION 'teammate renewed session';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'teammate renewed session' THEN RAISE; END IF;
  END;
  SET LOCAL ROLE service_role;
  IF (public.get_copilot_session(other_account, other_operator)->>'state' = 'inactive') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: account move invalidates old lease'; END IF;
  SET LOCAL ROLE postgres;
  UPDATE public.copilot_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE operator_id = operator;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE service_role;
  IF (public.get_copilot_session(account, operator)->>'state' = 'expired') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: service read uses DB clock'; END IF;
  BEGIN
    PERFORM public.transition_copilot_session('start');
    RAISE EXCEPTION 'service role activated human';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', operator::text, true);
  BEGIN
    PERFORM public.transition_copilot_session('heartbeat', second_session);
    RAISE EXCEPTION 'expired heartbeat accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'expired heartbeat accepted' THEN RAISE; END IF;
  END;
  PERFORM public.transition_copilot_session('start');

  SET LOCAL ROLE postgres;
  UPDATE public.profiles SET account_role = 'viewer' WHERE user_id = operator;
  SET LOCAL ROLE service_role;
  IF (public.get_copilot_session(account, operator)->>'state' = 'inactive') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: downgrade immediately invalidates lease'; END IF;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.transition_copilot_session('start');
    RAISE EXCEPTION 'viewer activated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.get_copilot_session(account, operator);
    RAISE EXCEPTION 'anonymous read accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.transition_copilot_session('start');
    RAISE EXCEPTION 'missing human accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SET LOCAL ROLE postgres;
  RAISE SQLSTATE 'ZX001' USING MESSAGE = 'rollback successful synthetic fixture';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN
    -- Reaching this handler means every assertion passed. PostgreSQL has
    -- already rolled back all inserts/updates in the subtransaction.
    NULL;
  END;
END $$;
