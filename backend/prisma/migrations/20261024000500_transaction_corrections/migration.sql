ALTER TABLE "FinanceTransaction"
  DROP CONSTRAINT "FinanceTransaction_type_check",
  DROP CONSTRAINT "FinanceTransaction_account_shape_check",
  ADD CONSTRAINT "FinanceTransaction_type_check"
    CHECK ("type" IN ('income','expense','transfer','refund','reversal')),
  ADD CONSTRAINT "FinanceTransaction_account_shape_check" CHECK (
    ("type"='transfer' AND "accountId" IS NOT NULL AND "toAccountId" IS NOT NULL AND "accountId"<>"toAccountId"
      AND "refundOfId" IS NULL AND "reversalOfId" IS NULL) OR
    ("type" IN ('income','expense') AND "accountId" IS NOT NULL AND "toAccountId" IS NULL
      AND "refundOfId" IS NULL AND "reversalOfId" IS NULL) OR
    ("type"='refund' AND "accountId" IS NOT NULL AND "toAccountId" IS NULL
      AND "refundOfId" IS NOT NULL AND "reversalOfId" IS NULL AND "correctionOfId" IS NULL) OR
    ("type"='reversal' AND "accountId" IS NOT NULL AND "refundOfId" IS NULL AND "reversalOfId" IS NOT NULL
      AND "correctionOfId" IS NULL AND ("toAccountId" IS NULL OR ("toAccountId"<>"accountId")))
  );

CREATE UNIQUE INDEX "FinanceTransaction_one_reversal_per_original_idx"
  ON "FinanceTransaction"("userId","reversalOfId") WHERE "type"='reversal';
CREATE UNIQUE INDEX "FinanceTransaction_one_correction_per_original_idx"
  ON "FinanceTransaction"("userId","correctionOfId") WHERE "correctionOfId" IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_finance_correction_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original "FinanceTransaction"%ROWTYPE;
BEGIN
  IF NEW."type"='reversal' THEN
    SELECT * INTO original FROM "FinanceTransaction"
      WHERE "id"=NEW."reversalOfId" AND "userId"=NEW."userId" FOR UPDATE;
    IF NOT FOUND OR original."type" NOT IN ('income','expense','transfer') OR
       original."amountMinor"<>NEW."amountMinor" OR original."currency"<>NEW."currency" OR
       original."accountId" IS DISTINCT FROM NEW."accountId" OR original."toAccountId" IS DISTINCT FROM NEW."toAccountId" OR
       original."refundOfId" IS NOT NULL OR
       EXISTS (SELECT 1 FROM "FinanceTransaction" prior WHERE prior."userId"=NEW."userId"
         AND prior."reversalOfId"=original."id" AND prior."type"='reversal') OR
       EXISTS (SELECT 1 FROM "FinanceTransaction" refund WHERE refund."userId"=NEW."userId"
         AND refund."refundOfId"=original."id" AND refund."type"='refund')
    THEN RAISE EXCEPTION 'reversal does not match an available original transaction' USING ERRCODE='check_violation'; END IF;
  ELSIF NEW."type"='refund' AND EXISTS (
    SELECT 1 FROM "FinanceTransaction" reversal WHERE reversal."userId"=NEW."userId"
      AND reversal."reversalOfId"=NEW."refundOfId" AND reversal."type"='reversal'
  ) THEN
    RAISE EXCEPTION 'a corrected expense cannot receive a refund' USING ERRCODE='check_violation';
  ELSIF NEW."correctionOfId" IS NOT NULL THEN
    SELECT * INTO original FROM "FinanceTransaction"
      WHERE "id"=NEW."correctionOfId" AND "userId"=NEW."userId" FOR UPDATE;
    IF NOT FOUND OR original."type" NOT IN ('income','expense','transfer') OR
       NEW."type" NOT IN ('income','expense','transfer') OR
       NOT EXISTS (SELECT 1 FROM "FinanceTransaction" reversal WHERE reversal."userId"=NEW."userId"
         AND reversal."reversalOfId"=original."id" AND reversal."type"='reversal')
    THEN RAISE EXCEPTION 'replacement requires a posted reversal of the original transaction' USING ERRCODE='check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FinanceTransaction_correction_validation"
  BEFORE INSERT ON "FinanceTransaction"
  FOR EACH ROW EXECUTE FUNCTION validate_finance_correction_links();

-- Corrections remain append-only. The only permitted linked rows are an exact reversal
-- and one replacement; the original posted row is never updated or deleted.
