DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['copilot_work','copilot_work_attempts'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Missing RLS: %',t;
    END IF;
    IF has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE') OR
       has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE') OR
       has_table_privilege('service_role','public.'||t,'INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Unexpected work privilege: %',t; END IF;
  END LOOP;
  IF has_function_privilege('anon','copilot_private.capture_work()','EXECUTE') OR
     has_function_privilege('authenticated','copilot_private.capture_work()','EXECUTE') OR
     has_function_privilege('service_role','copilot_private.fence_work()','EXECUTE') THEN RAISE EXCEPTION 'Trigger function exposed'; END IF;
  IF has_function_privilege('authenticated','public.copilot_finalize_ingress(uuid,boolean)','EXECUTE') OR
     has_function_privilege('anon','public.copilot_finalize_ingress(uuid,boolean)','EXECUTE') OR
     NOT has_function_privilege('service_role','public.copilot_finalize_ingress(uuid,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Ingress completion must be service-only'; END IF;
END $$;
