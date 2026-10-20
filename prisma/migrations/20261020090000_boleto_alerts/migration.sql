-- Boleto, aviso de falta de dinheiro e assinaturas encontradas (aditiva).

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CASH_SHORTFALL';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_FOUND';

-- CreateEnum
CREATE TYPE "SubscriptionCandidateStatus" AS ENUM ('OPEN', 'ACCEPTED', 'IGNORED');

-- AlterTable
ALTER TABLE "ScheduledPayment" ADD COLUMN IF NOT EXISTS "boletoLine" TEXT;

-- CreateTable
CREATE TABLE "SubscriptionCandidate" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "merchantKey" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "previousAmountCents" INTEGER,
    "occurrences" INTEGER NOT NULL,
    "firstChargeDate" DATE NOT NULL,
    "lastChargeDate" DATE NOT NULL,
    "lastTransactionId" TEXT,
    "categoryId" TEXT,
    "accountId" TEXT,
    "creditCardId" TEXT,
    "status" "SubscriptionCandidateStatus" NOT NULL DEFAULT 'OPEN',
    "recurringTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPayment_householdId_boletoLine_key" ON "ScheduledPayment"("householdId", "boletoLine");

-- CreateIndex
CREATE INDEX "SubscriptionCandidate_householdId_status_idx" ON "SubscriptionCandidate"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionCandidate_householdId_merchantKey_key" ON "SubscriptionCandidate"("householdId", "merchantKey");

-- AddForeignKey
ALTER TABLE "SubscriptionCandidate" ADD CONSTRAINT "SubscriptionCandidate_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
