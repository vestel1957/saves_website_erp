-- Atribución real de la orden a un técnico y tiempos con hora.
--
-- Por qué: `Ticket.assigned` es texto libre y `created`/`finalDate` son DATE sin
-- hora. Con eso, "rendimiento del técnico" solo puede salir mal: se agrupa por
-- erratas de un string y el ciclo se mide en días enteros.
ALTER TABLE "Ticket" ADD COLUMN "assignedStaffId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "assignedAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "resolvedAt" TIMESTAMP(3);

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedStaffId_fkey"
  FOREIGN KEY ("assignedStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El tablero pregunta "métricas de este técnico en este periodo".
CREATE INDEX "Ticket_assignedStaffId_created_idx" ON "Ticket"("assignedStaffId", "created");

-- Relleno hacia atrás. Se verificó contra la base viva: los 24 valores distintos
-- de `assigned` usados en los últimos 180 días cruzan EXACTO contra
-- `Staff.username`, así que esto no adivina nada — lo que no cruza queda en NULL
-- y simplemente no entra al tablero.
UPDATE "Ticket" t
   SET "assignedStaffId" = s.id
  FROM "Staff" s
 WHERE t."assigned" IS NOT NULL
   AND t."assigned" <> ''
   AND s."username" IS NOT NULL
   AND lower(s."username") = lower(trim(t."assigned"));

-- `assignedAt` y `resolvedAt` NO se siembran desde las columnas DATE a propósito.
-- Sembrarlas pondría medianoche en todas y el tiempo de ciclo saldría inventado
-- sin que nadie pueda distinguirlo del real. Quedan en NULL: el tablero mide
-- ciclo solo sobre lo que selle el flujo vivo, y hasta entonces muestra "—".
-- El resto de métricas (volumen, re-visita, evidencia) sí corren sobre histórico.
