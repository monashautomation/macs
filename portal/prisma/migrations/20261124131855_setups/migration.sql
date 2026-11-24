-- AlterTable
ALTER TABLE "vms" ADD COLUMN     "setupSlug" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "setupStatus" TEXT NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "setups" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "script" TEXT NOT NULL,
    "cores" INTEGER NOT NULL DEFAULT 2,
    "memoryMb" INTEGER NOT NULL DEFAULT 2048,
    "diskGb" INTEGER NOT NULL DEFAULT 20,
    "ports" JSONB NOT NULL DEFAULT '[]',
    "afterInstall" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "setups_slug_key" ON "setups"("slug");
