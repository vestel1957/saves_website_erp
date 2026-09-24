-- Fecha en que se realizó la tarea. Se sella al pasarla a Hecha; el legacy no la guardaba.
ALTER TABLE "TodoTask" ADD COLUMN "doneDate" DATE;

-- Lo cerrado desde el ERP sí deja rastro: el renglón automático «estado: … → Hecha»
-- del seguimiento. Se toma el ÚLTIMO (si se reabrió y se volvió a cerrar, vale el
-- último cierre), en día de Colombia.
UPDATE "TodoTask" t
SET "doneDate" = sub.dia
FROM (
  SELECT DISTINCT ON ("taskId") "taskId",
         (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Bogota')::date AS dia
  FROM "TodoTaskNote"
  WHERE auto AND message LIKE '%→ Hecha%'
  ORDER BY "taskId", "createdAt" DESC
) sub
WHERE t.id = sub."taskId" AND t.status = 'DONE';

-- Creadas en el ERP ya como Hechas (no hubo cambio de estado): el día en que se crearon.
UPDATE "TodoTask" t
SET "doneDate" = sub.dia
FROM (
  SELECT DISTINCT ON ("taskId") "taskId",
         (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Bogota')::date AS dia
  FROM "TodoTaskNote"
  WHERE auto AND message = 'Tarea creada.'
  ORDER BY "taskId", "createdAt" ASC
) sub
WHERE t.id = sub."taskId" AND t.status = 'DONE' AND t."doneDate" IS NULL
  AND t."createdBySource" IS DISTINCT FROM 'LEGACY';
