CREATE TABLE "Budget" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "rolloverPolicy" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "changeRevision" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" UUID,
    "supersededAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id", "userId"),
    CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Budget_supersedes_fkey" FOREIGN KEY ("supersedesId", "userId") REFERENCES "Budget"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Budget_category_check" CHECK (length(btrim("categoryId")) BETWEEN 1 AND 80),
    CONSTRAINT "Budget_amount_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 9007199254740991),
    CONSTRAINT "Budget_currency_check" CHECK ("currency" IN ('PKR','USD','GBP','EUR','AED','SAR')),
    CONSTRAINT "Budget_period_check" CHECK ("periodStart" < "periodEnd"),
    CONSTRAINT "Budget_rollover_check" CHECK ("rolloverPolicy" IN ('reset','carry_unused')),
    CONSTRAINT "Budget_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "Budget_changeRevision_check" CHECK ("changeRevision" > 0),
    CONSTRAINT "Budget_supersede_shape_check" CHECK (("revision" = 1 AND "supersedesId" IS NULL) OR ("revision" > 1 AND "supersedesId" IS NOT NULL))
);

CREATE UNIQUE INDEX "Budget_revision_unique" ON "Budget"("userId", "categoryId", "currency", "periodStart", "revision");
CREATE INDEX "Budget_owner_period_idx" ON "Budget"("userId", "periodStart", "periodEnd", "currency");
CREATE INDEX "Budget_owner_category_history_idx" ON "Budget"("userId", "categoryId", "currency", "periodStart", "revision" DESC);
CREATE UNIQUE INDEX "Budget_one_current_idx" ON "Budget"("userId", "categoryId", "currency", "periodStart")
  WHERE "supersededAt" IS NULL AND "archivedAt" IS NULL;

CREATE FUNCTION protect_budget_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
    OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
    OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
    OR NEW."rolloverPolicy" IS DISTINCT FROM OLD."rolloverPolicy"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (NEW."changeRevision" IS DISTINCT FROM OLD."changeRevision" AND NOT
      (NEW."changeRevision" = OLD."changeRevision" + 1 AND OLD."archivedAt" IS NULL AND NEW."archivedAt" IS NOT NULL))
    OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
    OR (OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt")
    OR (NEW."supersededAt" IS NOT NULL AND NEW."archivedAt" IS NOT NULL)
  THEN RAISE EXCEPTION 'budget revisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Budget_history_guard" BEFORE UPDATE ON "Budget"
  FOR EACH ROW EXECUTE FUNCTION protect_budget_history();
CREATE FUNCTION prevent_budget_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'budget revision history is append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "Budget_append_only_delete" BEFORE DELETE ON "Budget"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_delete();
