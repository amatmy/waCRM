-- Journal canonical inbound storage atomically, independently of human presence.
CREATE TABLE public.copilot_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','awaiting_human','completed','superseded','invalidated')),
  lease_token uuid,
  key_id uuid,
  operator_id uuid,
  session_id uuid,
  ownership_revision bigint,
  policy_revision bigint,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  reason text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,provider_message_id),
  UNIQUE(source_id)
);
CREATE INDEX copilot_work_account_pending ON public.copilot_work(account_id,created_at,id) WHERE state IN ('pending','leased');
CREATE INDEX copilot_work_account ON public.copilot_work(account_id);
CREATE INDEX copilot_work_conversation ON public.copilot_work(conversation_id);
CREATE TABLE public.copilot_work_attempts (
  token uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES public.copilot_work(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  session_id uuid NOT NULL,
  ownership_revision bigint NOT NULL,
  policy_revision bigint NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  reason text
);
CREATE INDEX copilot_work_attempts_work ON public.copilot_work_attempts(work_id,acquired_at);
CREATE INDEX copilot_work_attempts_account ON public.copilot_work_attempts(account_id);
ALTER TABLE public.copilot_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_work_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.copilot_work,public.copilot_work_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.copilot_work,public.copilot_work_attempts TO authenticated,service_role;
CREATE POLICY copilot_work_read ON public.copilot_work FOR SELECT TO authenticated USING (public.is_account_member(account_id));
CREATE POLICY copilot_work_attempts_read ON public.copilot_work_attempts FOR SELECT TO authenticated USING (public.is_account_member(account_id));
ALTER TABLE public.conversations ADD COLUMN copilot_work_id uuid, ADD COLUMN copilot_work_token uuid;
ALTER TABLE public.copilot_outbox ADD COLUMN work_token uuid;

ALTER TABLE public.messages
  ADD COLUMN copilot_ingress_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN copilot_ingress_consumed boolean NOT NULL DEFAULT false;

-- Private trigger, not an exposed RPC. The pre-existing message barrier verifies
-- server-origin inbound and serializes inserts/edits on the conversation row.
CREATE FUNCTION copilot_private.capture_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_account uuid; v_latest uuid; v_inserted integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'DELETE' OR (OLD.sender_type='customer' AND (
      NEW.content_text IS DISTINCT FROM OLD.content_text OR NEW.content_type IS DISTINCT FROM OLD.content_type OR
      NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.sender_type IS DISTINCT FROM OLD.sender_type OR
      NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
      NEW.media_url IS DISTINCT FROM OLD.media_url OR NEW.interactive_reply_id IS DISTINCT FROM OLD.interactive_reply_id OR
      NEW.copilot_verified_inbound IS DISTINCT FROM OLD.copilot_verified_inbound)) THEN
      UPDATE public.copilot_work SET state='invalidated',reason='source_changed',updated_at=clock_timestamp()
      WHERE source_id=OLD.id AND state<>'completed';
      UPDATE public.copilot_work_attempts a SET ended_at=coalesce(a.ended_at,clock_timestamp()),reason=coalesce(a.reason,'source_changed')
      FROM public.copilot_work w WHERE a.work_id=w.id AND w.source_id=OLD.id AND a.ended_at IS NULL;
    ELSIF NEW.copilot_ingress_completed AND NOT OLD.copilot_ingress_completed THEN
      UPDATE public.copilot_work SET ready=true,
        state=CASE WHEN NEW.copilot_ingress_consumed THEN 'completed' ELSE state END,
        reason=CASE WHEN NEW.copilot_ingress_consumed THEN 'native_consumed' ELSE reason END,
        outcome=CASE WHEN NEW.copilot_ingress_consumed THEN jsonb_build_object('type','native_consumed') ELSE outcome END,
        updated_at=clock_timestamp()
      WHERE source_id=NEW.id AND state IN ('pending','leased','awaiting_human');
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.sender_type IN ('agent','bot') THEN
    -- A human/native-flow response is not another AI task. Copilot outbox
    -- persistence already records its provider ID before inserting its bot row.
    IF NOT EXISTS(SELECT 1 FROM public.copilot_outbox o WHERE o.conversation_id=NEW.conversation_id AND o.provider_message_id=NEW.message_id) THEN
      UPDATE public.copilot_work SET state='awaiting_human',reason='native_response',updated_at=clock_timestamp()
      WHERE conversation_id=NEW.conversation_id AND state IN ('pending','leased');
      UPDATE public.copilot_work_attempts a SET ended_at=clock_timestamp(),reason='native_response'
      FROM public.copilot_work w WHERE a.work_id=w.id AND w.conversation_id=NEW.conversation_id AND a.ended_at IS NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.sender_type <> 'customer' OR NOT NEW.copilot_verified_inbound OR NEW.message_id NOT LIKE 'wamid.%' THEN RETURN NEW; END IF;
  SELECT account_id,copilot_latest_inbound_id INTO v_account,v_latest FROM public.conversations WHERE id=NEW.conversation_id;
  INSERT INTO public.copilot_work(account_id,conversation_id,source_id,provider_message_id,ready,state,outcome)
  VALUES(v_account,NEW.conversation_id,NEW.id,NEW.message_id,NEW.copilot_ingress_completed,
    CASE WHEN NEW.copilot_ingress_completed AND NEW.copilot_ingress_consumed THEN 'completed' WHEN v_latest=NEW.id THEN 'pending' ELSE 'superseded' END,
    CASE WHEN NEW.copilot_ingress_completed AND NEW.copilot_ingress_consumed THEN jsonb_build_object('type','native_consumed') ELSE NULL END)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted>0 AND v_latest=NEW.id THEN
    UPDATE public.copilot_work SET state='superseded',reason='newer_inbound',updated_at=clock_timestamp()
    WHERE conversation_id=NEW.conversation_id AND source_id<>NEW.id AND state IN ('pending','leased');
    UPDATE public.copilot_work_attempts a SET ended_at=clock_timestamp(),reason='newer_inbound'
    FROM public.copilot_work w WHERE w.id=a.work_id AND w.conversation_id=NEW.conversation_id AND w.source_id<>NEW.id AND a.ended_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION copilot_private.capture_work() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER copilot_capture_work AFTER INSERT OR UPDATE OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION copilot_private.capture_work();

-- Conversation authority is the common fence, including existing native paths.
CREATE OR REPLACE FUNCTION copilot_private.guard_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon', 'service_role') AND (
    NEW.copilot_work_id IS DISTINCT FROM OLD.copilot_work_id OR
    NEW.copilot_work_token IS DISTINCT FROM OLD.copilot_work_token OR
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
    NEW.copilot_work_id := NULL; NEW.copilot_work_token := NULL;
    NEW.copilot_key_id := NULL;
    NEW.copilot_session_id := NULL;
    NEW.copilot_revision := OLD.copilot_revision + 1;
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      NEW.copilot_latest_inbound_id := NULL;
    END IF;
    IF NEW.assigned_agent_id IS NOT NULL OR NEW.status <> 'open' OR
       NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    THEN NEW.ai_autoreply_disabled := true; END IF;
  END IF;
  IF NEW.copilot_key_id IS NULL THEN NEW.copilot_work_id := NULL; NEW.copilot_work_token := NULL; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION copilot_private.fence_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF OLD.copilot_work_id IS NOT NULL AND (
    OLD.copilot_work_token IS DISTINCT FROM NEW.copilot_work_token OR
    OLD.copilot_key_id IS DISTINCT FROM NEW.copilot_key_id OR
    OLD.copilot_revision IS DISTINCT FROM NEW.copilot_revision OR
    OLD.copilot_latest_inbound_id IS DISTINCT FROM NEW.copilot_latest_inbound_id) THEN
    UPDATE public.copilot_work w SET state=CASE
      WHEN w.source_id IS DISTINCT FROM NEW.copilot_latest_inbound_id THEN 'superseded'
      WHEN EXISTS(SELECT 1 FROM public.copilot_outbox o WHERE o.conversation_id=OLD.id AND o.inbound_id=w.source_id) THEN 'awaiting_human'
      ELSE 'pending' END, reason='ownership_changed',updated_at=clock_timestamp()
    WHERE w.id=OLD.copilot_work_id AND w.lease_token=OLD.copilot_work_token AND w.state='leased';
    UPDATE public.copilot_work_attempts SET ended_at=clock_timestamp(),reason='ownership_changed'
    WHERE token=OLD.copilot_work_token AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION copilot_private.fence_work() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER copilot_work_revoked AFTER UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION copilot_private.fence_work();

CREATE OR REPLACE FUNCTION copilot_private.message_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='INSERT' AND current_setting('role',true) IN ('authenticated','anon') THEN
    NEW.copilot_ingress_completed:=false; NEW.copilot_ingress_consumed:=false;
  END IF;
  IF TG_OP='UPDATE' AND current_setting('role',true) IN ('authenticated','anon') AND (
    NEW.copilot_ingress_completed IS DISTINCT FROM OLD.copilot_ingress_completed OR
    NEW.copilot_ingress_consumed IS DISTINCT FROM OLD.copilot_ingress_consumed) THEN
    RAISE EXCEPTION 'Ingress completion is server controlled' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.copilot_verified_inbound := NEW.sender_type = 'customer'
      AND current_setting('role', true) NOT IN ('authenticated','anon');
    PERFORM 1 FROM public.conversations WHERE id = NEW.conversation_id FOR UPDATE;
    IF NEW.sender_type = 'customer' THEN
      -- BEFORE INSERT also runs for ON CONFLICT DO NOTHING webhook replays.
      -- A duplicate must not point the conversation at an uninserted UUID.
      IF NOT EXISTS(SELECT 1 FROM public.messages WHERE id=NEW.id OR (conversation_id=NEW.conversation_id AND NEW.message_id IS NOT NULL AND message_id=NEW.message_id)) THEN
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

-- The signature-verified ingestion backend alone records completion of its
-- awaited native flow/automation phase. No human or copilot API key can invoke it.
GRANT USAGE ON SCHEMA copilot_private TO service_role;
CREATE FUNCTION copilot_private.finalize_ingress(p_source_id uuid,p_consumed boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_conversation uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Trusted ingestion backend required' USING ERRCODE='42501';
  END IF;
  SELECT conversation_id INTO v_conversation FROM public.messages WHERE id=p_source_id AND sender_type='customer' AND copilot_verified_inbound;
  IF v_conversation IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public.conversations WHERE id=v_conversation FOR UPDATE;
  UPDATE public.messages SET copilot_ingress_completed=true,copilot_ingress_consumed=coalesce(p_consumed,false)
  WHERE id=p_source_id AND NOT copilot_ingress_completed;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION copilot_private.finalize_ingress(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION copilot_private.finalize_ingress(uuid,boolean) TO service_role;
CREATE FUNCTION public.copilot_finalize_ingress(p_source_id uuid,p_consumed boolean) RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT copilot_private.finalize_ingress(p_source_id,p_consumed) $$;
REVOKE ALL ON FUNCTION public.copilot_finalize_ingress(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.copilot_finalize_ingress(uuid,boolean) TO service_role;
