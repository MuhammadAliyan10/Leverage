-- Direct Expo -> Neon Data API bridge. Functions are deliberately narrow: all
-- writes are authenticated, idempotent, validated by existing constraints,
-- and recorded in the same database transaction as their change-feed entry.
CREATE OR REPLACE FUNCTION public.mizan_sync_identity() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user_id text := auth.user_id()::text;
BEGIN
  IF v_user_id IS NULL OR v_user_id = '' THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('userId', v_user_id);
END $$;

CREATE OR REPLACE FUNCTION public.mizan_sync_changes(p_after bigint DEFAULT 0, p_limit integer DEFAULT 250) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user_id text := auth.user_id()::text; v_rows jsonb; v_count integer; v_next bigint;
BEGIN
  IF v_user_id IS NULL OR v_user_id = '' THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF p_after < 0 OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'invalid sync page' USING ERRCODE='22023'; END IF;
  WITH page AS (
    SELECT "cursor", "entityType", "entityId", "revision", "payload", "createdAt"
    FROM public."ChangeLog" WHERE "userId"=v_user_id AND "cursor">p_after
    ORDER BY "cursor" ASC LIMIT p_limit + 1
  ), visible AS (SELECT * FROM page ORDER BY "cursor" ASC LIMIT p_limit)
  SELECT count(*), COALESCE(max("cursor"),p_after),
    COALESCE(jsonb_agg(jsonb_build_object(
      'sequence',"cursor"::text,'entityType',"entityType",'entityId',"entityId",
      'revision',"revision",'payload',"payload",'createdAt',"createdAt"
    ) ORDER BY "cursor" ASC),'[]'::jsonb)
  INTO v_count,v_next,v_rows FROM visible;
  RETURN jsonb_build_object('data',v_rows,'nextCursor',v_next::text,
    'hasMore',EXISTS(SELECT 1 FROM public."ChangeLog" WHERE "userId"=v_user_id AND "cursor">v_next));
END $$;

CREATE OR REPLACE FUNCTION public.mizan_apply_mutation(
  p_operation text, p_entity_id text, p_payload jsonb, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id text := auth.user_id()::text;
  v_email text; v_name text; v_hash text; v_existing public."MutationReceipt"%ROWTYPE;
  v_cursor bigint; v_revision integer; v_id text; v_response jsonb; v_type text;
  v_amount bigint; v_account_id text; v_to_account_id text;
BEGIN
  IF v_user_id IS NULL OR v_user_id = '' THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE='22023'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'invalid payload' USING ERRCODE='22023'; END IF;
  v_hash := md5(p_operation || ':' || p_payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id || ':' || p_idempotency_key,0));
  SELECT * INTO v_existing FROM public."MutationReceipt" WHERE "userId"=v_user_id AND "idempotencyKey"=p_idempotency_key;
  IF FOUND THEN
    IF v_existing."requestHash"<>v_hash OR v_existing."mutationType"<>p_operation THEN RAISE EXCEPTION 'idempotency key reused with different request' USING ERRCODE='23505'; END IF;
    RETURN v_existing."response";
  END IF;

  SELECT email,name INTO v_email,v_name FROM neon_auth."user" WHERE id=v_user_id LIMIT 1;
  IF v_email IS NULL THEN RAISE EXCEPTION 'Neon Auth user not found' USING ERRCODE='28000'; END IF;
  INSERT INTO public."User" (id,name,email,"updatedAt") VALUES (v_user_id,COALESCE(v_name,'Mizan user'),v_email,now())
  ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,"updatedAt"=now();

  IF p_operation='account.create' THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    IF v_id IS NULL OR p_payload->>'name' IS NULL OR p_payload->>'type' NOT IN ('cash','bank','wallet','savings') OR p_payload->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR') THEN RAISE EXCEPTION 'invalid account' USING ERRCODE='22023'; END IF;
    INSERT INTO public."FinanceAccount" (id,"userId",name,type,currency,"openingBalanceMinor","updatedAt")
      VALUES (v_id,v_user_id,p_payload->>'name',p_payload->>'type',p_payload->>'currency',COALESCE((p_payload->>'openingBalanceMinor')::bigint,0),now())
      RETURNING revision INTO v_revision;
    v_response := jsonb_build_object('data',jsonb_build_object('id',v_id,'revision',v_revision,'name',p_payload->>'name','type',p_payload->>'type','currency',p_payload->>'currency','openingBalanceMinor',COALESCE(p_payload->>'openingBalanceMinor','0'),'archivedAt',null));
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'account',v_id,v_revision,v_response->'data');
  ELSIF p_operation='account.update' THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    UPDATE public."FinanceAccount" SET name=p_payload->>'name',type=p_payload->>'type',revision=revision+1,"updatedAt"=now()
      WHERE id=v_id AND "userId"=v_user_id AND revision=(p_payload->>'expectedRevision')::integer AND "archivedAt" IS NULL
      RETURNING revision INTO v_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'account revision conflict' USING ERRCODE='40001'; END IF;
    SELECT jsonb_build_object('id',id,'revision',revision,'name',name,'type',type,'currency',currency,'openingBalanceMinor',"openingBalanceMinor"::text,'archivedAt',"archivedAt") INTO v_response FROM public."FinanceAccount" WHERE id=v_id AND "userId"=v_user_id;
    v_response := jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'account',v_id,v_revision,v_response->'data');
  ELSIF p_operation='account.archive' THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    UPDATE public."FinanceAccount" SET "archivedAt"=now(),revision=revision+1,"updatedAt"=now()
      WHERE id=v_id AND "userId"=v_user_id AND "archivedAt" IS NULL RETURNING revision INTO v_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='23514'; END IF;
    SELECT jsonb_build_object('id',id,'revision',revision,'name',name,'type',type,'currency',currency,'openingBalanceMinor',"openingBalanceMinor"::text,'archivedAt',"archivedAt") INTO v_response FROM public."FinanceAccount" WHERE id=v_id AND "userId"=v_user_id;
    v_response := jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'account',v_id,v_revision,v_response->'data');
  ELSIF p_operation='transaction.create' THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    v_type := p_payload->>'type';
    v_amount := (p_payload->>'amountMinor')::bigint;
    v_account_id := p_payload->>'accountId'; v_to_account_id := p_payload->>'toAccountId';
    IF v_id IS NULL OR v_amount<=0 OR v_type NOT IN ('income','expense','transfer','refund','reversal') OR p_payload->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR') THEN RAISE EXCEPTION 'invalid transaction' USING ERRCODE='22023'; END IF;
    INSERT INTO public."FinanceTransaction" (id,"userId","amountMinor",currency,type,"classificationId","categoryLabel","accountId","toAccountId","occurredAt",note,"paymentMethod","sourceName","sourceAmountMinor","sourceCurrency","exchangeRate","referenceNumber","taxStatus","taxYear","refundOfId","reversalOfId","correctionOfId")
      VALUES (v_id,v_user_id,v_amount,p_payload->>'currency',v_type,p_payload->>'classificationId',p_payload->>'categoryLabel',v_account_id,v_to_account_id,(p_payload->>'occurredAt')::timestamp,p_payload->>'note',p_payload->>'paymentMethod',p_payload->>'sourceName',NULLIF(p_payload->>'sourceAmountMinor','')::bigint,p_payload->>'sourceCurrency',p_payload->>'exchangeRate',p_payload->>'referenceNumber',COALESCE(p_payload->>'taxStatus','unreviewed'),NULLIF(p_payload->>'taxYear','')::integer,p_payload->>'refundOfId',p_payload->>'reversalOfId',p_payload->>'correctionOfId');
    v_response := jsonb_build_object('data',jsonb_build_object('id',v_id,'revision',1,'amountMinor',v_amount::text,'currency',p_payload->>'currency','type',v_type,'classificationId',p_payload->>'classificationId','categoryLabel',p_payload->>'categoryLabel','accountId',v_account_id,'toAccountId',v_to_account_id,'occurredAt',p_payload->>'occurredAt','note',p_payload->>'note','paymentMethod',p_payload->>'paymentMethod','sourceName',p_payload->>'sourceName','sourceAmountMinor',p_payload->>'sourceAmountMinor','sourceCurrency',p_payload->>'sourceCurrency','exchangeRate',p_payload->>'exchangeRate','referenceNumber',p_payload->>'referenceNumber','taxStatus',COALESCE(p_payload->>'taxStatus','unreviewed'),'taxYear',p_payload->>'taxYear','refundOfId',p_payload->>'refundOfId','reversalOfId',p_payload->>'reversalOfId','correctionOfId',p_payload->>'correctionOfId','createdAt',now()));
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'transaction',v_id,1,v_response->'data');
  ELSE
    RAISE EXCEPTION 'unsupported cloud operation: %',p_operation USING ERRCODE='0A000';
  END IF;

  INSERT INTO public."MutationReceipt" (id,"userId","idempotencyKey","mutationType","requestHash",response,"transactionId")
    VALUES(gen_random_uuid(),v_user_id,p_idempotency_key,p_operation,v_hash,v_response,CASE WHEN p_operation='transaction.create' THEN v_id ELSE NULL END);
  RETURN v_response;
END $$;

REVOKE ALL ON FUNCTION public.mizan_sync_identity() FROM PUBLIC, anonymous;
REVOKE ALL ON FUNCTION public.mizan_sync_changes(bigint,integer) FROM PUBLIC, anonymous;
REVOKE ALL ON FUNCTION public.mizan_apply_mutation(text,text,jsonb,text) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.mizan_sync_identity() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_sync_changes(bigint,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_apply_mutation(text,text,jsonb,text) TO authenticated;

-- Data API clients cannot read or write base tables directly. The RPCs above
-- are the only mobile write surface; RLS remains enabled as defense in depth.
REVOKE ALL ON TABLE public."User", public."FinanceAccount", public."FinanceTransaction",
  public."Budget", public."SavingsGoal", public."SavingsGoalEvent", public."EmergencyFundConfig",
  public."EmergencyFundEvent", public."RecurringSchedule", public."ScheduleOccurrence",
  public."MutationReceipt", public."ChangeLog" FROM PUBLIC, anonymous, authenticated;

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."FinanceAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."FinanceTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SavingsGoal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SavingsGoalEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."EmergencyFundConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."EmergencyFundEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RecurringSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ScheduleOccurrence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MutationReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChangeLog" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mizan_user_owns_User" ON public."User" FOR ALL TO authenticated
  USING (id=auth.user_id()::text) WITH CHECK (id=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_FinanceAccount" ON public."FinanceAccount" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_FinanceTransaction" ON public."FinanceTransaction" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_Budget" ON public."Budget" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_SavingsGoal" ON public."SavingsGoal" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_SavingsGoalEvent" ON public."SavingsGoalEvent" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_EmergencyFundConfig" ON public."EmergencyFundConfig" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_EmergencyFundEvent" ON public."EmergencyFundEvent" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_RecurringSchedule" ON public."RecurringSchedule" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_ScheduleOccurrence" ON public."ScheduleOccurrence" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_MutationReceipt" ON public."MutationReceipt" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
CREATE POLICY "mizan_user_owns_ChangeLog" ON public."ChangeLog" FOR ALL TO authenticated
  USING ("userId"=auth.user_id()::text) WITH CHECK ("userId"=auth.user_id()::text);
