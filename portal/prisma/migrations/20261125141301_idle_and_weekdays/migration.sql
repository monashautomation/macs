-- AlterTable
ALTER TABLE "vms" ADD COLUMN     "idleCheckAfter" TIMESTAMP(3),
ADD COLUMN     "idleWarnedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleDays" TEXT NOT NULL DEFAULT '';
