-- Secuencia para el número de abonado.
--
-- Se generaba con MAX(abonado)+1 y, a diferencia del `tid` de los documentos, la
-- columna NO tiene restricción de unicidad: dos altas simultáneas no fallan, se
-- duplican en silencio. Con la secuencia el número es atómico.
--
-- NO se añade `UNIQUE` a la columna, y es una decisión medida, no un olvido: hoy
-- hay 4.224 números repartidos en 11.396 filas (el 52 % del padrón), heredados del
-- legacy. Aun excluyendo DEPURADO/RETIRADO quedan 495 duplicados entre cuentas
-- vivas, así que la restricción no se podría crear sin reasignar números a clientes
-- reales. El sistema ya está diseñado para convivir con ello: el portal empareja
-- abonado + documento (sólo 3 pares colisionan, 1 con más de una fila viva) y
-- prefiere la cuenta vigente.
--
-- Lo que esto sí consigue: dejar de FABRICAR duplicados nuevos.

CREATE SEQUENCE IF NOT EXISTS "Subscriber_abonado_seq" AS integer;
SELECT setval(
  '"Subscriber_abonado_seq"',
  COALESCE((SELECT MAX(abonado) FROM "Subscriber"), 1),
  (SELECT COUNT(*) FROM "Subscriber") > 0
);
