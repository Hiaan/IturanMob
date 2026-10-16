-- Rendimento automático de contas de investimento (CDI, Selic, IPCA, prefixado).
-- CreateEnum
CREATE TYPE "YieldIndex" AS ENUM ('CDI', 'SELIC', 'IPCA', 'PREFIXED');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "yieldIndex" "YieldIndex",
ADD COLUMN     "yieldRateBps" INTEGER,
ADD COLUMN     "yieldStartDate" DATE;

-- CreateTable
CREATE TABLE "IndexRate" (
    "id" TEXT NOT NULL,
    "index" "YieldIndex" NOT NULL,
    "date" DATE NOT NULL,
    "ratePct" DECIMAL(14,8) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'BCB-SGS',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentYield" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "transactionId" TEXT,
    "grossCents" INTEGER NOT NULL,
    "businessDays" INTEGER NOT NULL,
    "accruedThrough" DATE NOT NULL,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentYield_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IndexRate_index_date_key" ON "IndexRate"("index", "date");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentYield_transactionId_key" ON "InvestmentYield"("transactionId");

-- CreateIndex
CREATE INDEX "InvestmentYield_householdId_idx" ON "InvestmentYield"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentYield_accountId_month_key" ON "InvestmentYield"("accountId", "month");

-- AddForeignKey
ALTER TABLE "InvestmentYield" ADD CONSTRAINT "InvestmentYield_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentYield" ADD CONSTRAINT "InvestmentYield_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentYield" ADD CONSTRAINT "InvestmentYield_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

