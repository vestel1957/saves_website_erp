-- CreateTable
CREATE TABLE "Responsibility" (
    "id" TEXT NOT NULL,
    "post" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notifyWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "Responsibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Responsibility_post_userId_key" ON "Responsibility"("post", "userId");

-- CreateIndex
CREATE INDEX "Responsibility_post_idx" ON "Responsibility"("post");

-- AddForeignKey
ALTER TABLE "Responsibility" ADD CONSTRAINT "Responsibility_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
