-- Seguimiento de una tarea: lo que se hizo, quién lo escribió y la foto de evidencia.
-- Es a la tarea lo que TicketThread es a la orden de servicio.
CREATE TABLE "TodoTaskNote" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "message" TEXT,
    "stage" TEXT,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "authorName" TEXT,
    "authorId" TEXT,
    "employeeId" INTEGER NOT NULL DEFAULT 0,
    "attach" TEXT,
    "attachName" TEXT,
    "geoLat" TEXT,
    "geoLng" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TodoTaskNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TodoTaskNote_taskId_createdAt_idx" ON "TodoTaskNote"("taskId", "createdAt");

ALTER TABLE "TodoTaskNote" ADD CONSTRAINT "TodoTaskNote_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TodoTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
