-- Authenticated, append-only project collaboration over the existing Neon
-- Data API. Shared rows contain project data only; personal account IDs and
-- ledger transactions are intentionally not accepted by these RPCs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public."SharedProject" (
  id text PRIMARY KEY,
  "ownerUserId" text NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  kind text NOT NULL CHECK(kind IN ('personal','shared','work','custom')),
  currency text NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
  "startDate" date NOT NULL,
  "endDate" date,
  "budgetMinor" bigint CHECK("budgetMinor" IS NULL OR "budgetMinor" BETWEEN 0 AND 9007199254740991),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('planned','active','completed','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK("endDate" IS NULL OR "endDate">="startDate")
);

CREATE TABLE public."SharedProjectMember" (
  "projectId" text NOT NULL REFERENCES public."SharedProject"(id) ON DELETE RESTRICT,
  "memberId" text NOT NULL,
  "userId" text REFERENCES public."User"(id) ON DELETE RESTRICT,
  email text,
  "displayName" text NOT NULL CHECK(length(btrim("displayName")) BETWEEN 1 AND 100),
  role text NOT NULL CHECK(role IN ('owner','editor','viewer')),
  status text NOT NULL CHECK(status IN ('active','removed')),
  "targetContributionMinor" bigint CHECK("targetContributionMinor" IS NULL OR "targetContributionMinor" BETWEEN 0 AND 9007199254740991),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY("projectId","memberId")
);

CREATE UNIQUE INDEX "SharedProjectMember_user_idx" ON public."SharedProjectMember"("projectId","userId") WHERE "userId" IS NOT NULL AND status='active';
CREATE INDEX "SharedProjectMember_user_status_idx" ON public."SharedProjectMember"("userId",status,"projectId");

CREATE TABLE public."SharedProjectCategoryBudget" (
  "projectId" text NOT NULL REFERENCES public."SharedProject"(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK(length(btrim(category)) BETWEEN 1 AND 80),
  "amountMinor" bigint NOT NULL CHECK("amountMinor" BETWEEN 0 AND 9007199254740991),
  currency text NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY("projectId",category)
);

CREATE TABLE public."SharedProjectInvitation" (
  id text PRIMARY KEY,
  "projectId" text NOT NULL REFERENCES public."SharedProject"(id) ON DELETE RESTRICT,
  email text NOT NULL,
  role text NOT NULL CHECK(role IN ('editor','viewer')),
  "memberId" text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE,
  "invitedByUserId" text NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT,
  "expiresAt" timestamptz NOT NULL,
  "acceptedAt" timestamptz,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "SharedProjectInvitation_project_idx" ON public."SharedProjectInvitation"("projectId","expiresAt");

CREATE TABLE public."SharedProjectEvent" (
  id text PRIMARY KEY,
  "projectId" text NOT NULL REFERENCES public."SharedProject"(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision>0),
  kind text NOT NULL CHECK(kind IN ('project.contribution','project.revenue','project.withdrawal','project.expense','project.refund','project.settlement','project.member.add','project.member.remove','project.member.role','project.member.target','project.budget.set','project.update','project.complete','project.reopen','project.archive')),
  "actorUserId" text NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT,
  "memberId" text,
  "payerMemberId" text,
  "fromMemberId" text,
  "toMemberId" text,
  "fundingSource" text CHECK("fundingSource" IS NULL OR "fundingSource" IN ('member','group_fund')),
  "expenseId" text,
  "amountMinor" bigint CHECK("amountMinor" IS NULL OR "amountMinor" BETWEEN 1 AND 9007199254740991),
  currency text,
  shares jsonb,
  payload jsonb NOT NULL,
  "idempotencyKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("projectId","idempotencyKey"),
  UNIQUE("projectId",revision),
  FOREIGN KEY("projectId","memberId") REFERENCES public."SharedProjectMember"("projectId","memberId") ON DELETE RESTRICT,
  FOREIGN KEY("projectId","payerMemberId") REFERENCES public."SharedProjectMember"("projectId","memberId") ON DELETE RESTRICT,
  FOREIGN KEY("projectId","fromMemberId") REFERENCES public."SharedProjectMember"("projectId","memberId") ON DELETE RESTRICT,
  FOREIGN KEY("projectId","toMemberId") REFERENCES public."SharedProjectMember"("projectId","memberId") ON DELETE RESTRICT
);
CREATE INDEX "SharedProjectEvent_project_revision_idx" ON public."SharedProjectEvent"("projectId",revision);

CREATE TABLE public."SharedProjectBalanceEntry" (
  "projectId" text NOT NULL,
  "eventId" text NOT NULL REFERENCES public."SharedProjectEvent"(id) ON DELETE RESTRICT,
  "memberId" text NOT NULL,
  "deltaMinor" bigint NOT NULL CHECK("deltaMinor" BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY("eventId","memberId"),
  FOREIGN KEY("projectId","memberId") REFERENCES public."SharedProjectMember"("projectId","memberId") ON DELETE RESTRICT
);
CREATE INDEX "SharedProjectBalanceEntry_member_idx" ON public."SharedProjectBalanceEntry"("projectId","memberId");

CREATE OR REPLACE FUNCTION public.mizan_project_apply(p_project_id text,p_operation text,p_payload jsonb,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_user text:=auth.user_id()::text; v_project public."SharedProject"%ROWTYPE; v_actor public."SharedProjectMember"%ROWTYPE;
  v_prior public."SharedProjectEvent"%ROWTYPE; v_event_id text:=COALESCE(p_payload->>'id',gen_random_uuid()::text);
  v_revision integer; v_amount bigint; v_currency text; v_member text; v_payer text; v_source text;
  v_sum numeric:=0; v_share record; v_input record; v_delta bigint; v_balance bigint; v_cash bigint; v_original public."SharedProjectEvent"%ROWTYPE; v_payer_in_split boolean;
  v_split_method text; v_weight_sum numeric:=0; v_allocated numeric:=0; v_expected bigint; v_index integer:=0; v_share_count integer:=0;
  v_response jsonb; v_hash text; v_receipt public."MutationReceipt"%ROWTYPE;
BEGIN
  IF v_user IS NULL OR p_project_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'invalid authenticated project mutation' USING ERRCODE='22023'; END IF;
  IF p_payload ?| ARRAY['accountId','transactionId','sourceAccountId','destinationAccountId','personalAccountId'] THEN RAISE EXCEPTION 'private personal ledger references cannot be shared' USING ERRCODE='22023'; END IF;
  v_hash:=md5(p_operation||':'||p_project_id||':'||p_payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user||':project:'||p_idempotency_key,0));
  SELECT * INTO v_prior FROM public."SharedProjectEvent" WHERE "projectId"=p_project_id AND "idempotencyKey"=p_idempotency_key;
  IF FOUND THEN
    IF v_prior."actorUserId"<>v_user OR v_prior.payload<>p_payload OR v_prior.kind<>p_operation THEN RAISE EXCEPTION 'project idempotency key was reused with different details' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('id',v_prior.id,'projectId',p_project_id,'revision',v_prior.revision,'replayed',true);
  END IF;
  SELECT * INTO v_project FROM public."SharedProject" WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='23503'; END IF;
  SELECT * INTO v_actor FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "userId"=v_user AND status='active';
  IF NOT FOUND OR v_actor.role='viewer' THEN RAISE EXCEPTION 'project membership does not permit this operation' USING ERRCODE='42501'; END IF;
  IF v_project.status IN ('completed','archived') AND p_operation NOT IN ('project.reopen') THEN RAISE EXCEPTION 'project must be reopened before changes' USING ERRCODE='23514'; END IF;
  v_revision:=v_project.revision+1;
  v_amount:=NULLIF(p_payload->>'amountMinor','')::bigint;
  v_currency:=COALESCE(p_payload->>'currency',v_project.currency);
  v_member:=p_payload->>'memberId'; v_payer:=p_payload->>'payerMemberId'; v_source:=p_payload->>'fundingSource';
  IF v_currency<>v_project.currency THEN RAISE EXCEPTION 'project currency mismatch' USING ERRCODE='23514'; END IF;
  IF p_operation IN ('project.contribution','project.revenue','project.withdrawal') THEN
    IF v_amount IS NULL OR v_amount NOT BETWEEN 1 AND 9007199254740991 OR v_member IS NULL OR NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=v_member AND status='active') THEN RAISE EXCEPTION 'invalid project cash movement' USING ERRCODE='22023'; END IF;
    IF p_operation='project.withdrawal' THEN
      SELECT COALESCE(SUM("deltaMinor"),0) INTO v_balance FROM public."SharedProjectBalanceEntry" WHERE "projectId"=p_project_id AND "memberId"=v_member;
      SELECT COALESCE(SUM(CASE WHEN kind IN ('project.contribution','project.revenue') THEN "amountMinor" WHEN kind='project.withdrawal' THEN -"amountMinor" WHEN kind='project.expense' AND "fundingSource"='group_fund' THEN -"amountMinor" WHEN kind='project.refund' AND "fundingSource"='group_fund' THEN "amountMinor" ELSE 0 END),0) INTO v_cash FROM public."SharedProjectEvent" WHERE "projectId"=p_project_id;
      IF v_balance<v_amount OR v_cash<v_amount THEN RAISE EXCEPTION 'withdrawal exceeds available fund cash or member ownership' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF p_operation='project.expense' THEN
    v_split_method:=p_payload->>'splitMethod';
    IF v_amount IS NULL OR v_amount NOT BETWEEN 1 AND 9007199254740991 OR v_payer IS NULL OR v_source NOT IN ('member','group_fund') OR NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=v_payer AND status='active') OR jsonb_typeof(p_payload->'shares')<>'array' OR jsonb_array_length(p_payload->'shares')=0 OR jsonb_typeof(p_payload->'splitInputs')<>'array' OR jsonb_array_length(p_payload->'splitInputs')<>jsonb_array_length(p_payload->'shares') OR v_split_method IS NULL OR v_split_method NOT IN ('equal','percentage','fixed','weighted','individual') OR length(btrim(COALESCE(p_payload->>'category',''))) NOT BETWEEN 1 AND 80 OR length(btrim(COALESCE(p_payload->>'description',''))) NOT BETWEEN 1 AND 200 OR COALESCE(p_payload->>'occurredAt','')='' THEN RAISE EXCEPTION 'invalid project expense' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=COALESCE(p_payload->>'recordedByMemberId',v_payer) AND status='active') THEN RAISE EXCEPTION 'expense recorder is not an active project member' USING ERRCODE='42501'; END IF;
    v_share_count:=jsonb_array_length(p_payload->'shares');
    IF v_split_method='individual' AND v_share_count<>1 THEN RAISE EXCEPTION 'individual split requires exactly one participant' USING ERRCODE='23514'; END IF;
    IF v_split_method='fixed' THEN
      FOR v_input IN SELECT value FROM jsonb_array_elements(p_payload->'splitInputs') LOOP
        IF v_input.value->>'memberId' IS NULL OR COALESCE((v_input.value->>'value')::numeric,-1)<0 OR trunc(COALESCE((v_input.value->>'value')::numeric,-1))<>COALESCE((v_input.value->>'value')::numeric,-1) THEN RAISE EXCEPTION 'invalid fixed project split' USING ERRCODE='22023'; END IF;
        v_weight_sum:=v_weight_sum+((v_input.value->>'value')::numeric);
      END LOOP;
      IF v_weight_sum<>v_amount THEN RAISE EXCEPTION 'fixed project shares must equal the expense amount' USING ERRCODE='23514'; END IF;
    ELSE
      FOR v_input IN SELECT value FROM jsonb_array_elements(p_payload->'splitInputs') LOOP
        IF v_input.value->>'memberId' IS NULL OR COALESCE((v_input.value->>'value')::numeric,0)<=0 OR trunc(COALESCE((v_input.value->>'value')::numeric,0))<>COALESCE((v_input.value->>'value')::numeric,0) THEN RAISE EXCEPTION 'invalid project split weight' USING ERRCODE='22023'; END IF;
        v_weight_sum:=v_weight_sum+CASE WHEN v_split_method IN ('equal','individual') THEN 1 ELSE (v_input.value->>'value')::numeric END;
      END LOOP;
      IF v_split_method='percentage' AND v_weight_sum<>10000 THEN RAISE EXCEPTION 'project percentages must total exactly 100 percent' USING ERRCODE='23514'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'splitInputs') i GROUP BY i.value->>'memberId' HAVING count(*)>1) THEN RAISE EXCEPTION 'project split participants must be unique' USING ERRCODE='23514'; END IF;
    v_index:=0; v_allocated:=0;
    FOR v_share IN SELECT s.value AS share,i.value AS input FROM jsonb_array_elements(p_payload->'shares') WITH ORDINALITY s(value,ord) JOIN jsonb_array_elements(p_payload->'splitInputs') WITH ORDINALITY i(value,ord) USING(ord) LOOP
      v_index:=v_index+1;
      IF v_share.share->>'memberId' IS DISTINCT FROM v_share.input->>'memberId' THEN RAISE EXCEPTION 'project shares do not match split participants' USING ERRCODE='23514'; END IF;
      IF v_split_method='fixed' THEN v_expected:=(v_share.input->>'value')::bigint;
      ELSIF v_index=v_share_count THEN v_expected:=v_amount-v_allocated;
      ELSE v_expected:=trunc(v_amount::numeric*(CASE WHEN v_split_method IN ('equal','individual') THEN 1 ELSE (v_share.input->>'value')::numeric END)/v_weight_sum)::bigint;
      END IF;
      IF COALESCE((v_share.share->>'amountMinor')::bigint,-1)<>v_expected THEN RAISE EXCEPTION 'project split allocation does not match the selected split method' USING ERRCODE='23514'; END IF;
      v_allocated:=v_allocated+v_expected;
    END LOOP;
    FOR v_share IN SELECT value FROM jsonb_array_elements(p_payload->'shares') LOOP
      IF v_share.value->>'memberId' IS NULL OR COALESCE((v_share.value->>'amountMinor')::bigint,-1)<0 OR NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=v_share.value->>'memberId' AND status='active') THEN RAISE EXCEPTION 'invalid expense allocation' USING ERRCODE='22023'; END IF;
      v_sum:=v_sum+(v_share.value->>'amountMinor')::bigint;
    END LOOP;
    IF v_sum<>v_amount THEN RAISE EXCEPTION 'expense allocations do not equal the amount' USING ERRCODE='23514'; END IF;
    IF v_source='group_fund' THEN
      SELECT COALESCE(SUM(CASE WHEN kind IN ('project.contribution','project.revenue') THEN "amountMinor" WHEN kind='project.withdrawal' THEN -"amountMinor" WHEN kind='project.expense' AND "fundingSource"='group_fund' THEN -"amountMinor" WHEN kind='project.refund' AND "fundingSource"='group_fund' THEN "amountMinor" ELSE 0 END),0) INTO v_cash FROM public."SharedProjectEvent" WHERE "projectId"=p_project_id;
      IF v_cash<v_amount THEN RAISE EXCEPTION 'pooled expense exceeds fund cash' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF p_operation='project.refund' THEN
    SELECT * INTO v_original FROM public."SharedProjectEvent" WHERE id=p_payload->>'expenseId' AND "projectId"=p_project_id AND kind='project.expense';
    IF NOT FOUND OR v_amount IS NULL OR v_amount<=0 OR v_currency<>v_original.currency OR v_amount>(v_original."amountMinor"-COALESCE((SELECT SUM("amountMinor") FROM public."SharedProjectEvent" WHERE "projectId"=p_project_id AND kind='project.refund' AND "expenseId"=v_original.id),0)) THEN RAISE EXCEPTION 'refund exceeds remaining expense amount' USING ERRCODE='23514'; END IF;
    v_source:=v_original."fundingSource"; v_member:=v_original."payerMemberId"; v_payer:=v_original."payerMemberId";
  ELSIF p_operation='project.settlement' THEN
    v_member:=p_payload->>'fromMemberId'; v_payer:=p_payload->>'toMemberId';
    IF v_amount IS NULL OR v_amount<=0 OR v_member IS NULL OR v_payer IS NULL OR v_member=v_payer THEN RAISE EXCEPTION 'invalid settlement' USING ERRCODE='22023'; END IF;
    SELECT COALESCE(SUM("deltaMinor"),0) INTO v_balance FROM public."SharedProjectBalanceEntry" WHERE "projectId"=p_project_id AND "memberId"=v_member;
    IF v_balance+v_amount>0 THEN RAISE EXCEPTION 'settlement exceeds payer balance' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(SUM("deltaMinor"),0) INTO v_balance FROM public."SharedProjectBalanceEntry" WHERE "projectId"=p_project_id AND "memberId"=v_payer;
    IF v_balance-v_amount<0 THEN RAISE EXCEPTION 'settlement exceeds receiver balance' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=v_member AND status='active') OR NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=v_payer AND status='active') THEN RAISE EXCEPTION 'settlement participants are unavailable' USING ERRCODE='23503'; END IF;
  ELSIF p_operation NOT IN ('project.member.add','project.member.remove','project.member.role','project.member.target','project.budget.set','project.update','project.complete','project.reopen','project.archive') THEN
    RAISE EXCEPTION 'unsupported project operation' USING ERRCODE='0A000';
  END IF;
  IF p_operation='project.member.add' THEN
    IF length(btrim(COALESCE(p_payload->>'displayName',''))) NOT BETWEEN 1 AND 100 OR p_payload->>'role' NOT IN ('editor','viewer') OR p_payload ? 'userId' THEN RAISE EXCEPTION 'invalid local project participant' USING ERRCODE='22023'; END IF;
    INSERT INTO public."SharedProjectMember"("projectId","memberId","displayName",role,status,"targetContributionMinor") VALUES(p_project_id,p_payload->>'memberId',p_payload->>'displayName',p_payload->>'role','active',NULLIF(p_payload->>'targetContributionMinor','')::bigint);
  ELSIF p_operation='project.member.remove' THEN
    IF v_actor.role<>'owner' THEN RAISE EXCEPTION 'only project owners can remove members' USING ERRCODE='42501'; END IF;
    IF COALESCE((SELECT SUM("deltaMinor") FROM public."SharedProjectBalanceEntry" WHERE "projectId"=p_project_id AND "memberId"=p_payload->>'memberId'),0)<>0 THEN RAISE EXCEPTION 'settle or withdraw the member balance before revoking project access' USING ERRCODE='23514'; END IF;
    UPDATE public."SharedProjectMember" SET status='removed' WHERE "projectId"=p_project_id AND "memberId"=p_payload->>'memberId' AND role<>'owner';
    IF NOT FOUND THEN RAISE EXCEPTION 'member cannot be removed' USING ERRCODE='23503'; END IF;
  ELSIF p_operation='project.member.target' THEN
    IF NULLIF(p_payload->>'targetContributionMinor','') IS NOT NULL AND (p_payload->>'targetContributionMinor')::bigint NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'invalid contribution target' USING ERRCODE='22023'; END IF;
    UPDATE public."SharedProjectMember" SET "targetContributionMinor"=NULLIF(p_payload->>'targetContributionMinor','')::bigint WHERE "projectId"=p_project_id AND "memberId"=p_payload->>'memberId' AND status='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'member is unavailable' USING ERRCODE='23503'; END IF;
  ELSIF p_operation='project.member.role' THEN
    IF v_actor.role<>'owner' OR p_payload->>'role' NOT IN ('editor','viewer') THEN RAISE EXCEPTION 'member role update is not authorized' USING ERRCODE='42501'; END IF;
    UPDATE public."SharedProjectMember" SET role=p_payload->>'role' WHERE "projectId"=p_project_id AND "memberId"=p_payload->>'memberId' AND status='active' AND role<>'owner';
    IF NOT FOUND THEN RAISE EXCEPTION 'member role cannot be changed' USING ERRCODE='23503'; END IF;
  ELSIF p_operation='project.budget.set' THEN
    IF v_actor.role<>'owner' OR COALESCE((p_payload->>'amountMinor')::bigint,-1)<0 THEN RAISE EXCEPTION 'invalid project budget update' USING ERRCODE='42501'; END IF;
    IF NULLIF(btrim(p_payload->>'category'),'') IS NOT NULL THEN
      INSERT INTO public."SharedProjectCategoryBudget"("projectId",category,"amountMinor",currency,revision) VALUES(p_project_id,btrim(p_payload->>'category'),(p_payload->>'amountMinor')::bigint,v_project.currency,v_revision)
        ON CONFLICT("projectId",category) DO UPDATE SET "amountMinor"=EXCLUDED."amountMinor",revision=EXCLUDED.revision;
    ELSE UPDATE public."SharedProject" SET "budgetMinor"=(p_payload->>'amountMinor')::bigint WHERE id=p_project_id; END IF;
  ELSIF p_operation='project.update' THEN
    IF v_actor.role<>'owner' OR p_payload->>'expectedRevision' IS DISTINCT FROM v_project.revision::text THEN RAISE EXCEPTION 'project revision conflict' USING ERRCODE='40001'; END IF;
    UPDATE public."SharedProject" SET name=COALESCE(p_payload->>'name',name),description=COALESCE(p_payload->>'description',description),"updatedAt"=now() WHERE id=p_project_id;
  ELSIF p_operation IN ('project.complete','project.reopen','project.archive') THEN
    IF v_actor.role<>'owner' THEN RAISE EXCEPTION 'only project owners can change project status' USING ERRCODE='42501'; END IF;
    UPDATE public."SharedProject" SET status=CASE p_operation WHEN 'project.complete' THEN 'completed' WHEN 'project.archive' THEN 'archived' ELSE 'active' END,"updatedAt"=now() WHERE id=p_project_id;
  END IF;
  UPDATE public."SharedProject" SET revision=v_revision,"updatedAt"=now() WHERE id=p_project_id;
  INSERT INTO public."SharedProjectEvent"(id,"projectId",revision,kind,"actorUserId","memberId","payerMemberId","fromMemberId","toMemberId","fundingSource","expenseId","amountMinor",currency,shares,payload,"idempotencyKey")
    VALUES(v_event_id,p_project_id,v_revision,p_operation,v_user,v_member,v_payer,NULLIF(p_payload->>'fromMemberId',''),NULLIF(p_payload->>'toMemberId',''),v_source,NULLIF(p_payload->>'expenseId',''),v_amount,v_currency,p_payload->'shares',p_payload,p_idempotency_key);
  IF p_operation IN ('project.contribution','project.revenue') THEN INSERT INTO public."SharedProjectBalanceEntry" VALUES(p_project_id,v_event_id,v_member,v_amount);
  ELSIF p_operation='project.withdrawal' THEN INSERT INTO public."SharedProjectBalanceEntry" VALUES(p_project_id,v_event_id,v_member,-v_amount);
  ELSIF p_operation='project.settlement' THEN
    INSERT INTO public."SharedProjectBalanceEntry" VALUES(p_project_id,v_event_id,v_member,v_amount),(p_project_id,v_event_id,v_payer,-v_amount);
  ELSIF p_operation='project.expense' THEN
    v_payer_in_split:=false;
    FOR v_share IN SELECT value FROM jsonb_array_elements(p_payload->'shares') LOOP
      v_delta:=-((v_share.value->>'amountMinor')::bigint);
      IF v_source='member' AND v_share.value->>'memberId'=v_payer THEN v_delta:=v_delta+v_amount; v_payer_in_split:=true; END IF;
      IF v_delta<>0 THEN INSERT INTO public."SharedProjectBalanceEntry" VALUES(p_project_id,v_event_id,v_share.value->>'memberId',v_delta); END IF;
    END LOOP;
    IF v_source='member' AND NOT v_payer_in_split THEN INSERT INTO public."SharedProjectBalanceEntry" VALUES(p_project_id,v_event_id,v_payer,v_amount); END IF;
  ELSIF p_operation='project.refund' THEN
    v_sum:=0;
    FOR v_share IN SELECT b."memberId",b."deltaMinor" FROM public."SharedProjectBalanceEntry" b WHERE b.eventId=v_original.id ORDER BY b."memberId" LOOP
      v_delta:=CASE WHEN v_share."memberId"=(SELECT max(b2."memberId") FROM public."SharedProjectBalanceEntry" b2 WHERE b2.eventId=v_original.id) THEN v_amount-v_sum ELSE trunc((abs(v_share."deltaMinor")::numeric*v_amount/v_original."amountMinor"))::bigint END;
      v_sum:=v_sum+v_delta;
      INSERT INTO public."SharedProjectBalanceEntry" VALUES(p_project_id,v_event_id,v_share."memberId",CASE WHEN v_share."deltaMinor">0 THEN -v_delta ELSE v_delta END);
    END LOOP;
  END IF;
  v_response:=jsonb_build_object('id',v_event_id,'projectId',p_project_id,'revision',v_revision,'kind',p_operation,'payload',p_payload);
  PERFORM public.mizan_project_publish(p_project_id,'project_event',v_event_id,v_response);
  IF p_operation IN ('project.member.add','project.member.remove','project.member.role','project.member.target') THEN
    PERFORM public.mizan_project_publish(p_project_id,'project_member',p_project_id||':'||(p_payload->>'memberId'),
      (SELECT jsonb_build_object('projectId',m."projectId",'memberId',m."memberId",'userId',m."userId",'email',m.email,'displayName',m."displayName",'role',m.role,'status',m.status,'targetContributionMinor',m."targetContributionMinor"::text,'revision',v_revision) FROM public."SharedProjectMember" m WHERE m."projectId"=p_project_id AND m."memberId"=p_payload->>'memberId'));
  END IF;
  PERFORM public.mizan_project_publish(p_project_id,'project',p_project_id,jsonb_build_object('id',v_project.id,'name',(SELECT name FROM public."SharedProject" WHERE id=p_project_id),'description',(SELECT description FROM public."SharedProject" WHERE id=p_project_id),'kind',v_project.kind,'currency',v_project.currency,'startDate',v_project."startDate"::text,'endDate',v_project."endDate"::text,'budgetMinor',(SELECT "budgetMinor"::text FROM public."SharedProject" WHERE id=p_project_id),'status',(SELECT status FROM public."SharedProject" WHERE id=p_project_id),'revision',v_revision));
  RETURN v_response;
END $$;

CREATE OR REPLACE FUNCTION public.mizan_project_publish(p_project_id text, p_entity_type text, p_entity_id text, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_member record; v_cursor bigint;
BEGIN
  FOR v_member IN SELECT "userId" FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND status='active' AND "userId" IS NOT NULL LOOP
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_member."userId" RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog"(cursor,"userId","entityType","entityId",revision,payload)
      VALUES(v_cursor,v_member."userId",p_entity_type,p_entity_id,COALESCE((p_payload->>'revision')::integer,1),p_payload);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.mizan_project_create(p_project jsonb, p_owner_member_id text, p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_user text:=auth.user_id()::text; v_email text; v_name text; v_id text; v_response jsonb;
BEGIN
  IF v_user IS NULL OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'authentication required or invalid idempotency key' USING ERRCODE='28000'; END IF;
  SELECT email,name INTO v_email,v_name FROM neon_auth."user" WHERE id=v_user AND "emailVerified"=true;
  IF v_email IS NULL THEN RAISE EXCEPTION 'verified account required' USING ERRCODE='28000'; END IF;
  v_id:=p_project->>'id';
  IF v_id IS NULL OR length(btrim(COALESCE(p_project->>'name',''))) NOT BETWEEN 1 AND 100 OR p_project->>'currency' NOT IN ('PKR','USD','GBP','EUR','AED','SAR') OR p_project->>'kind' NOT IN ('personal','shared','work','custom') OR (p_project ? 'accountId' OR p_project ? 'transactionId') THEN RAISE EXCEPTION 'invalid or private project payload' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user||':project:'||p_idempotency_key,0));
  INSERT INTO public."User"(id,name,email,"updatedAt") VALUES(v_user,COALESCE(NULLIF(v_name,''),'Leverage user'),v_email,now())
    ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,"updatedAt"=now();
  IF EXISTS(SELECT 1 FROM public."SharedProject" WHERE id=v_id) THEN
    IF EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=v_id AND "userId"=v_user AND role='owner')
      AND EXISTS(SELECT 1 FROM public."SharedProjectEvent" WHERE "projectId"=v_id AND revision=1 AND kind='project.update' AND "idempotencyKey"='create:'||p_idempotency_key AND payload->'project'=p_project AND payload->>'ownerMemberId'=p_owner_member_id) THEN
      SELECT jsonb_build_object('projectId',id,'revision',revision) INTO v_response FROM public."SharedProject" WHERE id=v_id; RETURN v_response;
    END IF;
    RAISE EXCEPTION 'project ID is already in use' USING ERRCODE='23505';
  END IF;
  INSERT INTO public."SharedProject"(id,"ownerUserId",name,description,kind,currency,"startDate","endDate","budgetMinor") VALUES(v_id,v_user,p_project->>'name',COALESCE(p_project->>'description',''),p_project->>'kind',p_project->>'currency',(p_project->>'startDate')::date,NULLIF(p_project->>'endDate','')::date,NULLIF(p_project->>'budgetMinor','')::bigint);
  INSERT INTO public."SharedProjectMember"("projectId","memberId","userId",email,"displayName",role,status) VALUES(v_id,p_owner_member_id,v_user,lower(v_email),COALESCE(NULLIF(v_name,''),p_project->>'name'),'owner','active');
  INSERT INTO public."SharedProjectEvent"(id,"projectId",revision,kind,"actorUserId",payload,"idempotencyKey") VALUES(gen_random_uuid()::text,v_id,1,'project.update',v_user,jsonb_build_object('project',p_project,'ownerMemberId',p_owner_member_id),'create:'||p_idempotency_key);
  v_response:=jsonb_build_object('projectId',v_id,'revision',1);
  PERFORM public.mizan_project_publish(v_id,'project',v_id,jsonb_build_object('project',p_project,'ownerMemberId',p_owner_member_id,'revision',1));
  PERFORM public.mizan_project_publish(v_id,'project_member',v_id||':'||p_owner_member_id,jsonb_build_object('projectId',v_id,'memberId',p_owner_member_id,'userId',v_user,'email',lower(v_email),'displayName',COALESCE(NULLIF(v_name,''),p_project->>'name'),'role','owner','status','active','revision',1));
  RETURN v_response;
END $$;

CREATE OR REPLACE FUNCTION public.mizan_project_invite(p_project_id text,p_email text,p_role text,p_token text,p_member_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_user text:=auth.user_id()::text; v_id text:=gen_random_uuid()::text; v_name text; v_prior public."SharedProjectInvitation"%ROWTYPE;
BEGIN
  IF v_user IS NULL OR p_role NOT IN ('editor','viewer') OR length(p_token) NOT BETWEEN 32 AND 256 OR p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN RAISE EXCEPTION 'invalid invitation' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "userId"=v_user AND status='active' AND role IN ('owner','editor')) THEN RAISE EXCEPTION 'project invitation is not authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_prior FROM public."SharedProjectInvitation" WHERE "tokenHash"=encode(digest(p_token,'sha256'),'hex');
  IF FOUND THEN
    IF v_prior."projectId"=p_project_id AND v_prior.email=lower(p_email) AND v_prior.role=p_role AND v_prior."memberId"=p_member_id AND v_prior."invitedByUserId"=v_user AND v_prior."revokedAt" IS NULL THEN RETURN jsonb_build_object('invitationId',v_prior.id,'projectName',(SELECT name FROM public."SharedProject" WHERE id=p_project_id),'expiresAt',v_prior."expiresAt"); END IF;
    RAISE EXCEPTION 'invitation token was already used for different details' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND email=lower(p_email) AND status='active') THEN RAISE EXCEPTION 'user is already a project member' USING ERRCODE='23505'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "memberId"=p_member_id AND status='active' AND "userId" IS NULL) THEN RAISE EXCEPTION 'choose an active unregistered project participant to invite' USING ERRCODE='23503'; END IF;
  INSERT INTO public."SharedProjectInvitation"(id,"projectId",email,role,"memberId","tokenHash","invitedByUserId","expiresAt") VALUES(v_id,p_project_id,lower(p_email),p_role,p_member_id,encode(digest(p_token,'sha256'),'hex'),v_user,now()+interval '7 days');
  SELECT name INTO v_name FROM public."SharedProject" WHERE id=p_project_id;
  RETURN jsonb_build_object('invitationId',v_id,'projectName',v_name,'expiresAt',now()+interval '7 days');
END $$;

CREATE OR REPLACE FUNCTION public.mizan_project_accept(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_user text:=auth.user_id()::text; v_email text; v_name text; v_inv public."SharedProjectInvitation"%ROWTYPE; v_project public."SharedProject"%ROWTYPE; v_member jsonb; v_event record;
BEGIN
  SELECT email,name INTO v_email,v_name FROM neon_auth."user" WHERE id=v_user AND "emailVerified"=true;
  IF v_user IS NULL OR v_email IS NULL OR length(p_token) NOT BETWEEN 32 AND 256 THEN RAISE EXCEPTION 'verified account required' USING ERRCODE='28000'; END IF;
  INSERT INTO public."User"(id,name,email,"updatedAt") VALUES(v_user,COALESCE(NULLIF(v_name,''),'Leverage user'),v_email,now())
    ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,"updatedAt"=now();
  SELECT * INTO v_inv FROM public."SharedProjectInvitation" WHERE "tokenHash"=encode(digest(p_token,'sha256'),'hex') FOR UPDATE;
  IF FOUND AND v_inv.email=lower(v_email) AND v_inv."acceptedAt" IS NOT NULL AND v_inv."revokedAt" IS NULL
    AND EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=v_inv."projectId" AND "memberId"=v_inv."memberId" AND "userId"=v_user AND status='active') THEN
    RETURN jsonb_build_object('projectId',v_inv."projectId",'memberId',v_inv."memberId");
  END IF;
  IF NOT FOUND OR v_inv.email<>lower(v_email) OR v_inv."expiresAt"<=now() OR v_inv."acceptedAt" IS NOT NULL OR v_inv."revokedAt" IS NOT NULL THEN RAISE EXCEPTION 'invitation is invalid, expired, or already used' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_project FROM public."SharedProject" WHERE id=v_inv."projectId" FOR UPDATE;
  INSERT INTO public."SharedProjectMember"("projectId","memberId","userId",email,"displayName",role,status) VALUES(v_inv."projectId",v_inv."memberId",v_user,lower(v_email),COALESCE(NULLIF(v_name,''),v_email),v_inv.role,'active')
    ON CONFLICT("projectId","memberId") DO UPDATE SET "userId"=EXCLUDED."userId",email=EXCLUDED.email,"displayName"=EXCLUDED."displayName",role=EXCLUDED.role,status='active'
    WHERE public."SharedProjectMember"."userId" IS NULL AND public."SharedProjectMember".status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'invited participant is no longer available' USING ERRCODE='23505'; END IF;
  UPDATE public."SharedProjectInvitation" SET "acceptedAt"=now() WHERE id=v_inv.id;
  v_member:=jsonb_build_object('projectId',v_project.id,'memberId',v_inv."memberId",'userId',v_user,'email',lower(v_email),'displayName',COALESCE(NULLIF(v_name,''),v_email),'role',v_inv.role,'status','active','revision',1);
  PERFORM public.mizan_project_publish(v_project.id,'project',v_project.id,jsonb_build_object('project',jsonb_build_object('id',v_project.id,'name',v_project.name,'description',v_project.description,'kind',v_project.kind,'currency',v_project.currency,'startDate',v_project."startDate"::text,'endDate',v_project."endDate"::text,'budgetMinor',v_project."budgetMinor"::text,'status',v_project.status),'revision',v_project.revision));
  FOR v_member IN SELECT jsonb_build_object('projectId',m."projectId",'memberId',m."memberId",'userId',m."userId",'email',m.email,'displayName',m."displayName",'role',m.role,'status',m.status,'revision',v_project.revision) FROM public."SharedProjectMember" m WHERE m."projectId"=v_project.id AND m.status='active' LOOP
    PERFORM public.mizan_project_publish(v_project.id,'project_member',v_project.id||':'||(v_member->>'memberId'),v_member);
  END LOOP;
  FOR v_event IN SELECT * FROM public."SharedProjectEvent" WHERE "projectId"=v_project.id ORDER BY revision LOOP
    PERFORM public.mizan_project_publish(v_project.id,'project_event',v_event.id,jsonb_build_object('id',v_event.id,'projectId',v_event."projectId",'revision',v_event.revision,'kind',v_event.kind,'payload',v_event.payload));
  END LOOP;
  RETURN jsonb_build_object('projectId',v_project.id,'memberId',v_inv."memberId");
END $$;

CREATE OR REPLACE FUNCTION public.mizan_project_remove_member(p_project_id text,p_member_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_user text:=auth.user_id()::text; v_member public."SharedProjectMember"%ROWTYPE; v_cursor bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "userId"=v_user AND role='owner' AND status='active') THEN RAISE EXCEPTION 'member removal is not authorized' USING ERRCODE='42501'; END IF;
  IF COALESCE((SELECT SUM("deltaMinor") FROM public."SharedProjectBalanceEntry" WHERE "projectId"=p_project_id AND "memberId"=p_member_id),0)<>0 THEN RAISE EXCEPTION 'settle or withdraw the member balance before revoking project access' USING ERRCODE='23514'; END IF;
  UPDATE public."SharedProjectMember" SET status='removed' WHERE "projectId"=p_project_id AND "memberId"=p_member_id AND role<>'owner' RETURNING * INTO v_member;
  IF NOT FOUND THEN RAISE EXCEPTION 'project member is unavailable' USING ERRCODE='23503'; END IF;
  UPDATE public."SharedProjectInvitation" SET "revokedAt"=now() WHERE "projectId"=p_project_id AND "memberId"=p_member_id AND "acceptedAt" IS NULL;
  IF v_member."userId" IS NOT NULL THEN
    UPDATE public."User" SET "syncRevision"="syncRevision"+1 WHERE id=v_member."userId" RETURNING "syncRevision" INTO v_cursor;
    INSERT INTO public."ChangeLog"(cursor,"userId","entityType","entityId",revision,payload) VALUES(v_cursor,v_member."userId",'project_member',p_project_id||':'||p_member_id,(SELECT revision FROM public."SharedProject" WHERE id=p_project_id),jsonb_build_object('projectId',p_project_id,'memberId',p_member_id,'userId',v_member."userId",'email',v_member.email,'displayName',v_member."displayName",'role',v_member.role,'status','removed','revision',(SELECT revision FROM public."SharedProject" WHERE id=p_project_id)));
  END IF;
  RETURN jsonb_build_object('removed',p_member_id);
END $$;

CREATE OR REPLACE FUNCTION public.mizan_project_report(p_project_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_user text:=auth.user_id()::text; v_result jsonb;
BEGIN
  IF v_user IS NULL OR NOT EXISTS(SELECT 1 FROM public."SharedProjectMember" WHERE "projectId"=p_project_id AND "userId"=v_user AND status='active') THEN RAISE EXCEPTION 'project access is not authorized' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object(
    'project',jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'kind',p.kind,'currency',p.currency,'startDate',p."startDate"::text,'endDate',p."endDate"::text,'budgetMinor',p."budgetMinor"::text,'status',p.status,'revision',p.revision),
    'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',m."memberId",'userId',m."userId",'email',m.email,'displayName',m."displayName",'role',m.role,'status',m.status,'targetContributionMinor',m."targetContributionMinor"::text,'balanceMinor',COALESCE((SELECT SUM(b."deltaMinor") FROM public."SharedProjectBalanceEntry" b WHERE b."projectId"=m."projectId" AND b."memberId"=m."memberId"),0)::text) ORDER BY m."displayName",m."memberId") FROM public."SharedProjectMember" m WHERE m."projectId"=p.id),'[]'::jsonb),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'revision',e.revision,'kind',e.kind,'payload',e.payload,'createdAt',e."createdAt") ORDER BY e.revision) FROM public."SharedProjectEvent" e WHERE e."projectId"=p.id),'[]'::jsonb),
    'categoryBudgets',COALESCE((SELECT jsonb_agg(jsonb_build_object('category',b.category,'amountMinor',b."amountMinor"::text,'currency',b.currency,'revision',b.revision) ORDER BY b.category) FROM public."SharedProjectCategoryBudget" b WHERE b."projectId"=p.id),'[]'::jsonb),
    'fundBalanceMinor',COALESCE((SELECT SUM(CASE WHEN kind IN ('project.contribution','project.revenue') THEN "amountMinor" WHEN kind='project.withdrawal' THEN -"amountMinor" WHEN kind='project.expense' AND "fundingSource"='group_fund' THEN -"amountMinor" WHEN kind='project.refund' AND "fundingSource"='group_fund' THEN "amountMinor" ELSE 0 END) FROM public."SharedProjectEvent" WHERE "projectId"=p.id),0)::text
  ) INTO v_result FROM public."SharedProject" p WHERE p.id=p_project_id;
  RETURN v_result;
END $$;

REVOKE ALL ON public."SharedProject",public."SharedProjectMember",public."SharedProjectInvitation",public."SharedProjectEvent",public."SharedProjectBalanceEntry" FROM PUBLIC,anonymous,authenticated;
REVOKE ALL ON public."SharedProjectCategoryBudget" FROM PUBLIC,anonymous,authenticated;
ALTER TABLE public."SharedProject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SharedProjectMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SharedProjectInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SharedProjectEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SharedProjectBalanceEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SharedProjectCategoryBudget" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION public.mizan_project_publish(text,text,text,jsonb) FROM PUBLIC,anonymous,authenticated;
REVOKE ALL ON FUNCTION public.mizan_project_create(jsonb,text,text) FROM PUBLIC,anonymous;
REVOKE ALL ON FUNCTION public.mizan_project_invite(text,text,text,text,text) FROM PUBLIC,anonymous;
REVOKE ALL ON FUNCTION public.mizan_project_accept(text) FROM PUBLIC,anonymous;
REVOKE ALL ON FUNCTION public.mizan_project_remove_member(text,text) FROM PUBLIC,anonymous;
REVOKE ALL ON FUNCTION public.mizan_project_report(text) FROM PUBLIC,anonymous;
REVOKE ALL ON FUNCTION public.mizan_project_apply(text,text,jsonb,text) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.mizan_project_create(jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_project_invite(text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_project_accept(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_project_remove_member(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_project_report(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mizan_project_apply(text,text,jsonb,text) TO authenticated;
