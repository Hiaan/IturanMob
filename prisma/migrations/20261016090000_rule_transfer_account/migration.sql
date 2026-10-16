-- Regras que transformam a movimentação em transferência (investimentos e contas próprias).
ALTER TABLE "FinancialRule" ADD COLUMN "setTransferAccountId" TEXT;
ALTER TABLE "FinancialRule" ADD CONSTRAINT "FinancialRule_setTransferAccountId_fkey" FOREIGN KEY ("setTransferAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
