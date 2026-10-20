-- Notificações e metas (aditiva): meta de ganho, avisos de metas de economia, conta vencida,
-- fatura perto de vencer, pop-ups no app e "pagar depois".

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'INCOME_GOAL';
ALTER TYPE "NotificationType" ADD VALUE 'GOAL_PROGRESS';
ALTER TYPE "NotificationType" ADD VALUE 'BILL_OVERDUE';
ALTER TYPE "NotificationType" ADD VALUE 'STATEMENT_DUE';

-- AlterTable
ALTER TABLE "HouseholdMember" ADD COLUMN     "inAppPopups" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CreditCard" ADD COLUMN     "dueReminderDays" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "ScheduledPayment" ADD COLUMN     "reminderSnoozedUntil" DATE;

-- CreateTable
CREATE TABLE "IncomeGoal" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "scope" "ReportScope" NOT NULL DEFAULT 'ALL',
    "categoryId" TEXT,
    "targetCents" INTEGER NOT NULL,
    "alertThresholds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomeGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertMark" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncomeGoal_householdId_active_idx" ON "IncomeGoal"("householdId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AlertMark_householdId_key_key" ON "AlertMark"("householdId", "key");

-- AddForeignKey
ALTER TABLE "IncomeGoal" ADD CONSTRAINT "IncomeGoal_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeGoal" ADD CONSTRAINT "IncomeGoal_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertMark" ADD CONSTRAINT "AlertMark_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

