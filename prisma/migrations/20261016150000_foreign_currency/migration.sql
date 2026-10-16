-- Contas em moeda estrangeira (PTAX do Banco Central) e transferências entre moedas.
-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'BRL';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "amountBrlCents" INTEGER,
ADD COLUMN     "destinationAmountCents" INTEGER;

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rateBrl" DECIMAL(14,6) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'BCB-PTAX',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_currency_date_key" ON "ExchangeRate"("currency", "date");

