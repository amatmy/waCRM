-- Human presence is a short renewable lease, never a scheduled AI shift.
-- API keys can inspect it; only an authenticated operator can change it.
CREATE TABLE public.copilot_sessions (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK (state IN ('active', 'paused')),
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, operator_id)
);
ALTER TABLE public.copilot_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.copilot_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.copilot_sessions TO authenticated, service_role;
CREATE POLICY copilot_sessions_read ON public.copilot_sessions
  FOR SELECT TO authenticated
  USING (operator_id = (SELECT auth.uid()) AND public.is_account_member(account_id, 'agent'));

-- Keep privileged code outside the exposed PostgREST schema. No direct
-- table mutation grants: a caller cannot supply their own expiry time.
CREATE SCHEMA IF NOT EXISTS copilot_private;
REVOKE ALL ON SCHEMA copilot_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA copilot_private TO authenticated;

CREATE FUNCTION copilot_private.transition_session(p_action text, p_session_id uuid)
RETURNS public.copilot_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_operator uuid := auth.uid();
  v_account uuid;
  v_now timestamptz;
  v_row public.copilot_sessions;
BEGIN
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'Human authentication required' USING ERRCODE = '42501';
  END IF;
  -- Lock membership until this transaction finishes; role revocation or
  -- account transfer cannot race a successful activation/heartbeat.
  SELECT account_id INTO v_account FROM public.profiles
    WHERE user_id = v_operator AND account_role IN ('owner', 'admin', 'agent')
    FOR SHARE;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Operator membership required' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('start', 'heartbeat', 'pause') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Invalid session action' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'start' THEN
    v_now := clock_timestamp();
    INSERT INTO public.copilot_sessions AS s
      (account_id, operator_id, state, started_at, heartbeat_at, expires_at)
    VALUES (v_account, v_operator, 'active', v_now, v_now, v_now + interval '90 seconds')
    ON CONFLICT (account_id, operator_id) DO UPDATE
      SET session_id = gen_random_uuid(), state = 'active',
          started_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
          expires_at = clock_timestamp() + interval '90 seconds'
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM public.copilot_sessions
      WHERE account_id = v_account AND operator_id = v_operator FOR UPDATE;
    v_now := clock_timestamp();
    IF v_row.session_id IS NULL OR p_session_id IS DISTINCT FROM v_row.session_id THEN
      RAISE EXCEPTION 'Stale or missing session' USING ERRCODE = 'P0001';
    END IF;
    IF p_action = 'heartbeat' AND
      (v_row.state <> 'active' OR v_row.expires_at <= v_now) THEN
      RAISE EXCEPTION 'Session requires explicit restart' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.copilot_sessions SET
      state = CASE WHEN p_action = 'pause' THEN 'paused' ELSE 'active' END,
      heartbeat_at = v_now,
      expires_at = CASE WHEN p_action = 'pause' THEN v_now ELSE v_now + interval '90 seconds' END
      WHERE account_id = v_account AND operator_id = v_operator
      RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION copilot_private.transition_session(text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION copilot_private.transition_session(text, uuid) TO authenticated;

CREATE FUNCTION public.transition_copilot_session(p_action text, p_session_id uuid DEFAULT NULL)
RETURNS public.copilot_sessions
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT copilot_private.transition_session(p_action, p_session_id);
$$;
REVOKE ALL ON FUNCTION public.transition_copilot_session(text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.transition_copilot_session(text, uuid) TO authenticated;

-- The database clock determines expiry. Revoked/downgraded/moved members
-- become inactive immediately, even if their stored lease has time left.
CREATE FUNCTION public.get_copilot_session(p_account_id uuid, p_operator_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT jsonb_build_object(
      'session_id', s.session_id, 'operator_id', s.operator_id,
      'state', CASE WHEN s.state = 'paused' THEN 'paused'
                    WHEN s.expires_at <= clock_timestamp() THEN 'expired' ELSE 'active' END,
      'started_at', s.started_at, 'heartbeat_at', s.heartbeat_at, 'expires_at', s.expires_at
    ) FROM public.copilot_sessions s
      JOIN public.profiles p ON p.user_id = s.operator_id AND p.account_id = s.account_id
    WHERE s.account_id = p_account_id AND s.operator_id = p_operator_id
      AND p.account_role IN ('owner', 'admin', 'agent')
  ), jsonb_build_object('state', 'inactive'));
$$;
REVOKE ALL ON FUNCTION public.get_copilot_session(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_copilot_session(uuid, uuid) TO authenticated, service_role;
