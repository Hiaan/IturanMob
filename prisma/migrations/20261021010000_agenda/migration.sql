-- Agenda, resumo da manhã e Google Agenda (aditiva).
-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('MANUAL', 'WHATSAPP', 'GOOGLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MORNING_SUMMARY';

-- AlterTable
ALTER TABLE "HouseholdSettings" ADD COLUMN     "morningSummaryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "morningSummaryHour" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "notes" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "ownerMemberId" TEXT,
    "reminderMinutes" INTEGER DEFAULT 60,
    "source" "AppointmentSource" NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "googleConnectionId" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleOAuthApp" (
    "householdId" TEXT NOT NULL,
    "clientIdEnc" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleOAuthApp_pkey" PRIMARY KEY ("householdId")
);

-- CreateTable
CREATE TABLE "GoogleCalendarConnection" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "shareWithFamily" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_householdId_startsAt_idx" ON "Appointment"("householdId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_googleConnectionId_externalId_key" ON "Appointment"("googleConnectionId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCalendarConnection_memberId_key" ON "GoogleCalendarConnection"("memberId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_googleConnectionId_fkey" FOREIGN KEY ("googleConnectionId") REFERENCES "GoogleCalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleOAuthApp" ADD CONSTRAINT "GoogleOAuthApp_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarConnection" ADD CONSTRAINT "GoogleCalendarConnection_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarConnection" ADD CONSTRAINT "GoogleCalendarConnection_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

