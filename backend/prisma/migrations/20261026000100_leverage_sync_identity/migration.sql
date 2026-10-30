-- Product-facing identity RPC name. Keep the legacy function in place for
-- already-installed clients; both entry points perform the same authenticated
-- lookup and return no data beyond the verified identity.
CREATE OR REPLACE FUNCTION public.leverage_sync_identity() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user_id text := auth.user_id()::text;
BEGIN
  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  RETURN jsonb_build_object('userId', v_user_id);
END $$;

REVOKE ALL ON FUNCTION public.leverage_sync_identity() FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.leverage_sync_identity() TO authenticated;
