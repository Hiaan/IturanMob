-- Conexão com bancos (Open Finance via Meu Pluggy), aditiva.
-- CreateEnum
CREATE TYPE "OpenFinanceProvider" AS ENUM ('PLUGGY', 'SIMULATOR');

-- AlterEnum
ALTER TYPE "ImportFormat" ADD VALUE IF NOT EXISTS 'OPEN_FINANCE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BANK_SYNC';

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "provider" "OpenFinanceProvider" NOT NULL DEFAULT 'PLUGGY',
    "clientIdEnc" TEXT,
    "clientSecretEnc" TEXT,
    "autoImport" BOOLEAN NOT NULL DEFAULT false,
    "initialDays" INTEGER NOT NULL DEFAULT 30,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankItem" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "institutionName" TEXT,
    "status" TEXT,
    "providerUpdatedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccountLink" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "bankItemId" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "name" TEXT NOT NULL,
    "numberLast4" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "balanceCents" INTEGER,
    "balanceAt" TIMESTAMP(3),
    "accountId" TEXT,
    "creditCardId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTransactionDate" DATE,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankConnection_householdId_key" ON "BankConnection"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "BankItem_householdId_itemId_key" ON "BankItem"("householdId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccountLink_householdId_externalAccountId_key" ON "BankAccountLink"("householdId", "externalAccountId");

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankItem" ADD CONSTRAINT "BankItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankItem" ADD CONSTRAINT "BankItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccountLink" ADD CONSTRAINT "BankAccountLink_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccountLink" ADD CONSTRAINT "BankAccountLink_bankItemId_fkey" FOREIGN KEY ("bankItemId") REFERENCES "BankItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccountLink" ADD CONSTRAINT "BankAccountLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccountLink" ADD CONSTRAINT "BankAccountLink_creditCardId_fkey" FOREIGN KEY ("creditCardId") REFERENCES "CreditCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

