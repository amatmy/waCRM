-- Stacked on the active-session foundation. No AI scheduler or inference.
CREATE TABLE public.copilot_keys (
  key_id uuid PRIMARY KEY REFERENCES public.api_keys(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE TABLE public.copilot_policies (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'human_approval' CHECK (mode = 'human_approval')
);
CREATE TABLE public.copilot_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  ownership_revision bigint NOT NULL,
  inbound_id uuid NOT NULL,
  policy_revision bigint NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  reply_text text NOT NULL CHECK (length(reply_text) BETWEEN 1 AND 4096),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','dispatching','sent','unknown','failed','cancelled')),
  approved_by uuid,
  approved_at timestamptz,
  provider_message_id text UNIQUE,
  error_code text,
  attempted_at timestamptz,
  reconciled_by uuid,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (key_id, idempotency_key),
  -- Single attempt per inbound, even if a caller changes its idempotency key.
  UNIQUE (conversation_id, inbound_id)
);
CREATE INDEX copilot_outbox_account ON public.copilot_outbox(account_id, created_at);
ALTER TABLE public.conversations
  ADD COLUMN copilot_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  ADD COLUMN copilot_session_id uuid,
  ADD COLUMN copilot_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN copilot_latest_inbound_id uuid;
-- Historical/imported customer rows are not proof of a current Meta window.
ALTER TABLE public.messages ADD COLUMN copilot_verified_inbound boolean NOT NULL DEFAULT false;
UPDATE public.conversations c SET copilot_latest_inbound_id = (
  SELECT m.id FROM public.messages m WHERE m.conversation_id = c.id AND m.sender_type = 'customer'
  ORDER BY m.created_at DESC, m.id DESC LIMIT 1
);

ALTER TABLE public.copilot_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.copilot_keys, public.copilot_policies, public.copilot_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.copilot_keys, public.copilot_policies, public.copilot_outbox TO authenticated, service_role;
-- Native inbox assignment remains available under its existing account RLS.
GRANT SELECT, UPDATE ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.messages TO authenticated;
CREATE POLICY copilot_keys_read ON public.copilot_keys FOR SELECT TO authenticated USING (public.is_account_member(account_id));
CREATE POLICY copilot_policies_read ON public.copilot_policies FOR SELECT TO authenticated USING (public.is_account_member(account_id));
CREATE POLICY copilot_outbox_read ON public.copilot_outbox FOR SELECT TO authenticated USING (public.is_account_member(account_id));

-- Authority columns cannot be forged through PostgREST. Existing native
-- assignment/takeover operations revoke the AI claim and cancel unsent work.
CREATE FUNCTION copilot_private.guard_ownership() RETURNS trigger
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
     NEW.ai_autoreply_disabled IS DISTINCT FROM OLD.ai_autoreply_disabled THEN
    NEW.copilot_key_id := NULL;
    NEW.copilot_session_id := NULL;
    NEW.copilot_revision := OLD.copilot_revision + 1;
    IF NEW.assigned_agent_id IS NOT NULL THEN NEW.ai_autoreply_disabled := true; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION copilot_private.guard_ownership() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER copilot_ownership BEFORE UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION copilot_private.guard_ownership();

CREATE FUNCTION copilot_private.cancel_revoked_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.copilot_key_id IS DISTINCT FROM OLD.copilot_key_id OR NEW.copilot_revision <> OLD.copilot_revision THEN
    UPDATE public.copilot_outbox SET
      state = CASE WHEN state = 'dispatching' THEN 'unknown' ELSE 'cancelled' END,
      error_code = 'ownership_changed', updated_at = clock_timestamp()
    WHERE conversation_id = OLD.id AND state IN ('draft', 'approved', 'dispatching');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION copilot_private.cancel_revoked_outbox() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER copilot_cancel_revoked AFTER UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION copilot_private.cancel_revoked_outbox();

-- Incoming inserts and human intervention serialize on the same conversation
-- row that the dispatcher locks. This includes direct native inbox writes.
CREATE FUNCTION copilot_private.message_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.copilot_verified_inbound := NEW.sender_type = 'customer'
      AND current_setting('role', true) NOT IN ('authenticated','anon');
    PERFORM 1 FROM public.conversations WHERE id = NEW.conversation_id FOR UPDATE;
    IF NEW.sender_type = 'customer' THEN
      -- BEFORE INSERT also runs for ON CONFLICT DO NOTHING webhook replays.
      -- A duplicate must not point the conversation at an uninserted UUID.
      IF NOT EXISTS(SELECT 1 FROM public.messages WHERE id=NEW.id OR (NEW.message_id IS NOT NULL AND message_id=NEW.message_id)) THEN
        UPDATE public.conversations SET copilot_latest_inbound_id = NEW.id WHERE id = NEW.conversation_id;
      END IF;
    ELSIF NEW.sender_type = 'agent' THEN
      UPDATE public.conversations SET copilot_key_id = NULL, copilot_session_id = NULL,
        copilot_revision = copilot_revision + 1, ai_autoreply_disabled = true
      WHERE id = NEW.conversation_id AND copilot_key_id IS NOT NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.copilot_verified_inbound IS DISTINCT FROM OLD.copilot_verified_inbound
    AND current_setting('role', true) IN ('authenticated','anon') THEN
    RAISE EXCEPTION 'Inbound verification is server controlled' USING ERRCODE='42501';
  END IF;
  IF OLD.sender_type = 'customer' AND (TG_OP = 'DELETE' OR
    NEW.content_text IS DISTINCT FROM OLD.content_text OR NEW.content_type IS DISTINCT FROM OLD.content_type OR
    NEW.sender_type IS DISTINCT FROM OLD.sender_type OR NEW.message_id IS DISTINCT FROM OLD.message_id OR
    NEW.media_url IS DISTINCT FROM OLD.media_url OR NEW.interactive_reply_id IS DISTINCT FROM OLD.interactive_reply_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id) THEN
    UPDATE public.conversations SET copilot_key_id = NULL, copilot_session_id = NULL,
      copilot_revision = copilot_revision + 1, copilot_latest_inbound_id = NULL
    WHERE id = OLD.conversation_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION copilot_private.message_barrier() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER copilot_message_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION copilot_private.message_barrier();

-- Manual send must relinquish AI authority BEFORE a provider call, not only
-- when its message row is persisted. Only a human JWT can use this wrapper.
CREATE FUNCTION copilot_private.manual_takeover(p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_account uuid; BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Human authentication required' USING ERRCODE = '42501'; END IF;
  SELECT account_id INTO v_account FROM public.profiles WHERE user_id = auth.uid()
    AND account_role IN ('owner','admin','agent') FOR SHARE;
  IF v_account IS NULL THEN RAISE EXCEPTION 'Operator required' USING ERRCODE = '42501'; END IF;
  UPDATE public.conversations SET copilot_key_id = NULL, copilot_session_id = NULL,
    copilot_revision = copilot_revision + 1, ai_autoreply_disabled = true
  WHERE id = p_conversation_id AND account_id = v_account;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION copilot_private.manual_takeover(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION copilot_private.manual_takeover(uuid) TO authenticated;
CREATE FUNCTION public.copilot_manual_takeover(p_conversation_id uuid) RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT copilot_private.manual_takeover(p_conversation_id) $$;
REVOKE ALL ON FUNCTION public.copilot_manual_takeover(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_manual_takeover(uuid) TO authenticated;
