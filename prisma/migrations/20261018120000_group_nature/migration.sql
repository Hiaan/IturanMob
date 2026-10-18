-- CreateEnum
CREATE TYPE "UnassignedNatureMode" AS ENUM ('ASK', 'FAMILY_DEFAULT');

-- AlterTable
ALTER TABLE "HouseholdSettings" ADD COLUMN     "whatsappUnassignedNature" "UnassignedNatureMode" NOT NULL DEFAULT 'ASK';

-- AlterTable
ALTER TABLE "WhatsAppGroup" ADD COLUMN     "defaultNature" "TransactionScope";

-- Grupo já autorizado (antes só podia haver um): continua como Pessoa física, sem passar a perguntar.
UPDATE "WhatsAppGroup" SET "defaultNature" = 'PERSONAL' WHERE "isAuthorized" = true AND "defaultNature" IS NULL;
