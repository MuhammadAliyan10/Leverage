ALTER TABLE "FinanceTransaction" ADD COLUMN "reversalOfId" TEXT;

ALTER TABLE "FinanceTransaction"
  DROP CONSTRAINT "FinanceTransaction_type_check",
  DROP CONSTRAINT "FinanceTransaction_account_shape_check",
  ADD CONSTRAINT "FinanceTransaction_type_check" CHECK ("type" IN ('income', 'expense', 'transfer', 'refund')),
  ADD CONSTRAINT "FinanceTransaction_account_shape_check" CHECK (
    ("type" = 'transfer' AND "accountId" IS NOT NULL AND "toAccountId" IS NOT NULL AND "accountId" <> "toAccountId" AND "refundOfId" IS NULL) OR
    ("type" IN ('income', 'expense') AND "accountId" IS NOT NULL AND "toAccountId" IS NULL AND "refundOfId" IS NULL) OR
    ("type" = 'refund' AND "accountId" IS NOT NULL AND "toAccountId" IS NULL AND "refundOfId" IS NOT NULL)
  );

ALTER TABLE "FinanceTransaction"
  ADD CONSTRAINT "FinanceTransaction_refundOfId_userId_fkey"
    FOREIGN KEY ("refundOfId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinanceTransaction_reversalOfId_userId_fkey"
    FOREIGN KEY ("reversalOfId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FinanceTransaction_correctionOfId_userId_fkey"
    FOREIGN KEY ("correctionOfId", "userId") REFERENCES "FinanceTransaction"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "FinanceTransaction_userId_refundOfId_occurredAt_idx"
  ON "FinanceTransaction"("userId", "refundOfId", "occurredAt");
CREATE INDEX "FinanceTransaction_userId_reversalOfId_idx"
  ON "FinanceTransaction"("userId", "reversalOfId");
CREATE INDEX "FinanceTransaction_userId_correctionOfId_idx"
  ON "FinanceTransaction"("userId", "correctionOfId");

CREATE OR REPLACE FUNCTION validate_finance_transaction_accounts() RETURNS trigger AS $$
DECLARE
  source_currency TEXT;
  destination_currency TEXT;
  source_archived BOOLEAN;
  destination_archived BOOLEAN;
  original_amount BIGINT;
  original_type TEXT;
  original_currency TEXT;
  refunded_amount BIGINT;
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
  IF NEW."type" = 'refund' THEN
    SELECT t."amountMinor", t."type", a."currency"
      INTO original_amount, original_type, original_currency
      FROM "FinanceTransaction" t
      JOIN "FinanceAccount" a ON a."id" = t."accountId" AND a."userId" = t."userId"
      WHERE t."id" = NEW."refundOfId" AND t."userId" = NEW."userId"
      FOR UPDATE OF t;
    IF NOT FOUND OR original_type <> 'expense' OR original_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'refund must reference an owned expense in the same currency' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM("amountMinor"), 0) INTO refunded_amount
      FROM "FinanceTransaction" WHERE "userId" = NEW."userId" AND "type" = 'refund' AND "refundOfId" = NEW."refundOfId";
    IF NEW."amountMinor" > original_amount - refunded_amount THEN
      RAISE EXCEPTION 'refund exceeds the remaining expense amount' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
