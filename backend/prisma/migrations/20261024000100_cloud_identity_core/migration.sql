-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncRevision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "openingBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id","userId")
);

-- CreateTable
CREATE TABLE "FinanceTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "classificationId" TEXT NOT NULL,
    "categoryLabel" TEXT NOT NULL,
    "accountId" TEXT,
    "toAccountId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "paymentMethod" TEXT,
    "sourceName" TEXT,
    "sourceAmountMinor" BIGINT,
    "sourceCurrency" TEXT,
    "exchangeRate" TEXT,
    "referenceNumber" TEXT,
    "taxStatus" TEXT NOT NULL DEFAULT 'unreviewed',
    "taxYear" INTEGER,
    "refundOfId" TEXT,
    "correctionOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceTransaction_pkey" PRIMARY KEY ("id","userId")
);

-- CreateTable
CREATE TABLE "MutationReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mutationType" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transactionId" TEXT,

    CONSTRAINT "MutationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "sequence" BIGSERIAL NOT NULL,
    "cursor" BIGINT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("sequence")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthAccount_userId_idx" ON "AuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccount_providerId_accountId_key" ON "AuthAccount"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");

-- CreateIndex
CREATE INDEX "FinanceAccount_userId_archivedAt_createdAt_idx" ON "FinanceAccount"("userId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceTransaction_userId_occurredAt_id_idx" ON "FinanceTransaction"("userId", "occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "FinanceTransaction_userId_type_occurredAt_idx" ON "FinanceTransaction"("userId", "type", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "FinanceTransaction_userId_classificationId_occurredAt_idx" ON "FinanceTransaction"("userId", "classificationId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "MutationReceipt_userId_createdAt_idx" ON "MutationReceipt"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MutationReceipt_userId_idempotencyKey_key" ON "MutationReceipt"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MutationReceipt_transactionId_userId_key" ON "MutationReceipt"("transactionId", "userId");

-- CreateIndex
CREATE INDEX "ChangeLog_userId_cursor_idx" ON "ChangeLog"("userId", "cursor");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeLog_userId_entityType_entityId_revision_key" ON "ChangeLog"("userId", "entityType", "entityId", "revision");
CREATE UNIQUE INDEX "ChangeLog_userId_cursor_key" ON "ChangeLog"("userId", "cursor");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccount" ADD CONSTRAINT "AuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_accountId_userId_fkey" FOREIGN KEY ("accountId", "userId") REFERENCES "FinanceAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_toAccountId_userId_fkey" FOREIGN KEY ("toAccountId", "userId") REFERENCES "FinanceAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MutationReceipt" ADD CONSTRAINT "MutationReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MutationReceipt" ADD CONSTRAINT "MutationReceipt_transactionId_userId_fkey" FOREIGN KEY ("transactionId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce normalized unique email identity even if an alternate client bypasses Better Auth.
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));

ALTER TABLE "FinanceAccount"
  ADD CONSTRAINT "FinanceAccount_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "FinanceAccount_name_nonempty_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "FinanceAccount_type_check" CHECK ("type" IN ('cash', 'bank', 'wallet', 'savings'));

ALTER TABLE "FinanceTransaction"
  ADD CONSTRAINT "FinanceTransaction_amount_positive_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "FinanceTransaction_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "FinanceTransaction_type_check" CHECK ("type" IN ('income', 'expense', 'transfer')),
  ADD CONSTRAINT "FinanceTransaction_account_shape_check" CHECK (
    ("type" = 'transfer' AND "accountId" IS NOT NULL AND "toAccountId" IS NOT NULL AND "accountId" <> "toAccountId") OR
    ("type" IN ('income', 'expense') AND "accountId" IS NOT NULL AND "toAccountId" IS NULL)
  ),
  ADD CONSTRAINT "FinanceTransaction_tax_status_check" CHECK ("taxStatus" IN ('unreviewed', 'taxable', 'non_taxable', 'exempt', 'not_applicable')),
  ADD CONSTRAINT "FinanceTransaction_source_amount_check" CHECK ("sourceAmountMinor" IS NULL OR "sourceAmountMinor" > 0),
  ADD CONSTRAINT "FinanceTransaction_source_fields_check" CHECK (
    ("sourceAmountMinor" IS NULL AND "sourceCurrency" IS NULL AND "exchangeRate" IS NULL) OR
    ("sourceAmountMinor" IS NOT NULL AND "sourceCurrency" ~ '^[A-Z]{3}$' AND length("exchangeRate") > 0)
  );

CREATE FUNCTION validate_finance_transaction_accounts() RETURNS trigger AS $$
DECLARE
  source_currency TEXT;
  destination_currency TEXT;
  source_archived BOOLEAN;
  destination_archived BOOLEAN;
BEGIN
  IF NEW."accountId" IS NOT NULL THEN
    SELECT "currency", "archivedAt" IS NOT NULL INTO STRICT source_currency, source_archived
      FROM "FinanceAccount" WHERE "id" = NEW."accountId" AND "userId" = NEW."userId";
    IF source_archived THEN
      RAISE EXCEPTION 'archived account cannot receive a posted transaction' USING ERRCODE = '23514';
    END IF;
    IF source_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'transaction currency must match its account currency' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."toAccountId" IS NOT NULL THEN
    SELECT "currency", "archivedAt" IS NOT NULL INTO STRICT destination_currency, destination_archived
      FROM "FinanceAccount" WHERE "id" = NEW."toAccountId" AND "userId" = NEW."userId";
    IF destination_archived THEN
      RAISE EXCEPTION 'archived account cannot receive a transfer' USING ERRCODE = '23514';
    END IF;
    IF destination_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'transfer currency must match both account currencies' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinanceTransaction_account_validation"
  BEFORE INSERT ON "FinanceTransaction"
  FOR EACH ROW EXECUTE FUNCTION validate_finance_transaction_accounts();

-- Posted finance rows are append-only. Refunds and corrections must be new linked events.
CREATE FUNCTION prevent_financial_transaction_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'posted financial transactions are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinanceTransaction_append_only"
  BEFORE UPDATE OR DELETE ON "FinanceTransaction"
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_transaction_mutation();
