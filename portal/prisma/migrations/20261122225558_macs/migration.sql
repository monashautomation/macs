/*
  Warnings:

  - You are about to drop the `notes` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "notes" DROP CONSTRAINT "notes_ownerId_fkey";

-- DropTable
DROP TABLE "notes";

-- CreateTable
CREATE TABLE "profiles" (
    "userId" TEXT NOT NULL,
    "sshPublicKey" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "vms" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "vmid" INTEGER,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "imageSlug" TEXT NOT NULL DEFAULT '',
    "cores" INTEGER NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "diskGb" INTEGER NOT NULL,
    "sshPublicKey" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "gpuAccess" TEXT NOT NULL DEFAULT 'none',
    "justification" TEXT NOT NULL DEFAULT '',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "reviewedById" TEXT,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'template',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "os" TEXT NOT NULL DEFAULT 'linux',
    "vmid" INTEGER,
    "volid" TEXT NOT NULL DEFAULT '',
    "defaultUser" TEXT NOT NULL DEFAULT '',
    "cicustom" TEXT NOT NULL DEFAULT '',
    "gpuReady" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connect" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'tcp',
    "scheme" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "gpuId" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "volid" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "vmId" TEXT,
    "userId" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vms_ownerId_idx" ON "vms"("ownerId");

-- CreateIndex
CREATE INDEX "vms_clusterId_status_idx" ON "vms"("clusterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "images_clusterId_slug_key" ON "images"("clusterId", "slug");

-- CreateIndex
CREATE INDEX "services_vmId_idx" ON "services"("vmId");

-- CreateIndex
CREATE INDEX "reservations_clusterId_status_idx" ON "reservations"("clusterId", "status");

-- CreateIndex
CREATE INDEX "reservations_vmId_idx" ON "reservations"("vmId");

-- CreateIndex
CREATE INDEX "backups_vmId_idx" ON "backups"("vmId");

-- CreateIndex
CREATE INDEX "jobs_vmId_idx" ON "jobs"("vmId");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "audit_at_idx" ON "audit"("at");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vms" ADD CONSTRAINT "vms_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vms" ADD CONSTRAINT "vms_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "vms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "vms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "vms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "vms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit" ADD CONSTRAINT "audit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A VM can have only one running job. Enforced here (not expressible in the
-- Prisma schema) so two requests racing to start work on the same VM cannot both win.
CREATE UNIQUE INDEX "jobs_one_running_per_vm" ON "jobs"("vmId") WHERE "status" = 'running';
