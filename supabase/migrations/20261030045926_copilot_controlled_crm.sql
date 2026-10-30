-- Controlled CRM actions and explicit verified-answer hybrid policy. Disabled by default.
ALTER TABLE public.copilot_policies DROP CONSTRAINT copilot_policies_mode_check;
ALTER TABLE public.copilot_policies ADD CONSTRAINT copilot_policies_mode_check
  CHECK (mode IN ('human_approval','hybrid'));
CREATE TABLE public.copilot_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  query_normalized text NOT NULL CHECK (length(query_normalized) BETWEEN 1 AND 4096),
  answer_text text NOT NULL CHECK (length(answer_text) BETWEEN 1 AND 4096),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 2000),
  verified_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,query_normalized)
);
ALTER TABLE public.copilot_outbox
  ADD COLUMN authorization_basis text NOT NULL DEFAULT 'human_approval'
    CHECK (authorization_basis IN ('human_approval','verified_answer')),
  ADD COLUMN knowledge_id uuid REFERENCES public.copilot_answers(id);
CREATE TABLE public.copilot_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  ownership_revision bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('assign','handoff','note','status','deal')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(key_id,idempotency_key)
);
CREATE INDEX copilot_actions_account_created ON public.copilot_actions(account_id,created_at);
ALTER TABLE public.copilot_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.copilot_answers,public.copilot_actions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.copilot_answers,public.copilot_actions TO authenticated,service_role;
CREATE POLICY copilot_answers_read ON public.copilot_answers FOR SELECT TO authenticated USING (public.is_account_member(account_id));
CREATE POLICY copilot_actions_read ON public.copilot_actions FOR SELECT TO authenticated USING (public.is_account_member(account_id));

-- Native human close/reopen and contact changes must invalidate stale approvals,
-- just as assignment and explicit pause do. Preserve summaries/history.
CREATE OR REPLACE FUNCTION copilot_private.guard_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon', 'service_role') AND (
    NEW.copilot_key_id IS DISTINCT FROM OLD.copilot_key_id OR
    NEW.copilot_session_id IS DISTINCT FROM OLD.copilot_session_id OR
    NEW.copilot_revision IS DISTINCT FROM OLD.copilot_revision OR
    NEW.copilot_latest_inbound_id IS DISTINCT FROM OLD.copilot_latest_inbound_id
  ) THEN
    RAISE EXCEPTION 'Copilot authority is server controlled' USING ERRCODE = '42501';
  END IF;
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id OR
     NEW.ai_autoreply_disabled IS DISTINCT FROM OLD.ai_autoreply_disabled OR
     NEW.status IS DISTINCT FROM OLD.status OR
     NEW.contact_id IS DISTINCT FROM OLD.contact_id OR
     NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    NEW.copilot_key_id := NULL;
    NEW.copilot_session_id := NULL;
    NEW.copilot_revision := OLD.copilot_revision + 1;
    IF NEW.assigned_agent_id IS NOT NULL OR NEW.status <> 'open' OR
       NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    THEN NEW.ai_autoreply_disabled := true; END IF;
  END IF;
  RETURN NEW;
END $$;

-- Preserve curated business knowledge when joining another team. Keep the
-- existing membership RPC unchanged except for its new domain-data checks.
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM copilot_answers WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM copilot_actions WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
