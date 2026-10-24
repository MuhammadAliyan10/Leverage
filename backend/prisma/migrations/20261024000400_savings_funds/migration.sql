CREATE TABLE "SavingsGoal" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "targetMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "targetDate" DATE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "completedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id", "userId"),
  CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SavingsGoal_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 100),
  CONSTRAINT "SavingsGoal_target_check" CHECK ("targetMinor" > 0 AND "targetMinor" <= 9007199254740991),
  CONSTRAINT "SavingsGoal_currency_check" CHECK ("currency" IN ('PKR','USD','GBP','EUR','AED','SAR')),
  CONSTRAINT "SavingsGoal_status_check" CHECK ("status" IN ('active','completed','archived')),
  CONSTRAINT "SavingsGoal_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "SavingsGoal_owner_status_idx" ON "SavingsGoal"("userId", "status", "createdAt");

CREATE TABLE "SavingsGoalEvent" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "goalId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "accountId" TEXT,
  "transactionId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "eventDate" TIMESTAMP(3) NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavingsGoalEvent_pkey" PRIMARY KEY ("id", "userId"),
  CONSTRAINT "SavingsGoalEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SavingsGoalEvent_goal_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "SavingsGoal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SavingsGoalEvent_account_fkey" FOREIGN KEY ("accountId", "userId") REFERENCES "FinanceAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SavingsGoalEvent_transaction_fkey" FOREIGN KEY ("transactionId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SavingsGoalEvent_amount_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 9007199254740991),
  CONSTRAINT "SavingsGoalEvent_currency_check" CHECK ("currency" IN ('PKR','USD','GBP','EUR','AED','SAR')),
  CONSTRAINT "SavingsGoalEvent_type_check" CHECK ("eventType" IN ('planned','allocate','release','transfer_in','transfer_out')),
  CONSTRAINT "SavingsGoalEvent_shape_check" CHECK (
    ("eventType" = 'planned' AND "accountId" IS NULL AND "transactionId" IS NULL) OR
    ("eventType" IN ('allocate','release') AND "accountId" IS NOT NULL AND "transactionId" IS NULL) OR
    ("eventType" IN ('transfer_in','transfer_out') AND "accountId" IS NOT NULL AND "transactionId" IS NOT NULL)
  ),
  CONSTRAINT "SavingsGoalEvent_note_check" CHECK (length("note") <= 1000)
);
CREATE UNIQUE INDEX "SavingsGoalEvent_idempotency_idx" ON "SavingsGoalEvent"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "SavingsGoalEvent_transaction_idx" ON "SavingsGoalEvent"("transactionId", "userId");
CREATE INDEX "SavingsGoalEvent_owner_goal_date_idx" ON "SavingsGoalEvent"("userId", "goalId", "eventDate", "id");
CREATE INDEX "SavingsGoalEvent_owner_account_idx" ON "SavingsGoalEvent"("userId", "accountId", "eventDate");

CREATE TABLE "EmergencyFundConfig" (
  "userId" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "coverageMonths" INTEGER NOT NULL,
  "essentialMonthlyMinor" BIGINT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmergencyFundConfig_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "EmergencyFundConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmergencyFundConfig_currency_check" CHECK ("currency" IN ('PKR','USD','GBP','EUR','AED','SAR')),
  CONSTRAINT "EmergencyFundConfig_months_check" CHECK ("coverageMonths" BETWEEN 1 AND 60),
  CONSTRAINT "EmergencyFundConfig_essential_check" CHECK ("essentialMonthlyMinor" >= 0 AND "essentialMonthlyMinor" <= 9007199254740991),
  CONSTRAINT "EmergencyFundConfig_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "EmergencyFundEvent" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "transactionId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "eventDate" TIMESTAMP(3) NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmergencyFundEvent_pkey" PRIMARY KEY ("id", "userId"),
  CONSTRAINT "EmergencyFundEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmergencyFundEvent_account_fkey" FOREIGN KEY ("accountId", "userId") REFERENCES "FinanceAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmergencyFundEvent_transaction_fkey" FOREIGN KEY ("transactionId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmergencyFundEvent_amount_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 9007199254740991),
  CONSTRAINT "EmergencyFundEvent_currency_check" CHECK ("currency" IN ('PKR','USD','GBP','EUR','AED','SAR')),
  CONSTRAINT "EmergencyFundEvent_type_check" CHECK ("eventType" IN ('allocate','release','transfer_in','transfer_out')),
  CONSTRAINT "EmergencyFundEvent_shape_check" CHECK (
    ("eventType" IN ('allocate','release') AND "transactionId" IS NULL) OR
    ("eventType" IN ('transfer_in','transfer_out') AND "transactionId" IS NOT NULL)
  ),
  CONSTRAINT "EmergencyFundEvent_note_check" CHECK (length("note") <= 1000)
);
CREATE UNIQUE INDEX "EmergencyFundEvent_idempotency_idx" ON "EmergencyFundEvent"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "EmergencyFundEvent_transaction_idx" ON "EmergencyFundEvent"("transactionId", "userId");
CREATE INDEX "EmergencyFundEvent_owner_date_idx" ON "EmergencyFundEvent"("userId", "eventDate", "id");
CREATE INDEX "EmergencyFundEvent_owner_account_idx" ON "EmergencyFundEvent"("userId", "accountId", "eventDate");

CREATE FUNCTION validate_savings_goal_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE goal_currency TEXT; account_currency TEXT; tx "FinanceTransaction"%ROWTYPE;
BEGIN
  SELECT "currency" INTO STRICT goal_currency FROM "SavingsGoal" WHERE "id"=NEW."goalId" AND "userId"=NEW."userId";
  IF goal_currency <> NEW."currency" THEN RAISE EXCEPTION 'savings goal currency mismatch' USING ERRCODE='check_violation'; END IF;
  IF NEW."accountId" IS NOT NULL THEN
    SELECT "currency" INTO STRICT account_currency FROM "FinanceAccount" WHERE "id"=NEW."accountId" AND "userId"=NEW."userId";
    IF account_currency <> NEW."currency" THEN RAISE EXCEPTION 'savings account currency mismatch' USING ERRCODE='check_violation'; END IF;
  END IF;
  IF NEW."transactionId" IS NOT NULL THEN
    SELECT * INTO STRICT tx FROM "FinanceTransaction" WHERE "id"=NEW."transactionId" AND "userId"=NEW."userId";
    IF tx."type" <> 'transfer' OR tx."amountMinor" <> NEW."amountMinor" OR tx."currency" <> NEW."currency"
      OR (NEW."eventType"='transfer_in' AND tx."toAccountId" <> NEW."accountId")
      OR (NEW."eventType"='transfer_out' AND tx."accountId" <> NEW."accountId")
    THEN RAISE EXCEPTION 'savings transfer does not match its cash transaction' USING ERRCODE='check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SavingsGoalEvent_validate" BEFORE INSERT ON "SavingsGoalEvent" FOR EACH ROW EXECUTE FUNCTION validate_savings_goal_event();

CREATE FUNCTION validate_emergency_fund_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config_currency TEXT; account_currency TEXT; tx "FinanceTransaction"%ROWTYPE;
BEGIN
  SELECT "currency" INTO STRICT config_currency FROM "EmergencyFundConfig" WHERE "userId"=NEW."userId";
  SELECT "currency" INTO STRICT account_currency FROM "FinanceAccount" WHERE "id"=NEW."accountId" AND "userId"=NEW."userId";
  IF config_currency <> NEW."currency" OR account_currency <> NEW."currency" THEN RAISE EXCEPTION 'emergency fund currency mismatch' USING ERRCODE='check_violation'; END IF;
  IF NEW."transactionId" IS NOT NULL THEN
    SELECT * INTO STRICT tx FROM "FinanceTransaction" WHERE "id"=NEW."transactionId" AND "userId"=NEW."userId";
    IF tx."type" <> 'transfer' OR tx."amountMinor" <> NEW."amountMinor" OR tx."currency" <> NEW."currency"
      OR (NEW."eventType"='transfer_in' AND tx."toAccountId" <> NEW."accountId")
      OR (NEW."eventType"='transfer_out' AND tx."accountId" <> NEW."accountId")
    THEN RAISE EXCEPTION 'emergency transfer does not match its cash transaction' USING ERRCODE='check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmergencyFundEvent_validate" BEFORE INSERT ON "EmergencyFundEvent" FOR EACH ROW EXECUTE FUNCTION validate_emergency_fund_event();

CREATE FUNCTION prevent_savings_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'savings event history is append-only' USING ERRCODE='check_violation'; END;
$$;
CREATE TRIGGER "SavingsGoalEvent_append_only" BEFORE UPDATE OR DELETE ON "SavingsGoalEvent" FOR EACH ROW EXECUTE FUNCTION prevent_savings_event_mutation();
CREATE TRIGGER "EmergencyFundEvent_append_only" BEFORE UPDATE OR DELETE ON "EmergencyFundEvent" FOR EACH ROW EXECUTE FUNCTION prevent_savings_event_mutation();
