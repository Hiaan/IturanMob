-- CreateEnum
CREATE TYPE "TransactionScope" AS ENUM ('PERSONAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ReportScope" AS ENUM ('PERSONAL', 'BUSINESS', 'ALL');

-- AlterEnum
ALTER TYPE "PendingType" ADD VALUE 'NATURE_REVIEW';

-- AlterTable
ALTER TABLE "FinancialRule" ADD COLUMN     "askNature" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "setScope" "TransactionScope";

-- AlterTable
ALTER TABLE "HouseholdSettings" ADD COLUMN     "defaultReportScope" "ReportScope" NOT NULL DEFAULT 'PERSONAL';

-- AlterTable
ALTER TABLE "RecurringTransaction" ADD COLUMN     "scope" "TransactionScope" NOT NULL DEFAULT 'PERSONAL';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "natureReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scope" "TransactionScope" NOT NULL DEFAULT 'PERSONAL';

-- CreateIndex
CREATE INDEX "Transaction_householdId_scope_idx" ON "Transaction"("householdId", "scope");
