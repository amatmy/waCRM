-- Schema privilege assertions; behavior and races are exercised by integration tests.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['copilot_answers','copilot_actions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Missing RLS on %',t;
    END IF;
    IF has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE')
      OR has_table_privilege('service_role','public.'||t,'INSERT,UPDATE,DELETE')
      OR has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Unexpected copilot table privilege on %',t;
    END IF;
    IF NOT has_table_privilege('authenticated','public.'||t,'SELECT') THEN
      RAISE EXCEPTION 'Missing account-RLS read grant on %',t;
    END IF;
  END LOOP;
END $$;
