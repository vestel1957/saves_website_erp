-- Consecutivo de ORDEN (`Ticket.code`) en un rango propio, servido por secuencia.
--
-- El problema (detectado 2026-08-11): `nextCode` hacía `MAX(code)+1` sobre `Ticket`,
-- y los dos sistemas reparten del MISMO contador. El legacy iba en 325.978 mientras
-- PG estaba congelado en 319.537 (las órdenes del legacy no bajaban: no había paso
-- de `tickets` en el sync), así que nexus entregó 319.538-319.544 — siete códigos que
-- el legacy YA había usado para trabajos distintos.
--
-- Y no falla ruidosamente: en el legacy `codigo` NO es único a propósito (una orden
-- puede tener varios tickets), así que una orden empujada con un código ya usado se
-- mete callada bajo una orden ajena. Igual que el `tid` de las facturas, la salida es
-- PARTIR EL RANGO: el legacy sigue en su corrida natural y nexus numera desde 500.000.
-- Así nunca chocan, el número se fija al crear y no cambia, y el origen se ve de un
-- vistazo. Ver common/tid.ts y la migración 20260720000000_tid_sequences.

CREATE SEQUENCE IF NOT EXISTS "Ticket_code_seq" AS integer;

-- Arranca en 500.000 (primer nextval = 500.001). Si ya hubiera órdenes propias dentro
-- del rango nuevo, sigue desde la mayor para no repetir.
SELECT setval(
  '"Ticket_code_seq"',
  GREATEST(500000, COALESCE((SELECT MAX(code) FROM "Ticket" WHERE code >= 500000), 500000)),
  true
);

-- Renumerado de las órdenes propias que quedaron en el rango del legacy.
-- Sólo las nacidas aquí (`legacyId IS NULL`): las del legacy conservan su número.
CREATE TEMP TABLE _renum AS
SELECT id, code AS code_viejo, nextval('"Ticket_code_seq"')::int AS code_nuevo
FROM "Ticket"
WHERE "legacyId" IS NULL AND code IS NOT NULL AND code < 500000
ORDER BY code;

-- El hilo se une a la orden por `ticketCode`, así que hay que moverlo con ella. Sólo
-- los mensajes nacidos aquí: un hilo de origen legacy (`legacyId` no nulo) pertenece
-- SIEMPRE a la orden del legacy que lleva ese mismo número, no a la nuestra — que es
-- justamente la ambigüedad que este cambio viene a cerrar.
UPDATE "TicketThread" th
SET "ticketCode" = r.code_nuevo
FROM _renum r
WHERE th."ticketCode" = r.code_viejo AND th."legacyId" IS NULL;

UPDATE "Ticket" t
SET code = r.code_nuevo
FROM _renum r
WHERE t.id = r.id;

DROP TABLE _renum;
