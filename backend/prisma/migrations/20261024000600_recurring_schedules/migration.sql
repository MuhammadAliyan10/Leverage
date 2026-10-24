CREATE TABLE "RecurringSchedule" (
  "id" VARCHAR(160) NOT NULL,
  "userId" TEXT NOT NULL,
  "scheduleType" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "classificationId" TEXT,
  "accountId" TEXT NOT NULL,
  "toAccountId" TEXT,
  "billId" TEXT,
  "frequency" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "nextDueDate" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringSchedule_pkey" PRIMARY KEY ("id", "userId"),
  CONSTRAINT "RecurringSchedule_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecurringSchedule_account_fkey" FOREIGN KEY ("accountId", "userId") REFERENCES "FinanceAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecurringSchedule_toAccount_fkey" FOREIGN KEY ("toAccountId", "userId") REFERENCES "FinanceAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecurringSchedule_type_check" CHECK ("scheduleType" IN ('income','expense','transfer')),
  CONSTRAINT "RecurringSchedule_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "RecurringSchedule_amount_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 9007199254740991),
  CONSTRAINT "RecurringSchedule_currency_check" CHECK ("currency" IN ('PKR','USD','GBP','EUR','AED','SAR')),
  CONSTRAINT "RecurringSchedule_frequency_check" CHECK ("frequency" IN ('daily','weekly','monthly','yearly')),
  CONSTRAINT "RecurringSchedule_status_check" CHECK ("status" IN ('active','paused','cancelled')),
  CONSTRAINT "RecurringSchedule_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "RecurringSchedule_dates_check" CHECK ("endDate" IS NULL OR "startDate" <= "endDate"),
  CONSTRAINT "RecurringSchedule_accounts_check" CHECK (("scheduleType" = 'transfer' AND "toAccountId" IS NOT NULL AND "toAccountId" <> "accountId") OR ("scheduleType" <> 'transfer' AND "toAccountId" IS NULL)),
  CONSTRAINT "RecurringSchedule_bill_check" CHECK ("billId" IS NULL)
);
CREATE INDEX "RecurringSchedule_due_idx" ON "RecurringSchedule"("userId", "status", "nextDueDate", "id");
CREATE INDEX "RecurringSchedule_account_idx" ON "RecurringSchedule"("userId", "accountId", "status");

CREATE TABLE "ScheduleOccurrence" (
  "id" VARCHAR(220) NOT NULL,
  "userId" TEXT NOT NULL,
  "scheduleId" VARCHAR(160) NOT NULL,
  "occurrenceDate" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "transactionId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ScheduleOccurrence_pkey" PRIMARY KEY ("id", "userId"),
  CONSTRAINT "ScheduleOccurrence_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleOccurrence_schedule_fkey" FOREIGN KEY ("scheduleId", "userId") REFERENCES "RecurringSchedule"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleOccurrence_transaction_fkey" FOREIGN KEY ("transactionId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleOccurrence_status_check" CHECK ("status" IN ('pending','posted','skipped')),
  CONSTRAINT "ScheduleOccurrence_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "ScheduleOccurrence_shape_check" CHECK (("status"='pending' AND "transactionId" IS NULL AND "resolvedAt" IS NULL) OR ("status"='posted' AND "transactionId" IS NOT NULL AND "resolvedAt" IS NOT NULL) OR ("status"='skipped' AND "transactionId" IS NULL AND "resolvedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ScheduleOccurrence_schedule_date_idx" ON "ScheduleOccurrence"("scheduleId", "occurrenceDate", "userId");
CREATE UNIQUE INDEX "ScheduleOccurrence_transaction_idx" ON "ScheduleOccurrence"("transactionId", "userId");
CREATE INDEX "ScheduleOccurrence_owner_status_date_idx" ON "ScheduleOccurrence"("userId", "status", "occurrenceDate", "id");

CREATE FUNCTION validate_recurring_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_currency TEXT; destination_currency TEXT;
BEGIN
  SELECT "currency" INTO STRICT account_currency FROM "FinanceAccount" WHERE "id"=NEW."accountId" AND "userId"=NEW."userId" AND "archivedAt" IS NULL;
  IF account_currency <> NEW."currency" THEN RAISE EXCEPTION 'schedule account currency mismatch' USING ERRCODE='check_violation'; END IF;
  IF NEW."toAccountId" IS NOT NULL THEN
    SELECT "currency" INTO STRICT destination_currency FROM "FinanceAccount" WHERE "id"=NEW."toAccountId" AND "userId"=NEW."userId" AND "archivedAt" IS NULL;
    IF destination_currency <> NEW."currency" THEN RAISE EXCEPTION 'schedule transfer currency mismatch' USING ERRCODE='check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "RecurringSchedule_validate" BEFORE INSERT OR UPDATE ON "RecurringSchedule" FOR EACH ROW EXECUTE FUNCTION validate_recurring_schedule();

CREATE FUNCTION validate_schedule_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE schedule "RecurringSchedule"%ROWTYPE; tx "FinanceTransaction"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT schedule FROM "RecurringSchedule" WHERE "id"=NEW."scheduleId" AND "userId"=NEW."userId";
  IF TG_OP='UPDATE' AND OLD."status" <> 'pending' THEN RAISE EXCEPTION 'resolved schedule occurrences are immutable' USING ERRCODE='check_violation'; END IF;
  IF TG_OP='UPDATE' AND (NEW."id",NEW."userId",NEW."scheduleId",NEW."occurrenceDate",NEW."createdAt") IS DISTINCT FROM (OLD."id",OLD."userId",OLD."scheduleId",OLD."occurrenceDate",OLD."createdAt") THEN
    RAISE EXCEPTION 'schedule occurrence identity is immutable' USING ERRCODE='check_violation';
  END IF;
  IF NEW."status"='posted' THEN
    SELECT * INTO STRICT tx FROM "FinanceTransaction" WHERE "id"=NEW."transactionId" AND "userId"=NEW."userId";
    IF tx."amountMinor" <> schedule."amountMinor" OR tx."currency" <> schedule."currency" OR tx."accountId" <> schedule."accountId" OR
      (schedule."scheduleType"='income' AND tx."type" <> 'income') OR
      (schedule."scheduleType"='expense' AND tx."type" <> 'expense') OR
      (schedule."scheduleType"='transfer' AND (tx."type" <> 'transfer' OR tx."toAccountId" <> schedule."toAccountId")) THEN
      RAISE EXCEPTION 'posted transaction does not match its recurring schedule' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ScheduleOccurrence_validate" BEFORE INSERT OR UPDATE ON "ScheduleOccurrence" FOR EACH ROW EXECUTE FUNCTION validate_schedule_occurrence();
CREATE FUNCTION prevent_schedule_occurrence_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'schedule occurrence history cannot be deleted' USING ERRCODE='check_violation'; END;
$$;
CREATE TRIGGER "ScheduleOccurrence_append_only_delete" BEFORE DELETE ON "ScheduleOccurrence" FOR EACH ROW EXECUTE FUNCTION prevent_schedule_occurrence_delete();
