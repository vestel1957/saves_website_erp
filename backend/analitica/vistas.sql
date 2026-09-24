-- ─────────────────────────────────────────────────────────────────────────────
-- Esquema `analitica`: la capa de métricas que lee Metabase.
--
-- Cada indicador se define UNA sola vez aquí, con los mismos filtros que el panel
-- ejecutivo (`dashboard.service.ts`): recaudo = ingresos vigentes SIN arrastre de caja
-- ni consignaciones internas, facturado = SubInvoice no anulada, etc. Los tableros leen estas vistas y NO
-- las tablas crudas: así nadie vuelve a sumar mal la base facturable ni a contar
-- facturas anuladas.
--
-- Son vistas (no copias): siempre están al día y no hay que sincronizar nada.
-- Las fechas son columnas `date` puras: no hay corrimiento por UTC.
--
-- Fuera de Prisma a propósito (otro esquema): `prisma migrate` no las ve ni las toca.
-- Aplicar (idempotente):
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f backend/analitica/vistas.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS analitica;
COMMENT ON SCHEMA analitica IS 'Capa de métricas para Metabase. Vistas de solo lectura; ver backend/analitica/vistas.sql';

-- Hoy y el último día CERRADO, en hora de Colombia (el servidor está en UTC).
CREATE OR REPLACE VIEW analitica.calendario AS
SELECT (now() AT TIME ZONE 'America/Bogota')::date       AS hoy,
       (now() AT TIME ZONE 'America/Bogota')::date - 1   AS ultimo_dia_cerrado;

-- ── Flujos diarios (se pueden sumar en cualquier rango) ──────────────────────

CREATE OR REPLACE VIEW analitica.recaudo_diario AS
SELECT t.date                        AS fecha,
       COALESCE(b.name, 'Sin sede')  AS sede,
       SUM(t.credit)                 AS recaudo,
       COUNT(*)                      AS pagos
  FROM "Transaction" t
  LEFT JOIN "Subscriber" s ON s.id = t."subscriberId"
  LEFT JOIN "Branch" b     ON b.id = s."branchId"
 WHERE t.status = 'VIGENTE' AND t.type = 'INCOME'
   -- Fuera los movimientos internos, igual que el panel ejecutivo (SIN_MOVIMIENTO_INTERNO
   -- en dashboard.service.ts): el arrastre de caja "Saldo AAAA-MM-DD" es el mismo
   -- efectivo que vuelve al cajón cada mañana, y 'Transferencia' son consignaciones
   -- caja→banco. Sin esto agosto da 667 M en vez de 329 M.
   AND (t.note IS NULL OR t.note !~ '^Saldo [0-9]{4}-[0-9]{2}-[0-9]{2}$')
   AND t.category IS DISTINCT FROM 'Transferencia'
 GROUP BY 1, 2;
COMMENT ON VIEW analitica.recaudo_diario IS 'Plata que entró de verdad (ingresos vigentes, sin arrastre de caja ni consignaciones internas) por día y sede. "Sin sede" = ingresos sin abonado o abonado sin sede.';

CREATE OR REPLACE VIEW analitica.facturacion_diaria AS
SELECT i."invoiceDate"               AS fecha,
       COALESCE(b.name, 'Sin sede')  AS sede,
       SUM(i.total)                  AS facturado,
       COUNT(*)                      AS facturas
  FROM "SubInvoice" i
  LEFT JOIN "Subscriber" s ON s.id = i."subscriberId"
  LEFT JOIN "Branch" b     ON b.id = s."branchId"
 WHERE i.status <> 'CANCELED'
 GROUP BY 1, 2;
COMMENT ON VIEW analitica.facturacion_diaria IS 'Facturado (sin anuladas) por fecha de factura y sede.';

-- Abonado nuevo: la MISMA regla que `backend/src/common/abonado-nuevo.ts` (panel ejecutivo).
--  · Solo números de abonado reales (`legacyId`): fuera los clientes de prueba creados en
--    producción ("PRUEBA · DEMO …", 22-ago-2026).
--  · Desde el sync vivo (28-jul-2026), el día del alta es el día en que nació el registro (hora de
--    Colombia). `entryDate` casi no se llena desde agosto (sep: 2 de 48) y la fecha de
--    contrato trae errores de digitación.
--  · Lo que llegó antes del sync vivo (importación del 2026-07-02 y el lote atrasado del
--    27-jul) no tiene fecha de creación real: ingreso o, si falta, contrato (cuando están
--    las dos coinciden en el 100%). Desde el 28-jul la creación cae el día del contrato.
CREATE OR REPLACE VIEW analitica.altas_diarias AS
SELECT CASE WHEN s."createdAt" >= TIMESTAMP '2026-07-28 05:00:00'
            THEN (s."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            ELSE COALESCE(s."entryDate", s."contractDate") END AS fecha,
       COALESCE(b.name, 'Sin sede')                         AS sede,
       COUNT(*)                                             AS altas
  FROM "Subscriber" s
  LEFT JOIN "Branch" b ON b.id = s."branchId"
 WHERE s."legacyId" IS NOT NULL
   AND (s."createdAt" >= TIMESTAMP '2026-07-28 05:00:00' OR COALESCE(s."entryDate", s."contractDate") IS NOT NULL)
 GROUP BY 1, 2;
COMMENT ON VIEW analitica.altas_diarias IS 'Abonados nuevos (números de abonado reales) por día de alta y sede. Misma regla que el panel ejecutivo.';

-- Retiros: la MISMA regla que `backend/src/common/abonado-retirado.ts` (panel ejecutivo).
-- Sale de la FICHA (abonado real que HOY está RETIRADO, en el día en que pasó a ese
-- estado), no del historial: cada retiro deja ahí dos filas y hay rutas que no lo escriben.
-- Un retiro deshecho no cuenta. Tipo:
--  · 'Retiro voluntario': tiene orden de retiro resuelta entre 45 días antes y 3 después.
--  · 'Devolución de equipo': retirado al recoger el equipo (nota del historial).
--  · 'Otro (manual o limpieza)': cambios a mano y limpiezas masivas (249 en marzo de 2025).
-- El motivo es el que se eligió en la orden de retiro (lista cerrada del legacy).
CREATE OR REPLACE VIEW analitica.retiros_diarios AS
-- Con JOINs en bloque y no con subconsultas por fila: la versión fila a fila tardaba
-- 3 s y el comparativo la lee dos veces.
WITH r AS (
  SELECT s.id, s."branchId",
         (s."statusChangedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha
    FROM "Subscriber" s
   WHERE s.status = 'RETIRADO' AND s."legacyId" IS NOT NULL AND s."statusChangedAt" IS NOT NULL
),
o AS (   -- la orden de retiro resuelta más cercana al retiro, si la hay
  SELECT DISTINCT ON (r.id) r.id, k.problem
    FROM r
    JOIN "Ticket" k ON k."subscriberId" = r.id AND k.type = 'Retiro voluntario' AND k.status = 'RESUELTO'
                   AND COALESCE(k."finalDate", k.created) BETWEEN r.fecha - 45 AND r.fecha + 3
   ORDER BY r.id, COALESCE(k."finalDate", k.created) DESC
),
dev AS (
  SELECT DISTINCT h."subscriberId" AS id
    FROM "SubscriberStatusHistory" h
   WHERE h.status = 'RETIRADO' AND h.note ILIKE 'Retiro por devoluci%'
)
SELECT r.fecha,
       COALESCE(b.name, 'Sin sede') AS sede,
       CASE WHEN o.id IS NOT NULL THEN 'Retiro voluntario'
            WHEN dev.id IS NOT NULL THEN 'Devolución de equipo'
            ELSE 'Otro (manual o limpieza)' END AS tipo,
       CASE WHEN o.id IS NULL THEN NULL ELSE COALESCE(NULLIF(trim(o.problem), ''), 'Sin motivo') END AS motivo,
       COUNT(*) AS retiros
  FROM r
  LEFT JOIN "Branch" b ON b.id = r."branchId"
  LEFT JOIN o   ON o.id = r.id
  LEFT JOIN dev ON dev.id = r.id
 GROUP BY 1, 2, 3, 4;
COMMENT ON VIEW analitica.retiros_diarios IS 'Abonados que se retiraron (y siguen retirados) por día, sede, tipo y motivo. Misma regla que el panel ejecutivo.';

CREATE OR REPLACE VIEW analitica.ordenes_diarias AS
SELECT k.created                     AS fecha,
       COALESCE(b.name, 'Sin sede')  AS sede,
       k.type                        AS tipo,
       COUNT(*)                      AS ordenes
  FROM "Ticket" k
  LEFT JOIN "Subscriber" s ON s.id = k."subscriberId"
  LEFT JOIN "Branch" b     ON b.id = s."branchId"
 GROUP BY 1, 2, 3;
COMMENT ON VIEW analitica.ordenes_diarias IS 'Órdenes de servicio creadas por día, sede y tipo.';

-- Todos los flujos en formato largo: una fila por (fecha, sede, indicador).
CREATE OR REPLACE VIEW analitica.indicadores_diarios AS
          SELECT fecha, sede, 'Recaudo'::text   AS indicador, recaudo::numeric   AS valor, true  AS es_dinero FROM analitica.recaudo_diario
UNION ALL SELECT fecha, sede, 'Pagos recibidos',  pagos::numeric,   false FROM analitica.recaudo_diario
UNION ALL SELECT fecha, sede, 'Facturado',        facturado::numeric, true  FROM analitica.facturacion_diaria
UNION ALL SELECT fecha, sede, 'Facturas emitidas', facturas::numeric, false FROM analitica.facturacion_diaria
UNION ALL SELECT fecha, sede, 'Altas',            altas::numeric,   false FROM analitica.altas_diarias
UNION ALL SELECT fecha, sede, 'Órdenes creadas',  SUM(ordenes)::numeric, false FROM analitica.ordenes_diarias GROUP BY fecha, sede
UNION ALL SELECT fecha, sede, 'Retiros',          SUM(retiros)::numeric, false FROM analitica.retiros_diarios GROUP BY fecha, sede
-- Crecimiento neto = altas − retiros: se puede sumar en cualquier rango.
UNION ALL SELECT fecha, sede, 'Crecimiento neto (altas − retiros)', altas::numeric, false FROM analitica.altas_diarias
UNION ALL SELECT fecha, sede, 'Crecimiento neto (altas − retiros)', -SUM(retiros)::numeric, false FROM analitica.retiros_diarios GROUP BY fecha, sede;
COMMENT ON VIEW analitica.indicadores_diarios IS 'Todos los flujos diarios juntos. Se SUMAN en cualquier rango.';

-- ── Medidas que NO se suman en el tiempo ─────────────────────────────────────

CREATE OR REPLACE VIEW analitica.base_facturable_mensual AS
SELECT date_trunc('month', i."invoiceDate")::date           AS mes,
       COALESCE(b.name, 'Sin sede')                         AS sede,
       COUNT(DISTINCT i."subscriberId")                     AS abonados_facturados
  FROM "SubInvoice" i
  LEFT JOIN "Subscriber" s ON s.id = i."subscriberId"
  LEFT JOIN "Branch" b     ON b.id = s."branchId"
 WHERE i.status <> 'CANCELED'
 GROUP BY 1, 2;
COMMENT ON VIEW analitica.base_facturable_mensual IS 'Abonados DISTINTOS con factura en el mes: la mejor medida de "cuántos clientes teníamos". NO se suma entre meses.';

-- Fotos diarias de estados y cartera (solo existen desde 2026-07-28; el pasado NO
-- se puede reconstruir). Salen de MetricPoint, que las toma el cron a las 00:20.
CREATE OR REPLACE VIEW analitica.fotos_diarias AS
SELECT m.fecha::date                                   AS fecha,
       COALESCE(b.name, CASE WHEN m.sede = '' THEN 'Toda la empresa' ELSE m.sede END) AS sede,
       CASE m.metrica
         WHEN 'abonados.total'      THEN 'Abonados (total)'
         WHEN 'abonados.activos'    THEN 'Abonados activos'
         WHEN 'abonados.cortados'   THEN 'Abonados cortados'
         WHEN 'abonados.cartera'    THEN 'Abonados en cartera'
         WHEN 'abonados.retirados'  THEN 'Abonados retirados'
         WHEN 'cartera.total'       THEN 'Cartera por cobrar'
         WHEN 'cartera.facturas'    THEN 'Facturas por cobrar'
         WHEN 'cartera.mora90'      THEN 'Cartera con más de 90 días'
         ELSE m.metrica END                            AS indicador,
       m.valor                                         AS valor,
       m.metrica IN ('cartera.total', 'cartera.mora90') AS es_dinero
  FROM "MetricPoint" m
  LEFT JOIN "Branch" b ON b.id = m.sede
 WHERE m.periodo = 'D'
   AND m.metrica IN ('abonados.total','abonados.activos','abonados.cortados','abonados.cartera',
                     'abonados.retirados','cartera.total','cartera.facturas','cartera.mora90');
COMMENT ON VIEW analitica.fotos_diarias IS 'Estados y cartera tal como estaban cada día. NO se suman: en un rango vale el último día.';

-- ── El comparativo: este mes vs los dos anteriores A LA MISMA ALTURA ─────────
--
-- Al día 21, septiembre se compara con el 1–21 de agosto y el 1–21 de julio, no
-- con agosto entero (eso siempre parece una caída). Se corta en el último día
-- CERRADO: el día de hoy va a medias.
--
-- Proyección del cierre: no es una regla de tres por días (el recaudo se concentra
-- a principio de mes y eso la inflaría o la hundiría). Usa cuánto crecieron los dos
-- meses anteriores desde este mismo día hasta su cierre, y aplica ese factor.
CREATE OR REPLACE VIEW analitica.comparativo_mes AS
WITH c AS (
  SELECT ultimo_dia_cerrado                                       AS corte,
         date_trunc('month', ultimo_dia_cerrado)::date            AS mes0,
         EXTRACT(day FROM ultimo_dia_cerrado)::int                AS d
    FROM analitica.calendario
),
periodos AS (   -- k = 0 (este mes), 1, 2 (anteriores), 12 (mismo mes del año pasado)
  SELECT k,
         (c.mes0 - make_interval(months => k))::date                                          AS inicio,
         LEAST((c.mes0 - make_interval(months => k))::date + (c.d - 1),
               ((c.mes0 - make_interval(months => k)) + interval '1 month - 1 day')::date)     AS fin_a_la_fecha,
         ((c.mes0 - make_interval(months => k)) + interval '1 month - 1 day')::date            AS fin_mes
    FROM c, unnest(ARRAY[0, 1, 2, 12]) AS k
),
v AS (
  SELECT i.indicador, bool_or(i.es_dinero) AS es_dinero,
         COALESCE(i.sede, 'Toda la empresa') AS sede,
         SUM(i.valor) FILTER (WHERE p.k = 0  AND i.fecha <= p.fin_a_la_fecha) AS actual,
         SUM(i.valor) FILTER (WHERE p.k = 1  AND i.fecha <= p.fin_a_la_fecha) AS m1,
         SUM(i.valor) FILTER (WHERE p.k = 2  AND i.fecha <= p.fin_a_la_fecha) AS m2,
         SUM(i.valor) FILTER (WHERE p.k = 12 AND i.fecha <= p.fin_a_la_fecha) AS m12,
         SUM(i.valor) FILTER (WHERE p.k = 1) AS m1_cierre,
         SUM(i.valor) FILTER (WHERE p.k = 2) AS m2_cierre
    FROM analitica.indicadores_diarios i
    JOIN periodos p ON i.fecha BETWEEN p.inicio AND p.fin_mes
   -- Acota ANTES de agrupar (el planificador lo empuja dentro de cada vista): sin esto
   -- recorría toda la historia desde 2005 y tardaba 15 s.
   WHERE i.fecha >= ((now() AT TIME ZONE 'America/Bogota')::date - interval '14 month')::date
   GROUP BY GROUPING SETS ((i.indicador, i.sede), (i.indicador))
)
SELECT v.indicador,
       v.sede,
       to_char(c.mes0, 'YYYY-MM')                                          AS mes,
       c.d                                                                 AS dias_comparados,
       c.corte                                                             AS datos_hasta,
       v.es_dinero,
       COALESCE(v.actual, 0)                                               AS este_mes,
       COALESCE(v.m1, 0)                                                   AS mes_anterior,
       COALESCE(v.m2, 0)                                                   AS hace_dos_meses,
       ROUND((COALESCE(v.m1, 0) + COALESCE(v.m2, 0)) / 2.0, 2)             AS promedio_dos_meses,
       ROUND(100.0 * (COALESCE(v.actual, 0) - v.m1) / NULLIF(v.m1, 0), 1)  AS var_vs_mes_anterior_pct,
       ROUND(100.0 * (COALESCE(v.actual, 0) - (COALESCE(v.m1, 0) + COALESCE(v.m2, 0)) / 2.0)
             / NULLIF((COALESCE(v.m1, 0) + COALESCE(v.m2, 0)) / 2.0, 0), 1) AS var_vs_promedio_pct,
       COALESCE(v.m12, 0)                                                  AS mismo_mes_anio_pasado,
       ROUND(100.0 * (COALESCE(v.actual, 0) - v.m12) / NULLIF(v.m12, 0), 1) AS var_vs_anio_pasado_pct,
       COALESCE(v.m1_cierre, 0)                                            AS cierre_mes_anterior,
       COALESCE(v.m2_cierre, 0)                                            AS cierre_hace_dos_meses,
       -- Factor = promedio de (cierre / a-la-fecha) de los dos meses anteriores.
       -- Órdenes sin proyección: los cortes y reconexiones masivos caen en días sueltos
       -- (24-25 de agosto: más de 3.000 órdenes) y el factor saldría disparado.
       -- Tampoco el crecimiento neto: es una resta y el factor se vuelve loco cerca de cero.
       CASE WHEN v.indicador IN ('Órdenes creadas', 'Crecimiento neto (altas − retiros)') THEN NULL ELSE
       ROUND(COALESCE(v.actual, 0) * (
         SELECT AVG(f) FROM (VALUES (v.m1_cierre / NULLIF(v.m1, 0)), (v.m2_cierre / NULLIF(v.m2, 0))) x(f)
       ), 2) END                                                           AS proyeccion_cierre
  FROM v, c;
COMMENT ON VIEW analitica.comparativo_mes IS 'Mes en curso vs los dos anteriores y el año pasado, a la misma altura del mes (hasta el último día cerrado), con proyección del cierre.';
