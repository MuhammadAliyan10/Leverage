-- Reconcile only an account whose original, owner-scoped creation is already
-- present in the cloud. This never creates/updates an account or posts a ledger
-- transaction; it writes only the missing idempotency receipt after proof.
CREATE OR REPLACE FUNCTION public.mizan_reconcile_account_create(
  p_entity_id text,
  p_idempotency_key text,
  p_payload jsonb,
  p_expected_current_balance_minor text,
  p_commit boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id text := auth.user_id()::text;
  v_account public."FinanceAccount"%ROWTYPE;
  v_receipt public."MutationReceipt"%ROWTYPE;
  v_request_hash text;
  v_event_count integer := 0;
  v_matching_create_count integer := 0;
  v_current_balance bigint := 0;
  v_expected_balance bigint;
  v_receipt_status text := 'missing';
  v_account_matches boolean := false;
  v_eligible boolean := false;
  v_reason text;
  v_ack jsonb;
  v_evidence jsonb;
BEGIN
  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF p_entity_id IS NULL OR length(p_entity_id) NOT BETWEEN 1 AND 160
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_payload->>'id' IS DISTINCT FROM p_entity_id
     OR p_payload->>'name' IS NULL
     OR p_payload->>'type' NOT IN ('cash','bank','wallet','savings')
     OR p_payload->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR')
     OR COALESCE(p_payload->>'openingBalanceMinor','') !~ '^-?[0-9]+$'
     OR COALESCE(p_expected_current_balance_minor,'') !~ '^-?[0-9]+$' THEN
    RAISE EXCEPTION 'invalid account reconciliation request' USING ERRCODE='22023';
  END IF;
  v_expected_balance := p_expected_current_balance_minor::bigint;
  v_request_hash := md5('account.create:' || p_payload::text);

  -- Serialize with the normal mutation receipt lock. The preview remains
  -- read-only; commit repeats every check under this transaction lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id || ':' || p_idempotency_key, 0));

  SELECT * INTO v_account FROM public."FinanceAccount"
    WHERE id=p_entity_id AND "userId"=v_user_id;
  IF FOUND THEN
    v_account_matches := v_account.name=p_payload->>'name'
      AND v_account.type=p_payload->>'type'
      AND v_account.currency=p_payload->>'currency'
      AND v_account."openingBalanceMinor"=(p_payload->>'openingBalanceMinor')::bigint;

    SELECT COUNT(*), COUNT(*) FILTER (WHERE revision=1
      AND payload->>'id'=p_entity_id
      AND payload->>'name'=p_payload->>'name'
      AND payload->>'type'=p_payload->>'type'
      AND payload->>'currency'=p_payload->>'currency'
      AND payload->>'openingBalanceMinor'=p_payload->>'openingBalanceMinor')
      INTO v_event_count,v_matching_create_count
      FROM public."ChangeLog"
      WHERE "userId"=v_user_id AND "entityType"='account' AND "entityId"=p_entity_id;

    -- Account opening balances are stored on FinanceAccount. Cash movements
    -- are separate FinanceTransaction rows and are included in this balance.
    WITH events(account_id,delta) AS (
      SELECT t."accountId", CASE WHEN t.type IN ('income','refund') THEN t."amountMinor" ELSE -t."amountMinor" END
        FROM public."FinanceTransaction" t
        WHERE t."userId"=v_user_id AND t.type IN ('income','expense','refund') AND t."accountId"=p_entity_id
      UNION ALL
      SELECT t."accountId",-t."amountMinor" FROM public."FinanceTransaction" t
        WHERE t."userId"=v_user_id AND t.type='transfer' AND t."accountId"=p_entity_id
      UNION ALL
      SELECT t."toAccountId",t."amountMinor" FROM public."FinanceTransaction" t
        WHERE t."userId"=v_user_id AND t.type='transfer' AND t."toAccountId"=p_entity_id
      UNION ALL
      SELECT t."accountId", CASE original.type WHEN 'income' THEN -t."amountMinor" WHEN 'expense' THEN t."amountMinor" WHEN 'refund' THEN -t."amountMinor" WHEN 'transfer' THEN t."amountMinor" END
        FROM public."FinanceTransaction" t
        JOIN public."FinanceTransaction" original ON original.id=t."reversalOfId" AND original."userId"=t."userId"
        WHERE t."userId"=v_user_id AND t.type='reversal' AND t."accountId"=p_entity_id
          AND original.type IN ('income','expense','refund','transfer')
      UNION ALL
      SELECT t."toAccountId",-t."amountMinor" FROM public."FinanceTransaction" t
        JOIN public."FinanceTransaction" original ON original.id=t."reversalOfId" AND original."userId"=t."userId"
        WHERE t."userId"=v_user_id AND t.type='reversal' AND t."toAccountId"=p_entity_id AND original.type='transfer'
    )
    SELECT a."openingBalanceMinor"+COALESCE(SUM(e.delta),0) INTO v_current_balance
      FROM public."FinanceAccount" a LEFT JOIN events e ON e.account_id=a.id
      WHERE a.id=p_entity_id AND a."userId"=v_user_id
      GROUP BY a.id,a."openingBalanceMinor";
  END IF;

  SELECT * INTO v_receipt FROM public."MutationReceipt"
    WHERE "userId"=v_user_id AND "idempotencyKey"=p_idempotency_key;
  IF FOUND THEN
    IF v_receipt."mutationType"='account.create'
       AND v_receipt."requestHash"=v_request_hash
       AND v_receipt."transactionId" IS NULL
       AND v_receipt.response->'data'->>'id'=p_entity_id
       AND v_receipt.response->'data'->>'name'=p_payload->>'name'
       AND v_receipt.response->'data'->>'type'=p_payload->>'type'
       AND v_receipt.response->'data'->>'currency'=p_payload->>'currency'
       AND v_receipt.response->'data'->>'openingBalanceMinor'=p_payload->>'openingBalanceMinor' THEN
      v_receipt_status := 'matching';
    ELSE
      v_receipt_status := 'conflicting';
    END IF;
  END IF;

  v_eligible := v_account_matches
    AND v_account."archivedAt" IS NULL
    AND v_account.revision=1
    AND v_event_count=1
    AND v_matching_create_count=1
    AND v_current_balance=v_expected_balance
    AND v_receipt_status IN ('missing','matching');
  IF NOT v_account_matches THEN v_reason := 'The signed-in profile has no matching account with these financial fields.';
  ELSIF v_account."archivedAt" IS NOT NULL OR v_account.revision<>1 OR v_event_count<>1 OR v_matching_create_count<>1 THEN v_reason := 'The cloud account has additional or changed history, so it cannot be reconciled automatically.';
  ELSIF v_current_balance IS DISTINCT FROM v_expected_balance THEN v_reason := 'The current cloud and device account balances differ.';
  ELSIF v_receipt_status='conflicting' THEN v_reason := 'This mutation ID already has a different cloud receipt.';
  END IF;

  v_ack := jsonb_build_object('data',jsonb_build_object(
    'id',v_account.id,'revision',v_account.revision,'name',v_account.name,
    'type',v_account.type,'currency',v_account.currency,
    'openingBalanceMinor',v_account."openingBalanceMinor"::text,
    'archivedAt',v_account."archivedAt"));
  v_evidence := jsonb_build_object(
    'ownerMatches',v_account.id IS NOT NULL,
    'creationRecordMatches',v_matching_create_count=1,
    'creationRecordCount',v_event_count,
    'receiptStatus',v_receipt_status,
    'openingBalanceIsAccountField',true);

  IF p_commit AND v_eligible AND v_receipt_status='missing' THEN
    INSERT INTO public."MutationReceipt" (id,"userId","idempotencyKey","mutationType","requestHash",response,"transactionId")
      VALUES(gen_random_uuid(),v_user_id,p_idempotency_key,'account.create',v_request_hash,v_ack,NULL);
    v_receipt_status := 'matching';
    v_evidence := jsonb_set(v_evidence,'{receiptStatus}',to_jsonb(v_receipt_status));
  END IF;

  IF p_commit AND v_eligible THEN
    RETURN jsonb_build_object('status','reconciled','eligible',true,'ack',v_ack,'evidence',v_evidence,'reason',NULL);
  END IF;
  RETURN jsonb_build_object(
    'status',CASE WHEN v_eligible THEN 'verified' ELSE 'conflict' END,
    'eligible',v_eligible,
    'account',CASE WHEN v_account.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',v_account.id,'name',v_account.name,'type',v_account.type,'currency',v_account.currency,
      'openingBalanceMinor',v_account."openingBalanceMinor"::text,
      'currentBalanceMinor',v_current_balance::text,'revision',v_account.revision) END,
    'evidence',v_evidence,'reason',v_reason,
    'ack',CASE WHEN v_receipt_status='matching' THEN v_receipt.response ELSE NULL END);
END $$;

REVOKE ALL ON FUNCTION public.mizan_reconcile_account_create(text,text,jsonb,text,boolean) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.mizan_reconcile_account_create(text,text,jsonb,text,boolean) TO authenticated;
