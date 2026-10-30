-- Fix Neon Auth user lookup: Neon Auth stores user.id as UUID while the
-- app finance tables intentionally use text IDs. Compare as text to avoid
-- PostgreSQL's unsupported uuid = text operator without changing stored data.
CREATE OR REPLACE FUNCTION public.mizan_apply_mutation(
  p_operation text, p_entity_id text, p_payload jsonb, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id text := auth.user_id()::text;
  v_email text; v_name text; v_hash text; v_existing public."MutationReceipt"%ROWTYPE;
  v_cursor bigint; v_revision integer; v_id text; v_response jsonb; v_type text;
  v_amount bigint; v_account_id text; v_to_account_id text; v_created timestamptz := now(); v_change_revision integer;
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

  SELECT email,name INTO v_email,v_name FROM neon_auth."user" WHERE id::text=v_user_id LIMIT 1;
  IF v_email IS NULL THEN RAISE EXCEPTION 'Neon Auth user not found' USING ERRCODE='28000'; END IF;
  INSERT INTO public."User" (id,name,email,"updatedAt") VALUES (v_user_id,COALESCE(v_name,'Mizan user'),v_email,now())
  ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,"updatedAt"=now();

  IF p_operation='account.create' THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    IF v_id IS NULL OR p_payload->>'name' IS NULL OR p_payload->>'type' NOT IN ('cash','bank','wallet','savings','investment','other') OR p_payload->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR') THEN RAISE EXCEPTION 'invalid account' USING ERRCODE='22023'; END IF;
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
    IF (v_type='income' AND (p_payload->>'classificationId' IS NULL OR p_payload->>'classificationId' NOT IN ('salary','freelance','business_revenue','family_gift','foreign_remittance','investment_return','rental_income','other_income','debt_borrowing','debt_receivable_payment','debt_settlement','asset_sale_proceeds','investment_sale_proceeds','investment_dividend')))
      OR (v_type='expense' AND (p_payload->>'classificationId' IS NULL OR p_payload->>'classificationId' NOT IN ('food','transport','bills','utilities','shopping','health','bank_fee','housing','other_expense','debt_lending','debt_principal_repayment','debt_interest','debt_settlement','asset_purchase','investment_purchase')))
      OR (v_type='transfer' AND p_payload->>'classificationId'<>'internal_transfer')
      OR (v_type='refund' AND (p_payload->>'classificationId'<>'expense_refund' OR p_payload->>'refundOfId' IS NULL))
      OR (v_type='reversal' AND (p_payload->>'classificationId'<>'correction_reversal' OR p_payload->>'reversalOfId' IS NULL)) THEN
      RAISE EXCEPTION 'unsupported transaction classification' USING ERRCODE='22023';
    END IF;
    INSERT INTO public."FinanceTransaction" (id,"userId","amountMinor",currency,type,"classificationId","categoryLabel","accountId","toAccountId","occurredAt",note,"paymentMethod","sourceName","sourceAmountMinor","sourceCurrency","exchangeRate","referenceNumber","taxStatus","taxYear","refundOfId","reversalOfId","correctionOfId")
      VALUES (v_id,v_user_id,v_amount,p_payload->>'currency',v_type,p_payload->>'classificationId',p_payload->>'categoryLabel',v_account_id,v_to_account_id,(p_payload->>'occurredAt')::timestamp,p_payload->>'note',p_payload->>'paymentMethod',p_payload->>'sourceName',NULLIF(p_payload->>'sourceAmountMinor','')::bigint,p_payload->>'sourceCurrency',p_payload->>'exchangeRate',p_payload->>'referenceNumber',COALESCE(p_payload->>'taxStatus','unreviewed'),NULLIF(p_payload->>'taxYear','')::integer,p_payload->>'refundOfId',p_payload->>'reversalOfId',p_payload->>'correctionOfId');
    v_response := jsonb_build_object('data',jsonb_build_object('id',v_id,'revision',1,'amountMinor',v_amount::text,'currency',p_payload->>'currency','type',v_type,'classificationId',p_payload->>'classificationId','categoryLabel',p_payload->>'categoryLabel','accountId',v_account_id,'toAccountId',v_to_account_id,'occurredAt',p_payload->>'occurredAt','note',p_payload->>'note','paymentMethod',p_payload->>'paymentMethod','sourceName',p_payload->>'sourceName','sourceAmountMinor',p_payload->>'sourceAmountMinor','sourceCurrency',p_payload->>'sourceCurrency','exchangeRate',p_payload->>'exchangeRate','referenceNumber',p_payload->>'referenceNumber','taxStatus',COALESCE(p_payload->>'taxStatus','unreviewed'),'taxYear',p_payload->>'taxYear','refundOfId',p_payload->>'refundOfId','reversalOfId',p_payload->>'reversalOfId','correctionOfId',p_payload->>'correctionOfId','createdAt',now()));
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'transaction',v_id,1,v_response->'data');
  ELSIF p_operation IN ('budget.create','budget.revise','budget.archive') THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    IF p_operation='budget.archive' THEN
      UPDATE public."Budget" SET "archivedAt"=v_created,"changeRevision"="changeRevision"+1 WHERE id=v_id::uuid AND "userId"=v_user_id AND "archivedAt" IS NULL AND "supersededAt" IS NULL RETURNING revision,"changeRevision" INTO v_revision,v_change_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'budget unavailable' USING ERRCODE='23514'; END IF;
    ELSIF p_operation='budget.revise' THEN
      v_id := COALESCE(p_payload->>'id',p_entity_id);
      IF p_payload->>'budgetId' IS NULL OR (p_payload->>'expectedRevision')::integer IS NULL THEN RAISE EXCEPTION 'invalid budget revision' USING ERRCODE='22023'; END IF;
      UPDATE public."Budget" SET "supersededAt"=v_created WHERE id=(p_payload->>'budgetId')::uuid AND "userId"=v_user_id AND revision=(p_payload->>'expectedRevision')::integer AND "supersededAt" IS NULL AND "archivedAt" IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'budget revision conflict' USING ERRCODE='40001'; END IF;
      v_revision := (p_payload->>'expectedRevision')::integer+1;
      INSERT INTO public."Budget" (id,"userId","categoryId","amountMinor",currency,"periodStart","periodEnd","rolloverPolicy",revision,"changeRevision","supersedesId","createdAt")
      VALUES(v_id::uuid,v_user_id,p_payload->>'categoryId',(p_payload->>'amountMinor')::bigint,p_payload->>'currency',(p_payload->>'periodStart')::date,(p_payload->>'periodEnd')::date,p_payload->>'rolloverPolicy',v_revision,v_revision,(p_payload->>'budgetId')::uuid,v_created);
    ELSE
      v_revision := 1;
      INSERT INTO public."Budget" (id,"userId","categoryId","amountMinor",currency,"periodStart","periodEnd","rolloverPolicy","createdAt")
      VALUES(v_id::uuid,v_user_id,p_payload->>'categoryId',(p_payload->>'amountMinor')::bigint,p_payload->>'currency',(p_payload->>'periodStart')::date,(p_payload->>'periodEnd')::date,p_payload->>'rolloverPolicy',v_created);
    END IF;
    SELECT jsonb_build_object('id',id,'revision',revision,'categoryId',"categoryId",'amountMinor',"amountMinor"::text,'currency',currency,'periodStart',"periodStart"::text,'periodEnd',"periodEnd"::text,'rolloverPolicy',"rolloverPolicy",'supersedesId',"supersedesId",'supersededAt',"supersededAt",'archivedAt',"archivedAt",'createdAt',"createdAt") INTO v_response FROM public."Budget" WHERE id=v_id::uuid AND "userId"=v_user_id;
    IF p_operation='budget.archive' THEN v_response := jsonb_set(v_response,'{archivedAt}',to_jsonb(v_created)); END IF;
    v_response := jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'budget',v_id,COALESCE(v_change_revision,v_revision),v_response->'data');
  ELSIF p_operation IN ('saving.goal.create','saving.goal.update') THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    IF p_operation='saving.goal.create' THEN
      INSERT INTO public."SavingsGoal" (id,"userId",name,"targetMinor",currency,"targetDate",status,"completedAt","archivedAt","createdAt","updatedAt")
      VALUES(v_id::uuid,v_user_id,p_payload->>'name',(p_payload->>'targetMinor')::bigint,p_payload->>'currency',NULLIF(p_payload->>'targetDate','')::date,COALESCE(p_payload->>'status','active'),NULLIF(p_payload->>'completedAt','')::timestamptz,NULLIF(p_payload->>'archivedAt','')::timestamptz,COALESCE(NULLIF(p_payload->>'createdAt','')::timestamptz,v_created),COALESCE(NULLIF(p_payload->>'updatedAt','')::timestamptz,v_created)) RETURNING revision INTO v_revision;
    ELSE
      UPDATE public."SavingsGoal" SET name=p_payload->>'name',"targetMinor"=(p_payload->>'targetMinor')::bigint,"targetDate"=NULLIF(p_payload->>'targetDate','')::date,status=COALESCE(p_payload->>'status',status),"completedAt"=NULLIF(p_payload->>'completedAt','')::timestamptz,"archivedAt"=NULLIF(p_payload->>'archivedAt','')::timestamptz,revision=revision+1,"updatedAt"=COALESCE(NULLIF(p_payload->>'updatedAt','')::timestamptz,v_created)
      WHERE id=v_id::uuid AND "userId"=v_user_id AND "updatedAt"=(p_payload->>'expectedUpdatedAt')::timestamptz RETURNING revision INTO v_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'savings goal revision conflict' USING ERRCODE='40001'; END IF;
    END IF;
    SELECT jsonb_build_object('id',id,'revision',revision,'name',name,'targetMinor',"targetMinor"::text,'currency',currency,'targetDate',"targetDate"::text,'status',status,'completedAt',"completedAt",'archivedAt',"archivedAt",'createdAt',"createdAt",'updatedAt',"updatedAt") INTO v_response FROM public."SavingsGoal" WHERE id=v_id::uuid AND "userId"=v_user_id;
    v_response:=jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'savings_goal',v_id,v_revision,v_response->'data');
  ELSIF p_operation IN ('saving.goal.event','emergency.event') THEN
    v_id:=COALESCE(p_payload->>'id',p_entity_id); v_type:=CASE WHEN p_operation='saving.goal.event' THEN 'savings_goal_event' ELSE 'emergency_event' END;
    IF p_operation='saving.goal.event' THEN
      INSERT INTO public."SavingsGoalEvent" (id,"userId","goalId","eventType","amountMinor",currency,"accountId","transactionId","idempotencyKey","eventDate",note,"createdAt")
      VALUES(v_id::uuid,v_user_id,(p_payload->>'goalId')::uuid,p_payload->>'eventType',(p_payload->>'amountMinor')::bigint,p_payload->>'currency',p_payload->>'accountId',p_payload->>'transactionId',COALESCE(p_payload->>'idempotencyKey',p_idempotency_key),(p_payload->>'eventDate')::timestamptz,COALESCE(p_payload->>'note',''),COALESCE(NULLIF(p_payload->>'createdAt','')::timestamptz,v_created));
      v_response:=jsonb_build_object('data',jsonb_build_object('id',v_id,'goalId',p_payload->>'goalId','eventType',p_payload->>'eventType','amountMinor',p_payload->>'amountMinor','currency',p_payload->>'currency','accountId',p_payload->>'accountId','transactionId',p_payload->>'transactionId','idempotencyKey',COALESCE(p_payload->>'idempotencyKey',p_idempotency_key),'eventDate',p_payload->>'eventDate','note',COALESCE(p_payload->>'note',''),'createdAt',COALESCE(p_payload->>'createdAt',v_created::text)));
    ELSE
      INSERT INTO public."EmergencyFundEvent" (id,"userId","eventType","amountMinor",currency,"accountId","transactionId","idempotencyKey","eventDate",note,"createdAt")
      VALUES(v_id::uuid,v_user_id,p_payload->>'eventType',(p_payload->>'amountMinor')::bigint,p_payload->>'currency',p_payload->>'accountId',p_payload->>'transactionId',COALESCE(p_payload->>'idempotencyKey',p_idempotency_key),(p_payload->>'eventDate')::timestamptz,COALESCE(p_payload->>'note',''),COALESCE(NULLIF(p_payload->>'createdAt','')::timestamptz,v_created));
      v_response:=jsonb_build_object('data',jsonb_build_object('id',v_id,'eventType',p_payload->>'eventType','amountMinor',p_payload->>'amountMinor','currency',p_payload->>'currency','accountId',p_payload->>'accountId','transactionId',p_payload->>'transactionId','idempotencyKey',COALESCE(p_payload->>'idempotencyKey',p_idempotency_key),'eventDate',p_payload->>'eventDate','note',COALESCE(p_payload->>'note',''),'createdAt',COALESCE(p_payload->>'createdAt',v_created::text)));
    END IF;
    v_revision:=1;
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,v_type,v_id,v_revision,v_response->'data');
  ELSIF p_operation='emergency.config.save' THEN
    INSERT INTO public."EmergencyFundConfig" ("userId",currency,"coverageMonths","essentialMonthlyMinor",revision,"updatedAt") VALUES(v_user_id,p_payload->>'currency',(p_payload->>'coverageMonths')::integer,(p_payload->>'essentialMonthlyMinor')::bigint,1,v_created)
    ON CONFLICT ("userId") DO UPDATE SET currency=EXCLUDED.currency,"coverageMonths"=EXCLUDED."coverageMonths","essentialMonthlyMinor"=EXCLUDED."essentialMonthlyMinor",revision=public."EmergencyFundConfig".revision+1,"updatedAt"=v_created RETURNING revision INTO v_revision;
    SELECT jsonb_build_object('currency',currency,'coverageMonths',"coverageMonths",'essentialMonthlyMinor',"essentialMonthlyMinor"::text,'revision',revision,'updatedAt',"updatedAt") INTO v_response FROM public."EmergencyFundConfig" WHERE "userId"=v_user_id;
    v_response:=jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'emergency_config',v_user_id,v_revision,v_response->'data');
  ELSIF p_operation IN ('recurring.schedule.create','recurring.schedule.update') THEN
    v_id:=COALESCE(p_payload->>'id',p_entity_id);
    IF p_operation='recurring.schedule.create' THEN
      INSERT INTO public."RecurringSchedule" (id,"userId","scheduleType",name,"amountMinor",currency,"classificationId","accountId","toAccountId","billId",frequency,"startDate","endDate","nextDueDate",status,"createdAt","updatedAt")
      VALUES(v_id,v_user_id,p_payload->>'scheduleType',p_payload->>'name',(p_payload->>'amountMinor')::bigint,p_payload->>'currency',p_payload->>'classificationId',p_payload->>'accountId',p_payload->>'toAccountId',p_payload->>'billId',p_payload->>'frequency',(p_payload->>'startDate')::date,NULLIF(p_payload->>'endDate','')::date,(p_payload->>'nextDueDate')::date,p_payload->>'status',COALESCE(NULLIF(p_payload->>'createdAt','')::timestamptz,v_created),COALESCE(NULLIF(p_payload->>'updatedAt','')::timestamptz,v_created)) RETURNING revision INTO v_revision;
    ELSE
      UPDATE public."RecurringSchedule" SET "scheduleType"=p_payload->>'scheduleType',name=p_payload->>'name',"amountMinor"=(p_payload->>'amountMinor')::bigint,currency=p_payload->>'currency',"classificationId"=p_payload->>'classificationId',"accountId"=p_payload->>'accountId',"toAccountId"=p_payload->>'toAccountId',"billId"=p_payload->>'billId',frequency=p_payload->>'frequency',"startDate"=(p_payload->>'startDate')::date,"endDate"=NULLIF(p_payload->>'endDate','')::date,"nextDueDate"=(p_payload->>'nextDueDate')::date,status=p_payload->>'status',revision=revision+1,"updatedAt"=COALESCE(NULLIF(p_payload->>'updatedAt','')::timestamptz,v_created)
      WHERE id=v_id::uuid AND "userId"=v_user_id AND "updatedAt"=(p_payload->>'expectedUpdatedAt')::timestamptz RETURNING revision INTO v_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'recurring schedule revision conflict' USING ERRCODE='40001'; END IF;
    END IF;
    SELECT jsonb_build_object('id',id,'scheduleType',"scheduleType",'name',name,'amountMinor',"amountMinor"::text,'currency',currency,'classificationId',"classificationId",'accountId',"accountId",'toAccountId',"toAccountId",'billId',"billId",'frequency',frequency,'startDate',"startDate"::text,'endDate',"endDate"::text,'nextDueDate',"nextDueDate"::text,'status',status,'revision',revision,'createdAt',"createdAt",'updatedAt',"updatedAt") INTO v_response FROM public."RecurringSchedule" WHERE id=v_id AND "userId"=v_user_id;
    v_response:=jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,'recurring_schedule',v_id,v_revision,v_response->'data');
  ELSIF p_operation IN ('schedule.occurrence.create','schedule.occurrence.resolve') THEN
    v_id:=COALESCE(p_payload->>'id',p_entity_id); v_type:='schedule_occurrence';
    IF p_operation='schedule.occurrence.create' THEN
      INSERT INTO public."ScheduleOccurrence" (id,"userId","scheduleId","occurrenceDate",status,"createdAt") VALUES(v_id,v_user_id,p_payload->>'scheduleId',(p_payload->>'occurrenceDate')::date,'pending',COALESCE(NULLIF(p_payload->>'createdAt','')::timestamptz,v_created)) RETURNING revision INTO v_revision;
    ELSE
      v_id:=COALESCE(p_entity_id,p_payload->>'id');
      UPDATE public."ScheduleOccurrence" SET status=p_payload->>'status',"transactionId"=p_payload->>'transactionId',"resolvedAt"=(p_payload->>'resolvedAt')::timestamptz,revision=revision+1
      WHERE id=v_id AND "userId"=v_user_id AND "scheduleId"=p_payload->>'scheduleId' AND status='pending' AND revision=(p_payload->>'expectedRevision')::integer RETURNING revision INTO v_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'schedule occurrence revision conflict' USING ERRCODE='40001'; END IF;
    END IF;
    SELECT jsonb_build_object('id',id,'scheduleId',"scheduleId",'occurrenceDate',"occurrenceDate"::text,'status',status,'transactionId',"transactionId",'revision',revision,'createdAt',"createdAt",'resolvedAt',"resolvedAt") INTO v_response FROM public."ScheduleOccurrence" WHERE id=v_id AND "userId"=v_user_id;
    v_response:=jsonb_build_object('data',v_response);
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,v_type,v_id,v_revision,v_response->'data');
  ELSIF p_operation IN ('domain.create','domain.update') THEN
    v_id := COALESCE(p_payload->>'id',p_entity_id);
    v_type := p_payload->>'entityType';
    IF v_type NOT IN ('bill','bill_payment','bill_payment_correction','debt','debt_event','debt_interest_event','debt_event_correction','debt_repayment_schedule','asset','asset_valuation','asset_activity','investment_portfolio','investment_holding','investment_event','investment_price')
      OR v_id IS NULL OR jsonb_typeof(p_payload->'data')<>'object' OR p_payload->'data'->>'id' IS DISTINCT FROM v_id
      OR p_payload->>'parentType' IS NOT NULL AND p_payload->>'parentId' IS NULL THEN
      RAISE EXCEPTION 'invalid finance domain record' USING ERRCODE='22023';
    END IF;
    IF (v_type IN ('bill','debt','asset','investment_portfolio') AND p_operation<>'domain.create')
      OR (v_type='debt_repayment_schedule' AND p_operation='domain.update') THEN
      IF p_payload->>'expectedRevision' IS NULL THEN RAISE EXCEPTION 'domain revision is required' USING ERRCODE='22023'; END IF;
      UPDATE public."FinanceDomainRecord" SET payload=p_payload->'data',"accountId"=p_payload->>'accountId',"transactionId"=p_payload->>'transactionId',"scheduleId"=p_payload->>'scheduleId',revision=revision+1,"updatedAt"=v_created
        WHERE id=v_id AND "userId"=v_user_id AND "entityType"=v_type AND revision=(p_payload->>'expectedRevision')::integer;
      IF NOT FOUND THEN RAISE EXCEPTION 'finance domain revision conflict' USING ERRCODE='40001'; END IF;
    ELSE
      IF p_operation<>'domain.create' THEN RAISE EXCEPTION 'append-only finance domain entries cannot be updated' USING ERRCODE='23514'; END IF;
      IF (v_type='bill' AND (COALESCE((p_payload->'data'->>'amountMinor')::bigint,0)<=0 OR p_payload->'data'->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR') OR length(btrim(COALESCE(p_payload->'data'->>'name','')))=0))
        OR (v_type='debt' AND (COALESCE((p_payload->'data'->>'principalMinor')::bigint,0)<=0 OR p_payload->'data'->>'direction' NOT IN ('borrowed','lent') OR p_payload->'data'->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR')))
        OR (v_type='asset' AND (COALESCE((p_payload->'data'->>'purchaseValueMinor')::bigint,0)<=0 OR COALESCE((p_payload->'data'->>'ownershipBps')::integer,0) NOT BETWEEN 1 AND 10000 OR p_payload->'data'->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR')))
        OR (v_type='investment_portfolio' AND p_payload->'data'->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR'))
        OR (v_type='bill_payment' AND COALESCE((p_payload->'data'->>'amountMinor')::bigint,0)<=0)
        OR (v_type='debt_event' AND (COALESCE((p_payload->'data'->>'principalMinor')::bigint,0)<0 OR COALESCE((p_payload->'data'->>'interestMinor')::bigint,0)<0 OR COALESCE((p_payload->'data'->>'principalMinor')::bigint,0)+COALESCE((p_payload->'data'->>'interestMinor')::bigint,0)<=0))
        OR (v_type='investment_event' AND p_payload->'data'->>'eventType' NOT IN ('buy','sell','split','dividend')) THEN
        RAISE EXCEPTION 'invalid finance domain values' USING ERRCODE='22023';
      END IF;
      IF v_type='bill_payment_correction' AND (NOT EXISTS(SELECT 1 FROM public."FinanceDomainRecord" WHERE "userId"=v_user_id AND "entityType"='bill_payment' AND id=p_payload->'data'->>'originalPaymentId') OR (p_payload->'data'->>'replacementPaymentId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."FinanceDomainRecord" WHERE "userId"=v_user_id AND "entityType"='bill_payment' AND id=p_payload->'data'->>'replacementPaymentId'))) THEN
        RAISE EXCEPTION 'bill correction references unavailable payment history' USING ERRCODE='23503';
      END IF;
      IF v_type='debt_event_correction' AND (NOT EXISTS(SELECT 1 FROM public."FinanceDomainRecord" WHERE "userId"=v_user_id AND "entityType"='debt_event' AND id=p_payload->'data'->>'originalEventId') OR (p_payload->'data'->>'replacementEventId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."FinanceDomainRecord" WHERE "userId"=v_user_id AND "entityType"='debt_event' AND id=p_payload->'data'->>'replacementEventId'))) THEN
        RAISE EXCEPTION 'debt correction references unavailable event history' USING ERRCODE='23503';
      END IF;
      IF v_type='bill_payment' AND NOT EXISTS(
        SELECT 1 FROM public."FinanceDomainRecord" b JOIN public."FinanceTransaction" t ON t.id=p_payload->>'transactionId' AND t."userId"=v_user_id
        WHERE b.id=p_payload->>'parentId' AND b."userId"=v_user_id AND b."entityType"='bill' AND t."accountId"=b."accountId"
          AND t.type='expense' AND t."amountMinor"=(p_payload->'data'->>'amountMinor')::bigint
          AND t."classificationId"=b.payload->>'categoryId' AND t.currency=b.payload->>'currency') THEN
        RAISE EXCEPTION 'bill payment transaction does not match bill' USING ERRCODE='23514';
      END IF;
      IF v_type='debt_event' AND NOT EXISTS(
        SELECT 1 FROM public."FinanceDomainRecord" d JOIN public."FinanceTransaction" t ON t.id=p_payload->>'transactionId' AND t."userId"=v_user_id
        WHERE d.id=p_payload->>'parentId' AND d."userId"=v_user_id AND d."entityType"='debt' AND t."accountId"=p_payload->>'accountId'
          AND t."amountMinor"=CASE WHEN p_payload->'data'->>'eventType'='interest' THEN (p_payload->'data'->>'interestMinor')::bigint ELSE ((p_payload->'data'->>'principalMinor')::bigint+(p_payload->'data'->>'interestMinor')::bigint) END
          AND t.type=CASE WHEN p_payload->'data'->>'eventType'='borrow' THEN 'income' WHEN p_payload->'data'->>'eventType'='receivable_payment' AND d.payload->>'direction'='lent' THEN 'income' WHEN p_payload->'data'->>'eventType'='settlement' AND d.payload->>'direction'='lent' THEN 'income' ELSE 'expense' END
          AND t."classificationId"=CASE WHEN p_payload->'data'->>'eventType'='borrow' THEN 'debt_borrowing' WHEN p_payload->'data'->>'eventType'='lend' THEN 'debt_lending' WHEN p_payload->'data'->>'eventType'='principal_repayment' THEN 'debt_principal_repayment' WHEN p_payload->'data'->>'eventType'='receivable_payment' THEN 'debt_receivable_payment' WHEN p_payload->'data'->>'eventType'='interest' THEN 'debt_interest' ELSE 'debt_settlement' END
          AND t.currency=d.payload->>'currency') THEN
        RAISE EXCEPTION 'debt event transaction does not match debt' USING ERRCODE='23514';
      END IF;
      IF v_type='asset_activity' AND (
        p_payload->'data'->>'eventType' NOT IN ('acquisition','disposal')
        OR (p_payload->'data'->>'eventType'='acquisition' AND p_payload->>'transactionId' IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public."FinanceDomainRecord" a JOIN public."FinanceTransaction" t ON t.id=p_payload->>'transactionId' AND t."userId"=v_user_id
          WHERE a.id=p_payload->>'parentId' AND a."userId"=v_user_id AND a."entityType"='asset' AND t."accountId"=p_payload->>'accountId'
            AND t.type='expense' AND t."classificationId"='asset_purchase' AND t."amountMinor"=(p_payload->'data'->>'costBasisMinor')::bigint AND t.currency=a.payload->>'currency'))
        OR (p_payload->'data'->>'eventType'='disposal' AND COALESCE((p_payload->'data'->>'proceedsMinor')::bigint,0)>0 AND NOT EXISTS(
          SELECT 1 FROM public."FinanceDomainRecord" a JOIN public."FinanceTransaction" t ON t.id=p_payload->>'transactionId' AND t."userId"=v_user_id
          WHERE a.id=p_payload->>'parentId' AND a."userId"=v_user_id AND a."entityType"='asset' AND t."accountId"=p_payload->>'accountId'
            AND t.type='income' AND t."classificationId"='asset_sale_proceeds' AND t."amountMinor"=(p_payload->'data'->>'proceedsMinor')::bigint AND t.currency=a.payload->>'currency'))
        OR (p_payload->'data'->>'eventType'='disposal' AND COALESCE((p_payload->'data'->>'proceedsMinor')::bigint,0)=0 AND p_payload->>'transactionId' IS NOT NULL)
        OR (p_payload->>'transactionId' IS NULL AND p_payload->>'accountId' IS NOT NULL)
      ) THEN RAISE EXCEPTION 'asset activity transaction does not match asset activity' USING ERRCODE='23514'; END IF;
      IF v_type='investment_event' AND (
        (p_payload->'data'->>'eventType' IN ('buy','sell','dividend') AND NOT EXISTS(
          SELECT 1 FROM public."FinanceDomainRecord" h JOIN public."FinanceDomainRecord" p ON p.id=h."parentId" AND p."userId"=v_user_id AND p."entityType"='investment_portfolio'
          JOIN public."FinanceTransaction" t ON t.id=p_payload->>'transactionId' AND t."userId"=v_user_id
          WHERE h.id=p_payload->>'parentId' AND h."userId"=v_user_id AND h."entityType"='investment_holding'
            AND t."accountId"=p.payload->>'cashAccountId' AND t.currency=p.payload->>'currency'
            AND t.type=CASE WHEN p_payload->'data'->>'eventType'='buy' THEN 'expense' ELSE 'income' END
            AND t."classificationId"=CASE WHEN p_payload->'data'->>'eventType'='buy' THEN 'investment_purchase' WHEN p_payload->'data'->>'eventType'='sell' THEN 'investment_sale_proceeds' ELSE 'investment_dividend' END
            AND t."amountMinor"=CASE WHEN p_payload->'data'->>'eventType'='buy' THEN (p_payload->'data'->>'amountMinor')::bigint+(p_payload->'data'->>'feeMinor')::bigint WHEN p_payload->'data'->>'eventType'='sell' THEN (p_payload->'data'->>'amountMinor')::bigint-(p_payload->'data'->>'feeMinor')::bigint ELSE (p_payload->'data'->>'amountMinor')::bigint END))
        OR (p_payload->'data'->>'eventType'='split' AND p_payload->>'transactionId' IS NOT NULL)
      ) THEN RAISE EXCEPTION 'investment event transaction does not match investment event' USING ERRCODE='23514'; END IF;
      INSERT INTO public."FinanceDomainRecord" (id,"userId","entityType","parentType","parentId","accountId","transactionId","scheduleId",payload,"updatedAt")
      VALUES(v_id,v_user_id,v_type,p_payload->>'parentType',p_payload->>'parentId',p_payload->>'accountId',p_payload->>'transactionId',p_payload->>'scheduleId',p_payload->'data',v_created);
    END IF;
    SELECT revision INTO v_revision FROM public."FinanceDomainRecord" WHERE id=v_id AND "userId"=v_user_id AND "entityType"=v_type;
    v_response:=jsonb_build_object('data',jsonb_build_object('id',v_id,'entityType',v_type,'parentType',p_payload->>'parentType','parentId',p_payload->>'parentId','accountId',p_payload->>'accountId','transactionId',p_payload->>'transactionId','scheduleId',p_payload->>'scheduleId','data',p_payload->'data','revision',v_revision));
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_user_id RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog" (cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_user_id,v_type,v_id,v_revision,v_response->'data');
  ELSE
    RAISE EXCEPTION 'unsupported cloud operation: %',p_operation USING ERRCODE='0A000';
  END IF;

  INSERT INTO public."MutationReceipt" (id,"userId","idempotencyKey","mutationType","requestHash",response,"transactionId")
    VALUES(gen_random_uuid(),v_user_id,p_idempotency_key,p_operation,v_hash,v_response,CASE WHEN p_operation='transaction.create' THEN v_id ELSE NULL END);
  RETURN v_response;
END $$;

REVOKE ALL ON FUNCTION public.mizan_apply_mutation(text,text,jsonb,text) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.mizan_apply_mutation(text,text,jsonb,text) TO authenticated;
