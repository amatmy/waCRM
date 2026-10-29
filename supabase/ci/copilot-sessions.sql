-- Disposable database only. All synthetic users/data are rolled back.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', message; END IF;
END $$;

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
  PERFORM pg_temp.assert_true(public.get_copilot_session(account, operator)->>'state' = 'inactive', 'starts inactive');
  SELECT * INTO result FROM public.transition_copilot_session('start');
  first_session := result.session_id;
  PERFORM pg_temp.assert_true(result.state = 'active' AND result.operator_id = operator AND result.account_id = account, 'identity derived from auth');
  PERFORM pg_temp.assert_true(result.expires_at > clock_timestamp() AND result.expires_at <= clock_timestamp() + interval '90 seconds', 'bounded lease');
  SELECT * INTO result FROM public.transition_copilot_session('heartbeat', first_session);
  PERFORM pg_temp.assert_true(result.session_id = first_session, 'heartbeat keeps generation');
  SELECT * INTO result FROM public.transition_copilot_session('pause', first_session);
  PERFORM pg_temp.assert_true(public.get_copilot_session(account, operator)->>'state' = 'paused', 'pause visible');
  BEGIN
    PERFORM public.transition_copilot_session('heartbeat', first_session);
    RAISE EXCEPTION 'paused heartbeat accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'paused heartbeat accepted' THEN RAISE; END IF;
  END;
  SELECT * INTO result FROM public.transition_copilot_session('start');
  second_session := result.session_id;
  PERFORM pg_temp.assert_true(second_session <> first_session, 'explicit restart rotates ID');
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
  PERFORM pg_temp.assert_true(public.get_copilot_session(other_account, other_operator)->>'state' = 'inactive', 'cross-account read hidden');
  PERFORM set_config('request.jwt.claim.sub', other_operator::text, true);
  PERFORM pg_temp.assert_true((SELECT count(*) FROM public.copilot_sessions WHERE operator_id = operator) = 0, 'RLS hides another operator');
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
  PERFORM pg_temp.assert_true(public.get_copilot_session(account, operator)->>'state' = 'inactive', 'same-account operator read hidden');
  BEGIN
    PERFORM public.transition_copilot_session('heartbeat', second_session);
    RAISE EXCEPTION 'teammate renewed session';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'teammate renewed session' THEN RAISE; END IF;
  END;
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.assert_true(public.get_copilot_session(other_account, other_operator)->>'state' = 'inactive', 'account move invalidates old lease');
  SET LOCAL ROLE postgres;
  UPDATE public.copilot_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE operator_id = operator;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE service_role;
  PERFORM pg_temp.assert_true(public.get_copilot_session(account, operator)->>'state' = 'expired', 'service read uses DB clock');
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
  PERFORM pg_temp.assert_true(public.get_copilot_session(account, operator)->>'state' = 'inactive', 'downgrade immediately invalidates lease');
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
END $$;
ROLLBACK;
