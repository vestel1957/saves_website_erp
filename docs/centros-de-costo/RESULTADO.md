# Centro de costo por sede — resultado

Obra hecha la noche del 2026-09-23 (Bogotá), por fases 0-7 (detalle en `BITACORA.md`, plan en
`PLAN.md`). Desplegada en producción a las 21:32 (backend y frontend reiniciados en pm2).

## Qué se hizo

- **Datos.** Migración aditiva a mano `20260924040000_centro_costo_sede` (`Branch.costCenterId` único +
  enum `CostCenterKind SEDE|GENERAL|OTRO`). Siembra idempotente
  `backend/scripts/sembrar-centros-costo.ts`: raíz `VESTEL`, `CC-ADMIN` «Administración general» y un
  `CC-<SEDE>` por cada una de las 7 sedes, enlazado a su `Branch`.
- **Resolver único** `backend/src/common/centro-costo.ts` (como `sede-scope.ts`): `centroDeSede`,
  `centroDeAbonado`, `centroDeCaja`, `centroDeTesoreria`, `centroDeBodega`, `centroGeneral`,
  `centroActivo`, `centroSinFallar`. Caché en memoria (TTL 5 min, se invalida al crear/editar centros).
- **Asientos nuevos con centro.** Facturas (manual, corrida, omni, prorrateo, cargos por orden), ajustes y
  recaudos → centro de la sede del abonado. Ingresos/egresos de tesorería → centro elegido, o el de la
  sede de la caja, o `CC-ADMIN` si la caja es banco. Si el resolver falla, el asiento se crea igual sin
  centro y deja un `console.warn`: contabilizar nunca falla por el centro.
- **Selector opcional «Centro de costo»** en egreso, ingreso libre y `/tesoreria/nueva`. Sólo lo ven
  contabilidad, administración y gerencia. La cajera no lo ve y su asiento toma el centro de su caja.
- **Backfill** `backend/scripts/backfill-centros-costo.ts` (ensayo por defecto, `--aplicar` para
  escribir, sólo toca líneas null). Es idempotente y se puede volver a correr.
- **Informe** `/contabilidad/resultados-por-sede`, con API
  `GET /accounting/reports/income-statement-by-center`: cuentas × sedes + Adm. general + Sin asignar +
  total, con cuadre verificado contra el P&G. Exporta a Excel y PDF.
- **Administración** en `/contabilidad/centros-de-costo`, con `PATCH /accounting/cost-centers/:id` y
  `GET /accounting/cost-centers/sedes`.
- **Permisos:** 2 pantallas en `SCREENS` con acceso para Contabilidad, Administración y Gerencia
  (sembradas con `prisma/migrate-pantallas-centros-costo-2026-09.ts`).

## Cifras del backfill (12.359 asientos / 31.830 líneas)

| Centro | Asientos | Líneas | Débito = Crédito |
|---|---:|---:|---:|
| CC-VILLANUEVA | 3.942 | 9.754 | 273.688.500,81 |
| CC-YOPAL | 2.497 | 6.182 | 213.536.164,85 |
| CC-MONTERREY | 2.488 | 6.316 | 190.637.451,80 |
| CC-TAURAMENA | 512 | 1.249 | 40.119.419,00 |
| CC-ADMIN | 33 | 66 | 120.047.385,85 |
| CC-AGUAZUL | 5 | 12 | 359.250,22 |
| CC-VILLAVICENCIO | 3 | 7 | 176.250,21 |
| CC-MOCOA | 0 | 0 | — |
| **Sin asignar** | 2.879 | 8.244 (25,9 %) | 198.526.865,54 |

Se escribieron 23.586 líneas. Las sumas por cuenta y el md5 de (id, cuenta, débito, crédito) quedaron
idénticos antes y después: sólo se añadió la etiqueta. «Sin asignar» se debe casi entero a **2.856
asientos de facturas que ya no existen**, 2.177 de ellos de la corrida de prueba «PRUEBA · Superusuario»
de agosto. El resto son recibos o transacciones borrados.

## Septiembre 2026 por sede (utilidad neta)

Ingresos 14.322.351 · Gastos 192.819.392 · **Utilidad neta −178.497.041**. La suma de las columnas es igual
al P&G y está comprobada por HTTP.

| Yopal | Villanueva | Monterrey | Mocoa | Aguazul | Tauramena | Villavicencio | Adm. general | Sin asignar |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| −18.176.741 | −16.748.964 | −34.825.231 | 0 | 0 | −3.446.117 | 0 | −105.682.104 | 382.116 |

Ojo al leerlo: septiembre casi no tiene facturación contabilizada todavía (14,3 M de ingreso). El libro
hoy sólo mueve 1 cuenta de ingreso y 1 de gasto (0 de costo). Mientras sea así, el informe por sede sirve
más para ver los gastos por sede que la rentabilidad.

## Decisiones PENDIENTES DE CONFIRMAR (usuario + contabilidad)

- **D1. Contabilidad de gestión, no empresas separadas.** Mismo NIT y mismo Siigo;
  `SiigoAccount.costCenterByBranch` y la factura electrónica no se tocaron. ¿Es suficiente, o contabilidad
  quiere los centros también en Siigo?
- **D2. Los gastos compartidos no se reparten:** van a «Administración general» (−105,7 M en septiembre,
  la columna más grande). Falta decidir si se reparten, y con qué criterio: por abonados, por ingresos o a
  mano.
- **D3. Backfill sólo donde la sede es inequívoca.** Lo dudoso quedó en «Sin asignar» (25,9 % de las
  líneas). Hay que confirmar que se acepta así.

## Otros pendientes de datos (decisión del usuario; no se tocaron)

1. **Asientos de facturas borradas** (≈2.856; ~161 M de la corrida de prueba de agosto): siguen vivos en
   el libro e inflan el ingreso de agosto en el P&G total, no sólo en este informe. ¿Se revierten o se
   anulan?
2. **Caja 21 «Villavicencio»** tiene `branchLegacy = 0`, así que el sistema la trata como banco y va a
   CC-ADMIN. Si es una caja física de la sede, el dato correcto es `branchLegacy = 8`.
3. **Caja 4 «Mocoa»** tiene `branchLegacy = null`, así que queda «Sin asignar». Si es de la sede, el dato
   correcto es `5`.
4. **Tablas `Pqr*`** que están en la base pero no en el schema ni en las migraciones. Mientras existan,
   `prisma migrate dev` no se puede usar y las migraciones hay que hacerlas a mano.
5. La cajera puede abrir las páginas de `/contabilidad` (le salen vacías porque la API le da 403). Si se
   quiere cerrar también ahí, falta una regla en `middleware.ts`.
6. `/mapa` deja un error SSR en el log (`window is not defined`). Es ajeno a esta obra.

## Cómo revertir

- Los centros de las líneas: `UPDATE "JournalLine" SET "costCenterId" = NULL` (es sólo una etiqueta). El
  código vuelve a poner centro a lo nuevo, salvo que se revierta.
- Las pantallas: borrar las 6 `RolePermission` y las 2 `Permission` de `/contabilidad/resultados-por-sede`
  y `/contabilidad/centros-de-costo`.
- Respaldo previo a la obra: `backend/backups/nexus_20260924_035307.dump` (sha256 en la bitácora).
