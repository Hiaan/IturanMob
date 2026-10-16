-- CreateEnum
CREATE TYPE "ReportExclusionReason" AS ENUM ('CLIENT_PASSTHROUGH', 'REIMBURSEMENT', 'OTHER');

-- AlterTable
ALTER TABLE "FinancialRule" ADD COLUMN     "matchAccountId" TEXT,
ADD COLUMN     "matchCreditCardId" TEXT,
ADD COLUMN     "setExcludeFromReports" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "setExclusionParty" TEXT,
ADD COLUMN     "setExclusionReason" "ReportExclusionReason";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "excludedAt" TIMESTAMP(3),
ADD COLUMN     "excludedByMemberId" TEXT,
ADD COLUMN     "excludedFromReports" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exclusionNote" TEXT,
ADD COLUMN     "exclusionParty" TEXT,
ADD COLUMN     "exclusionReason" "ReportExclusionReason";

-- CreateIndex
CREATE INDEX "Transaction_householdId_excludedFromReports_idx" ON "Transaction"("householdId", "excludedFromReports");

-- AddForeignKey
ALTER TABLE "FinancialRule" ADD CONSTRAINT "FinancialRule_matchAccountId_fkey" FOREIGN KEY ("matchAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialRule" ADD CONSTRAINT "FinancialRule_matchCreditCardId_fkey" FOREIGN KEY ("matchCreditCardId") REFERENCES "CreditCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_excludedByMemberId_fkey" FOREIGN KEY ("excludedByMemberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
