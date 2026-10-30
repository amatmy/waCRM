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
