-- AlterTable
ALTER TABLE "HouseholdMember" ADD COLUMN     "defaultAccountId" TEXT,
ADD COLUMN     "defaultPaymentMethod" "PaymentMethod";
-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_defaultAccountId_fkey" FOREIGN KEY ("defaultAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
