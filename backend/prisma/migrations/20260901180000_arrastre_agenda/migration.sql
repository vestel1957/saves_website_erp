-- ARRASTRE DE LA AGENDA AL DÍA SIGUIENTE (2026-09-01).
--
-- Lo que un técnico no alcanzó a resolver deja de quedarse en el día que ya pasó: la
-- tarea `agenda-arrastre` corre cada madrugada y le reescribe `scheduledFor` a hoy.
-- Esta columna guarda el día para el que se agendó la PRIMERA vez, que es lo único
-- que el arrastre borraría: sin ella la tarjeta no podría seguir diciendo "atrasada
-- desde el 27" y una visita que lleva cinco días rodando se vería como una nueva.
ALTER TABLE "Ticket" ADD COLUMN "carriedFrom" DATE;

-- Las que YA estaban atrasadas cuando esto entró: hasta hoy el arrastre era sólo de
-- lectura (se pintaban en hoy conservando su día), así que su origen es el
-- `scheduledFor` que tienen ahora mismo. La primera corrida de la tarea les moverá la
-- fecha, y sin esta línea perderían el día del que vienen.
UPDATE "Ticket"
   SET "carriedFrom" = "scheduledFor"
 WHERE "scheduledFor" < CURRENT_DATE
   AND status IN ('PENDIENTE', 'REALIZANDO');
