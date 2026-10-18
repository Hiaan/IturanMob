-- Correções aprendidas da transcrição de áudio (por família): "revirante" → "refrigerante".
CREATE TABLE "TranscriptFix" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "wrong" TEXT NOT NULL,
    "wrongDisplay" TEXT NOT NULL,
    "right" TEXT NOT NULL,
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptFix_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TranscriptFix_householdId_wrong_key" ON "TranscriptFix"("householdId", "wrong");

ALTER TABLE "TranscriptFix" ADD CONSTRAINT "TranscriptFix_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
