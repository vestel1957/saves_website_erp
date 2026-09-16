-- Adjuntos de una tarea: metadata en BD, binario en uploads/tasks/<taskId>/
CREATE TABLE "TodoTaskFile" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TodoTaskFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TodoTaskFile_taskId_idx" ON "TodoTaskFile"("taskId");

ALTER TABLE "TodoTaskFile" ADD CONSTRAINT "TodoTaskFile_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TodoTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
