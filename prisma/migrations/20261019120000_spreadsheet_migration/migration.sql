-- Migração de planilha (aditiva): novas tabelas, novo enum, novos valores de formato e coluna opcional em ImportBatch.

-- CreateEnum
CREATE TYPE "SpreadsheetMigrationStatus" AS ENUM ('READING', 'READY', 'PREVIEWING', 'PREVIEW', 'COMMITTING', 'IMPORTED', 'UNDONE', 'DISCARDED', 'FAILED');

-- AlterEnum (aditivo: novos formatos da migração de planilha)
ALTER TYPE "ImportFormat" ADD VALUE 'XLS';
ALTER TYPE "ImportFormat" ADD VALUE 'ODS';

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "migrationId" TEXT;

-- CreateTable
CREATE TABLE "SpreadsheetMigration" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "storageKey" TEXT,
    "status" "SpreadsheetMigrationStatus" NOT NULL DEFAULT 'READING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressLabel" TEXT,
    "error" TEXT,
    "sheets" JSONB,
    "correspondences" JSONB,
    "options" JSONB,
    "summary" JSONB,
    "templateId" TEXT,
    "origin" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "SpreadsheetMigration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpreadsheetTemplate" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpreadsheetTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpreadsheetMigration_householdId_createdAt_idx" ON "SpreadsheetMigration"("householdId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpreadsheetTemplate_householdId_signature_key" ON "SpreadsheetTemplate"("householdId", "signature");

-- CreateIndex
CREATE INDEX "ImportBatch_migrationId_idx" ON "ImportBatch"("migrationId");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "SpreadsheetMigration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpreadsheetMigration" ADD CONSTRAINT "SpreadsheetMigration_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpreadsheetMigration" ADD CONSTRAINT "SpreadsheetMigration_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SpreadsheetTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpreadsheetTemplate" ADD CONSTRAINT "SpreadsheetTemplate_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

