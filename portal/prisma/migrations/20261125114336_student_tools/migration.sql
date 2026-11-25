-- AlterTable
ALTER TABLE "setups" ADD COLUMN     "listed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "steps" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "vms" ADD COLUMN     "autoStart" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "autoStop" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "expired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "expiryWarnedAt" TIMESTAMP(3),
ADD COLUMN     "labId" TEXT,
ADD COLUMN     "labRole" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastAutoStart" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastAutoStop" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "scheduleTz" TEXT NOT NULL DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "vm_shares" (
    "id" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vm_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labs" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blueprint" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vm_shares_userId_idx" ON "vm_shares"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "vm_shares_vmId_userId_key" ON "vm_shares"("vmId", "userId");

-- CreateIndex
CREATE INDEX "labs_ownerId_idx" ON "labs"("ownerId");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "vms_labId_idx" ON "vms"("labId");

-- AddForeignKey
ALTER TABLE "vms" ADD CONSTRAINT "vms_labId_fkey" FOREIGN KEY ("labId") REFERENCES "labs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vm_shares" ADD CONSTRAINT "vm_shares_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "vms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vm_shares" ADD CONSTRAINT "vm_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labs" ADD CONSTRAINT "labs_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
