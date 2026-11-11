-- CreateTable
CREATE TABLE "SavedChart" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "createdByMemberId" TEXT,
    "title" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavedChart_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "SavedChart_householdId_createdAt_idx" ON "SavedChart"("householdId", "createdAt");
-- AddForeignKey
ALTER TABLE "SavedChart" ADD CONSTRAINT "SavedChart_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
