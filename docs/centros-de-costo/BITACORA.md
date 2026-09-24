# Bitácora — centro de costo por sede

Cada fase añade aquí su entrada al terminar. El lanzador avanza sólo si encuentra `FASE <n>: OK`.

- 2026-09-23 20:55 (Bogotá) — plan escrito, corrida lanzada en tmux `saves-centros-costo`.

## Fase 0 — Preparación y respaldo · 2026-09-23 20:53–21:05 (Bogotá)

**Hecho**
1. Memorias leídas: build-restart-pm2, migraciones-y-backup-saves, contrato-http-es-la-fuente,
   generador-contenedor-roto, routers-a-mano-indice, alcance-sede-una-sola-fuente,
   sql-crudo-fechas-date, prisma-not-descarta-null, pantallas-sin-llave-invisibles,
   fechas-utc-cierre-caja.
2. Respaldo: `backend/backups/nexus_20260924_035307.dump` (hora del servidor, CEST) —
   **421.190.695 bytes (402 MB)**, 227 tablas con datos, verificado con `pg_restore --list`.
   sha256 `86aa3dbadb3b1637c51a29ad0fc07846c0c2b31dd93a717794392b5275228462`.
   (La rotación del script borró 1 dump de más de 14 días, como siempre.) Disco: 52 GB libres (92 %).
3. Foto del árbol: `docs/centros-de-costo/estado-inicial.txt` (rama refactor/fundamentos-arquitectura,
   HEAD 2396b32; `git status --porcelain` + `git diff --stat`: 152 ficheros, +9181/−1268).
   Copias en `docs/centros-de-costo/respaldo-inicial/`: `contrato-http.json` + los 51 `*.router.ts`
   (con su ruta relativa a `backend/`).
4. `npm run prisma:status`: 104 migraciones, «Database schema is up to date», la última
   `20260923220000_cartera_seguimiento`. `npx tsc --noEmit -p .` en backend: **0 errores** (exit 0).
5. Extra para la fase 4: `docs/centros-de-costo/sumas-por-cuenta-inicial.txt`, con las sumas de
   débito y crédito por cuenta y un md5 de (id, cuenta, débito, crédito) de todas las líneas.
   Total: 31.830 líneas, débitos = créditos = 1.037.091.288,28. Hay 6 cuentas con movimiento.
   Conteos: CostCenter 0, JournalEntry 12.359, JournalLine 31.830 (todas con costCenterId null),
   InventoryMovement 0 filas (la tabla está vacía: el punto 4 de la fase 3 hoy no tiene datos),
   Branch 7.

**⚠️ ADVERTENCIA para la fase 1 (no bloquea la 0): hay deriva en la base.**
`prisma migrate diff --from-schema-datasource … --to-schema-datamodel …` muestra que la base
tiene 3 tablas que **no están ni en schema.prisma ni en ninguna migración**: `Pqr`,
`PqrActuacion` y `PqrAdjunto` (con sus FK a Subscriber/ticket). Están **vacías** (0 filas;
pg_stat indica que se insertaron y borraron 5 y 16 filas, o sea que eran pruebas). No hay código que
las use en /home/dev/saves ni en saves_vestel. Seguramente es un trabajo de PQR de otra sesión, a medias.
Consecuencia: **`npm run prisma:migrate` (= `migrate dev`) detectará la deriva y pedirá resetear
la base, o generará `DROP TABLE "Pqr"…`.** No hay que usarlo tal cual. Procedimiento seguro:
crear a mano la carpeta `prisma/migrations/2026092400xxxx_centro_costo_sede/migration.sql` con
**sólo** el SQL aditivo (se puede sacar de
`npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`
tras editar el schema, **quitando todo lo que toque Pqr*** ), aplicarla con
`npm run prisma:deploy` y comprobar con `prisma:status`. No borrar las tablas Pqr*: no son
nuestras. Dejar al usuario la decisión sobre ellas.

**Ficheros tocados:** sólo `docs/centros-de-costo/` (estado-inicial.txt, respaldo-inicial/,
sumas-por-cuenta-inicial.txt, esta bitácora). Código y base sin cambios (sólo lecturas y pg_dump).

FASE 0: OK

## Fase 1 — Datos: centros de costo y vínculo con la sede · 2026-09-23 ~20:58 (Bogotá, según `TZ=America/Bogota date`)

**Hecho**
1. `schema.prisma`: `Branch.costCenterId String? @unique` + relación `costCenter`; en `CostCenter`
   el lado inverso `branch Branch?` y `kind CostCenterKind @default(OTRO)` con el enum nuevo
   `CostCenterKind { SEDE GENERAL OTRO }` (sirve para que las fases 2 y 5 distingan sede /
   «Administración general» sin mirar códigos). `prisma format` sólo realineó los bloques
   CostCenter y Branch.
2. Migración **hecha a mano** (siguiendo la advertencia de la fase 0; NO se usó `migrate dev`):
   `backend/prisma/migrations/20260924040000_centro_costo_sede/migration.sql` — sólo CREATE TYPE,
   2 ADD COLUMN, 1 índice único y 1 FK (ON DELETE SET NULL). Aplicada con `npm run prisma:deploy`.
   `prisma:status`: 105 migraciones, «Database schema is up to date». `migrate diff` datasource →
   schema queda **sólo** con los DROP de `Pqr*` (la deriva ajena de antes; no se tocó). `prisma generate` hecho.
3. `backend/scripts/sembrar-centros-costo.ts` (idempotente, reutiliza por `code`, `--dry` opcional;
   no renombra ni reactiva lo existente, respeta una sede que ya apunte a otro centro). Corrido:
   dry → real → otra vez real (todo «sin cambios / ya enlazada»). Resultado en la base:
   - `VESTEL` «Vestel» (OTRO, raíz)
   - `CC-ADMIN` «Administración general» (GENERAL, hijo de VESTEL)
   - `CC-YOPAL`(2) `CC-VILLANUEVA`(3) `CC-MONTERREY`(4) `CC-MOCOA`(5) `CC-AGUAZUL`(6)
     `CC-TAURAMENA`(7) `CC-VILLAVICENCIO`(8): SEDE, hijos de VESTEL, cada `Branch` enlazado.
   - Total 9 centros, 7/7 sedes enlazadas, todos activos.
4. Punto 3 del plan: **no hizo falta endpoint nuevo** en esta fase (list/create/deactivate ya
   existen; la edición es de la fase 5). No se tocó contrato, routers ni contenedor.

**Verificación:** `npx tsc --noEmit -p .` en backend → 0 errores. JournalLine sigue 31.830 líneas
con 0 `costCenterId` (esta fase no toca asientos). El backend en pm2 NO se reinició (no hace falta:
columnas nuevas nullables/con default; el reinicio va en la fase 6).

**Ficheros tocados:** `backend/prisma/schema.prisma`,
`backend/prisma/migrations/20260924040000_centro_costo_sede/migration.sql` (nuevo),
`backend/scripts/sembrar-centros-costo.ts` (nuevo), esta bitácora. Escrituras en la base: la
migración, 9 filas en `CostCenter` y `Branch.costCenterId` de las 7 sedes.

**Pendiente para el usuario (no bloquea):** decidir qué hacer con las tablas `Pqr*` fuera de
schema/migraciones; mientras existan, `npm run prisma:migrate` (migrate dev) seguirá sin poder
usarse y las migraciones deben hacerse a mano como esta.

FASE 1: OK

## Fase 2 — Resolver único «¿a qué centro va esto?» · 2026-09-23 ~21:05 (Bogotá)

**Hecho**
1. `backend/src/common/centro-costo.ts` — única fuente. Recibe cualquier cliente Prisma
   (`PrismaService` o `PrismaClient` de script, para el backfill de la fase 4). Devuelve el
   `CostCenter.id` o `null` («Sin asignar», D3):
   - `centroDeSede(prisma, branchLegacyId)` — caché en memoria de todo el mapa sede→centro +
     el general (una sola carga aunque lleguen varias a la vez; TTL 5 min para lo que se
     edite desde otro proceso, p. ej. el script de siembra; una carga fallida no envenena la
     caché). `0`/null/negativos → null sin consultar. **Centro inactivo → null.**
   - `invalidarCacheCentros()` — ya se llama en `accounting/cost-centers.service.ts` al crear
     y al activar/desactivar (único cambio fuera de common/). La edición de la fase 5 debe llamarla.
   - `centroDeAbonado(prisma, subscriberId)` — por `Subscriber.branch.legacyId`; sin sede → null.
   - `centroDeCaja(prisma, cashAccountLegacyId)` — por `CashAccount.legacyId` (lo que guarda
     `Transaction.cashAccountId`); banco (`branchLegacy` 0) o sin sede → null. Decidir
     CC-ADMIN para el banco es del llamador (fase 3), no del resolver.
   - `centroDeBodega(prisma, { tipo: 'material'|'equipos', id | legacyId })` — bodegas de
     tránsito (`branchLegacy` null) → null. OJO fase 3: `InventoryMovement` apunta al modelo
     genérico `Warehouse`, que **no tiene sede**; ese caso no lo resuelve (y la tabla está vacía).
   - `centroGeneral(prisma)` — el `kind = GENERAL` activo (manda `CC-ADMIN` si hay varios).
   - Extras para la fase 3: `centroActivo(prisma, id)` (validar el centro elegido a mano, sin
     caché) y `centroSinFallar(resolver, contexto)` (si lanza: `console.warn` y null, para que
     contabilizar nunca falle por el centro).
2. `backend/src/common/centro-costo.spec.ts` — 24 tests: abonado sin sede / inexistente, caja de
   banco, caja sin sede, sede sin centro, centro desactivado, bodega de tránsito (material y
   equipos), caché (una carga, invalidación, fallo no envenena), general, centroActivo,
   centroSinFallar. **24/24 pasan.**

**Verificación**
- `npx tsc --noEmit -p .` → 0 errores.
- `npx jest` completo: 1466/1467. El único fallo es **previo y ajeno**: `core/http/rutas-vivas.spec.ts`
  encuentra `POST /api/cron/run/cortes-deshechos` montada pero fuera de `contrato-http.json`
  (trabajo del cron de cortes deshechos, no de esta fase; no se tocó).
- Prueba de sólo lectura contra la base real (script temporal, ya borrado): las 7 sedes → su
  `CC-<SEDE>`; general → CC-ADMIN; cajas de sede → su centro; cajas 6,7,8,17,18,21–24 (banco) → null;
  abonado sin sede → null; abonado de Monterrey → CC-MONTERREY; bodega de tránsito «Servicios» → null;
  bodega de material de Yopal y de equipos de Villanueva → su centro.

**Aviso para las fases 3 y 4 (no bloquea):** la caja legacyId **4 «Mocoa»** tiene
`branchLegacy` **null** (no 5). El resolver la deja en null, como manda D3 (no se deduce del
nombre). Lo que pase por esa caja quedará «Sin asignar» (o CC-ADMIN si la fase 3 lo trata como banco:
**no** debería, porque null ≠ 0). Corregir el dato es decisión del usuario (sería escribir datos de negocio).

**Ficheros tocados:** `backend/src/common/centro-costo.ts` (nuevo),
`backend/src/common/centro-costo.spec.ts` (nuevo), `backend/src/accounting/cost-centers.service.ts`
(invalidar caché), esta bitácora. Base: sin escrituras. Sin build ni reinicio de pm2 (fase 6).

FASE 2: OK

## Fase 3 — Poner el centro al crear cada asiento · 2026-09-23 ~21:12 (Bogotá)

**Hecho**
1. `accounting/posting.service.ts`:
   - `costCenterId?` en `CustomerPaymentArgs`, `TreasuryIncomeArgs` y `TreasuryExpenseArgs`; va a
     **todas** las líneas (caja/banco/cartera incluidas, como ya hacían factura y ajuste).
   - Ayudas para los llamadores, que **nunca lanzan** (van por `centroSinFallar`: null + `console.warn`):
     `centroDeAbonado(subscriberId)` y `centroDeTesoreria(cajaLegacyId, elegido?)` (elegido > sede de
     la caja > CC-ADMIN si la caja es banco).
   - Red contra FK: los 7 asientos pasan por `asentar()`; si la base rechaza el centro (P2003, p. ej. al
     reintentar un pendiente viejo con un centro que ya no existe) se contabiliza igual **sin centro**
     y con aviso. Un P2003 sin centro sigue yendo a `PendingPosting` como antes.
2. `common/centro-costo.ts`: nuevo `centroDeTesoreria(prisma, cajaLegacyId)` (la regla «banco →
   Administración general» vive en el resolver único, para que el backfill de la fase 4 la reutilice).
   Caja sin sede (`branchLegacy` null) ≠ banco → null.
3. Llamadores (todos con el centro del abonado salvo tesorería):
   - `billing/facturas.service.ts`: factura manual, ajuste por edición y corrida mensual.
   - `omni/omni.service.ts`: cotización → factura.
   - `billing/prorrateo-reconexion.service.ts` (ajuste y factura nueva; se añadió `subscriberId` al select)
     y `billing/cargo-orden.service.ts` — **no estaban en la lista del plan** pero también llaman a
     `postSalesInvoice*`; se trataron igual.
   - `treasury/cobranzas.service.ts`: recaudo (`collect`) → abonado; ingreso libre y egreso → elegido /
     caja / CC-ADMIN. Validación nueva `exigirCentroElegido`: si viene `costCenterId`, debe existir y
     estar activo (400 si no); si no viene, no se valida nada.
   - `treasury/dto/cobranzas.dto.ts`: `costCenterId?` opcional en `ExpenseDto` e `IncomeDto`
     (sólo DTO: el contrato HTTP no cambia; no se tocaron routers ni contenedor).
4. `accounting/cost-centers.service.ts`: `list()` devuelve además `kind` y `branch {legacyId, name}`
   (aditivo; sirve al selector y a la pantalla de la fase 5).
5. Frontend: `components/cobranzas/CentroCostoField.tsx` (nuevo; `useCentrosCosto` + selector
   **opcional**, primera opción «Automático — <centro de la caja>» calculado con la misma regla, sólo
   hojas del árbol). Puesto en `EgresoModal`, `IngresoLibreModal` (`TesoreriaModals.tsx`) y en
   `/tesoreria/nueva`. Sólo se muestra a contabilidad / administración / gerencia: **la cajera no lo
   ve** y su asiento toma el de su caja; nunca es obligatorio.
6. Punto 4 (`InventoryMovement` de salida): **no aplica hoy**. Ningún código crea `InventoryMovement`
   (grep: 0 escrituras), la tabla tiene 0 filas y su bodega es el modelo genérico `Warehouse`, sin sede.
   No hay nada que cablear; si algún día se escribe, usar `centroDeBodega` con la bodega de material/equipos.

**Verificación**
- `npx tsc --noEmit -p .` backend y frontend → 0 errores. eslint del componente nuevo: limpio.
- `npx jest` backend: 1479/1480. El único fallo es el **previo y ajeno** de la fase 2
  (`rutas-vivas.spec.ts`: `POST /api/cron/run/cortes-deshechos` fuera del contrato).
  Tests nuevos: 5 en `centro-costo.spec.ts` (`centroDeTesoreria`) y 6 en `posting.service.spec.ts`
  (centro en todas las líneas, null sin centro, reintento sin centro ante FK, P2003 sin centro →
  pendiente, elegido manda, resolutores que no lanzan). Mocks de `posting` actualizados en
  `factura-traslado.spec.ts`, `cargo-agregar-internet.spec.ts` y `prorrateo-reconexion.service.spec.ts`.
- Prueba de sólo lectura contra la base real (script temporal, ya borrado), con el `PostingService` real:
  cajas de sede → su CC; bancos 6,7,8,17,18,22,23,24 → CC-ADMIN; caja 4 Mocoa → null; sin caja → null;
  abonado de cada una de las 7 sedes → su CC; abonado sin sede → null; `list()` trae kind y sede.
  JournalLine sigue 0/31.830 con centro (esta fase sólo afecta a lo nuevo; el relleno es la fase 4).
- Sin build ni reinicio de pm2 (fase 6): en producción sigue corriendo el código anterior.

**⚠️ Para el usuario (no bloquea):** la caja **21 «Villavicencio»** tiene `branchLegacy = 0`, o sea que
el sistema la trata como **banco** y sus ingresos/egresos sin centro elegido irán a **CC-ADMIN**, no a
CC-VILLAVICENCIO. Si es una caja física de la sede, hay que corregir el dato (`branchLegacy = 8`) —
es dato de negocio, no se tocó—. Mismo caso que la caja 4 «Mocoa» (null → «Sin asignar»), ya anotada.
Mientras tanto contabilidad puede elegir el centro a mano en el formulario.

**Ficheros tocados:** backend `src/accounting/posting.service.ts`, `src/accounting/posting.service.spec.ts`,
`src/accounting/cost-centers.service.ts`, `src/common/centro-costo.ts`, `src/common/centro-costo.spec.ts`,
`src/billing/facturas.service.ts`, `src/billing/prorrateo-reconexion.service.ts`,
`src/billing/prorrateo-reconexion.service.spec.ts`, `src/billing/cargo-orden.service.ts`,
`src/billing/factura-traslado.spec.ts`, `src/support/cargo-agregar-internet.spec.ts`,
`src/omni/omni.service.ts`, `src/treasury/cobranzas.service.ts`, `src/treasury/dto/cobranzas.dto.ts`;
frontend `src/components/cobranzas/CentroCostoField.tsx` (nuevo), `src/components/cobranzas/TesoreriaModals.tsx`,
`src/app/tesoreria/nueva/page.tsx`; esta bitácora. Base: sin escrituras (sólo lecturas).

FASE 3: OK

## Fase 4 — Rellenar lo que ya existe (backfill) · 2026-09-23 ~21:05–21:15 (Bogotá)

**Hecho**
1. `backend/scripts/backfill-centros-costo.ts` (nuevo). Ensayo por defecto; sólo escribe con `--aplicar`.
   Toca **únicamente** líneas con `costCenterId IS NULL` (`updateMany … where costCenterId: null`, por
   lotes de 500 asientos, cada lote en su transacción). Es idempotente y se puede volver a correr para
   lo que se contabilice sin centro hasta que la fase 6 despliegue el código de la fase 3.
   Se guía por `JournalEntry.sourceType`/`sourceId` (verificado en `posting.service.ts` y los llamadores):
   - `SALES_INVOICE` → `sourceId` = `SubInvoice.id`; `SALES_INVOICE_ADJ` → `sourceId` = `<SubInvoice.id>#<edición>`.
     De ahí, la sede del abonado (igual que la fase 3).
   - `CUSTOMER_PAYMENT` → `sourceId` = `PaymentReceipt.id`. El abonado sale de las transacciones del
     recibo (`ReceiptTransaction` → `Transaction.subscriberId`), igual que el `dto.subscriberId` que usa
     hoy el recaudo. Si no traen abonado, se usa el de la factura del recibo. Si hay varios abonados, o
     el de la factura es otro, queda ambiguo → null (en la práctica: 0 casos).
   - `TREASURY_INCOME`/`TREASURY_EXPENSE` → `Transaction.cashAccountId` → `centroDeTesoreria` (sede de la
     caja; banco → CC-ADMIN; caja sin sede → null). Es la regla de la fase 3, sin centro elegido.
   - Cualquier otro tipo no se toca (hoy no hay: 0 manuales).
   Para la sede usa el resolver único (`centroDeSede`/`centroDeTesoreria` de `src/common/centro-costo.ts`),
   y carga facturas, recibos y abonados en bloque para no hacer 12 mil consultas. Imprime el conteo por
   centro, lo que queda sin asignar con su motivo, y compara las sumas por cuenta antes y después.
2. Primer ensayo: contaba como «ambiguos» 90 recibos que no tenían abonado en sus transacciones pero sí
   factura. Era un error del script, ya corregido: ahora caen en su sede (Villanueva).
3. **Resultado del ensayo final, idéntico al de `--aplicar`** (12.359 asientos / 31.830 líneas, todos null al empezar):

   | Centro | Asientos | Líneas | Débito = Crédito |
   |---|---:|---:|---:|
   | CC-VILLANUEVA | 3.942 | 9.754 | 273.688.500,81 |
   | CC-YOPAL | 2.497 | 6.182 | 213.536.164,85 |
   | CC-MONTERREY | 2.488 | 6.316 | 190.637.451,80 |
   | CC-TAURAMENA | 512 | 1.249 | 40.119.419,00 |
   | CC-ADMIN | 33 | 66 | 120.047.385,85 |
   | CC-AGUAZUL | 5 | 12 | 359.250,22 |
   | CC-VILLAVICENCIO | 3 | 7 | 176.250,21 |
   | CC-MOCOA | 0 | 0 | — (ningún abonado ni caja con sede Mocoa en los asientos) |
   | **Sin asignar** | 2.879 | **8.244 (25,9 %)** | 198.526.865,54 |

   Motivos de «Sin asignar» (todos explicados; ninguno se adivinó):
   - 2.856 asientos / 8.197 líneas: `SALES_INVOICE` cuya **factura ya no existe** (borrada). 2.842 son de
     agosto. Por autor: «PRUEBA · Superusuario» 2.177 (≈161,4 M de débito), «Cron» 668 (≈35,6 M) y un
     puñado de cajeras/pago en línea/reposición. No queda rastro del abonado: `AuditLog` sólo tiene 2 de
     esos ids, y `LegacyDeletion` guarda el legacyId, no el id del asiento.
   - 19 asientos / 38 líneas: `CUSTOMER_PAYMENT` con el recibo borrado.
   - 1 `SALES_INVOICE_ADJ` con la factura borrada, 1 `TREASURY_EXPENSE` y 1 `TREASURY_INCOME` con la
     transacción borrada (Vesagro/Socios del 15-07), 1 recibo sin abonado (ni transacciones ni factura).
   Todo cuadra: cada centro queda con débito = crédito, porque cada asiento va entero a un centro.
4. `--aplicar`: **23.586 líneas escritas**. Otra pasada de ensayo después: 2.879 asientos / 8.244 líneas
   null y 0 asignables (es idempotente).

**Verificación (sólo se añadió una etiqueta)**
- Sumas por cuenta (líneas, débito y crédito): el script las compara antes y después → IGUALES. Y el
  `diff` contra `sumas-por-cuenta-inicial.txt` de la fase 0 → idéntico en las 6 cuentas.
- md5 de (id, cuenta, débito, crédito) de todas las líneas, con la misma consulta de la fase 0:
  `80150a66a2a33999f2f6acbba98ab282` antes y después (= el de la fase 0). Totales:
  31.830 líneas, débitos = créditos = 1.037.091.288,28.
- `npx tsc --noEmit -p .` backend → 0 errores. El script también compila con tsc estricto por separado.

**⚠️ Para el usuario (no bloquea esta fase):** los ~2.856 asientos de facturas borradas (sobre todo las
2.177 de la corrida de prueba «PRUEBA · Superusuario» de agosto) **siguen vivos en el libro** y suman
ingresos por facturas que ya no existen. Esto ya pasaba antes y afecta al estado de resultados total,
no sólo a este informe. En el informe por sede de la fase 5 saldrán en la columna «Sin asignar».
Revertirlos o anularlos es una decisión contable y no se tocó.

**Ficheros tocados:** `backend/scripts/backfill-centros-costo.ts` (nuevo) y esta bitácora. Base: sólo
`JournalLine.costCenterId` de 23.586 líneas que estaban en null. Sin build ni reinicio de pm2.

FASE 4: OK

## Fase 5 — Informe «Resultados por sede» y administración · 2026-09-23 ~21:15–21:25 (Bogotá)

**Hecho — backend**
1. `accounting/reports.service.ts`:
   - `incomeStatement(range, { costCenterId? })`: un id filtra ese centro; `null` = líneas «Sin asignar»;
     sin filtro = como antes. Por HTTP: `GET /accounting/reports/income-statement?costCenterId=<id>|sin-asignar`.
   - `incomeStatementByCenter(range)` → **`GET /accounting/reports/income-statement-by-center?from&to`**
     (contabilidad/administración/gerencia). Filas = cuentas INCOME/COST/EXPENSE; columnas = sedes (orden
     por gid, **siempre**, aunque estén en cero o inactivas), «Administración general», otros centros *sólo
     si tienen movimiento*, «Sin asignar» (`SIN_ASIGNAR`) y total. Un centro hijo suma en su antepasado
     SEDE/GENERAL más cercano. Sin asientos de cierre (igual que el P&G). Devuelve `cuadre`: compara
     columnas sumadas = total del informe = `incomeStatement(range)` **en consulta aparte**; la pantalla
     pinta un aviso rojo si algún día no cuadra.
   - Fechas: sólo Prisma tipado (el mismo `dateFilter` que el P&G), nada de SQL crudo → no aplica el
     desfase de `sql-crudo-fechas-date`. En el frontend el rango viaja como `'YYYY-MM-DD'` (`RangoFechas`).
2. `accounting/cost-centers.service.ts`: `update(id, { name?, isActive?, branchLegacyId? })` →
   **`PATCH /accounting/cost-centers/:id`** (contabilidad/administración). El código no se edita. Enlazar
   una sede la marca `SEDE` y desenlaza la anterior (transacción); `null` desenlaza y pasa a `OTRO`; una
   sede ya enlazada con **otro** centro → 409 (no se roba); `GENERAL` no se enlaza; nombre vacío → 400.
   Llama `invalidarCacheCentros()`. Y `sedes()` → **`GET /accounting/cost-centers/sedes`** (las 7 sedes con
   su centro; hacía falta porque las listas de sedes existentes no traen el gid o van acotadas por sede).
3. Contrato + router: 3 entradas nuevas en `contrato-http.json` (707 → 710) y `costCenterId` en el query
   de income-statement. Serialización verificada byte a byte (sólo añadidos). Generador corrido en un
   sandbox (`/home/dev/.cache/cc-fase5`): **ANTES de mi cambio ya había deriva en 8 routers ajenos**
   (extras, treasury, network, genieacs, cron, staff, subscribers, playhub — regenerarlos borraría cosas),
   así que **NO se corrió `generar:routers` sobre el árbol**: se copió sólo `accounting.router.ts` del
   sandbox. Diff contra el original: exactamente las 3 rutas nuevas + el query nuevo; `rutas.ts` sin cambio.
   Copias previas: `/home/dev/.cache/contrato-antes-fase5.json`, `/home/dev/.cache/accounting.router.antes-fase5.ts`.
   Contenedor: sin tocar (no hay servicio nuevo).

**Hecho — frontend**
4. `/contabilidad/resultados-por-sede` (nuevo): tabla cuentas × sedes con Ingresos / Costos / Utilidad
   bruta / Gastos / Utilidad neta, primera columna fija, `RangoFechas` con **mes actual por defecto**,
   exportar Excel/PDF con el `ExportMenu` que ya existía, aviso de «Sin asignar» y de descuadre.
5. `/contabilidad/centros-de-costo` (nuevo): árbol de centros (código, nombre, tipo, sede, estado), crear
   (código, nombre, padre, sede) y editar (nombre, sede, activo). Gerencia sólo lo ve; los botones salen a
   contabilidad/administración (igual que la API). Avisa si alguna sede queda sin centro.
6. `lib/accounting.ts` + `lib/accounting-types.ts` (API y tipos), `nav.ts` (2 hojas en CONTABILIDAD),
   `ContabilidadSubnav.tsx` («Resultados por sede» junto a «Balance y estados»; el enlace roto
   `/contabilidad/centros-costo` que ya había pasó a `/contabilidad/centros-de-costo`).
7. Permisos: 2 entradas en `SCREENS` (áreas contabilidad, administracion, gerencia). Comprobador de
   huérfanas nav↔SCREENS: sólo sale `/documentacion` (pública a propósito). `middleware.ts` no tiene regla
   para `/contabilidad` (ninguna hermana la tiene; la API cierra por área), no se tocó.
   `backend/prisma/migrate-pantallas-centros-costo-2026-09.ts` (nuevo, idempotente, siembra SÓLO esas 2
   llaves): **corrido** → 6 concesiones (2 pantallas × roles Contabilidad, Administración, Gerencia); 2.ª
   pasada: todo «ya estaba». ⚠️ Es una escritura en la base fuera de la lista de la regla (Permission +
   RolePermission, no datos de negocio): sin ella las pantallas sólo las vería el superusuario, y la fase
   exige el acceso para las tres áreas. Revertir = borrar esas 6 filas de `RolePermission` y las 2 de `Permission`.

**Verificación**
- `npx tsc --noEmit -p .` backend y frontend → 0 errores. eslint de lo tocado: 0 errores, 2 avisos
  `set-state-in-effect` (el mismo patrón de carga que `informes/page.tsx`).
- `npx jest` backend: **1492/1493**; el único fallo es el previo y ajeno de siempre (`rutas-vivas.spec.ts`,
  `POST /api/cron/run/cortes-deshechos`). `handlers-sin-ruta` y `rutas-tapadas` pasan con las rutas nuevas.
  Nuevo `accounting/resultados-por-sede.spec.ts`: 13 tests (invariante, columnas y orden, hijo→sede, OTRO sin
  movimiento fuera, cierre excluido, filtro por centro/null, vacío; update: nombre/estado, vacío, enlazar,
  no robar sede, GENERAL, desenlazar, misma sede, 404).
- Contra la base real, sólo lectura (script temporal borrado), `ReportsService` real — **cuadra en los tres rangos**:

  | Rango | Ingresos | Gastos | Utilidad neta | Sin asignar (neto) | cuadre |
  |---|---:|---:|---:|---:|---|
  | sep-2026 | 14.322.351 | 192.819.392 | −178.497.041 | 382.116 | ✓ |
  | ago-2026 | 194.330.300 | 20.279.088,85 | 174.051.211,15 | 185.650.424 | ✓ |
  | todo | 521.935.225 | 213.122.714,85 | 308.812.510,15 | 186.268.495 | ✓ |

  Septiembre por sede (utilidad neta): Yopal −18.176.741 · Villanueva −16.748.964 · Monterrey −34.825.231 ·
  Tauramena −3.446.117 · Mocoa/Aguazul/Villavicencio 0 · Adm. general −105.682.104 · Sin asignar 382.116.
  Además, `incomeStatement` filtrado por cada centro (y por null) = su columna, en los tres rangos.
  `sedes()` real: las 7 sedes con su CC.
- **No probado por HTTP ni en navegador**: sin build ni reinicio de pm2 (fase 6, que debe verificar las 2
  páginas con sesión y el cuadre por el endpoint). El `PATCH` sólo se probó con tests (no se editó ningún
  centro real: sería escribir fuera de lo permitido).

**Para el usuario (no bloquea):** el plan de cuentas hoy sólo mueve **1 cuenta de ingreso y 1 de gasto** (0 de
costo), así que el informe tiene pocas filas. En agosto el 95 % del ingreso cae en «Sin asignar»: son las
facturas borradas de la corrida de prueba de agosto que anotó la fase 4 (siguen vivas en el libro).
Gerencia verá la pantalla de centros en sólo lectura.

**Ficheros tocados:** backend `contrato-http.json`, `src/accounting/{reports.service,cost-centers.service,accounting.controller,accounting.router}.ts`,
`src/accounting/resultados-por-sede.spec.ts` (nuevo), `src/auth/permissions.catalog.ts`,
`prisma/migrate-pantallas-centros-costo-2026-09.ts` (nuevo); frontend `src/app/contabilidad/resultados-por-sede/page.tsx` (nuevo),
`src/app/contabilidad/centros-de-costo/page.tsx` (nuevo), `src/lib/accounting.ts`, `src/lib/accounting-types.ts`,
`src/lib/nav.ts`, `src/components/accounting/ContabilidadSubnav.tsx`; esta bitácora. Base: sólo las 2 llaves de
pantalla y sus 6 concesiones. Sin build ni reinicio de pm2.

FASE 5: OK

## Fase 6 — Build, despliegue y verificación · 2026-09-23 21:26–21:32 (Bogotá, dentro de la ventana 20:00–06:00)

**Hecho**
1. Backend: `npx tsc --noEmit -p .` → 0 errores. `npx jest` → **1492/1493**; el único fallo es el previo y ajeno
   de siempre (`rutas-vivas.spec.ts`: `POST /api/cron/run/cortes-deshechos` fuera del contrato).
   `npm run build` → exit 0 (log en `/home/dev/.cache/cc-fase6-backend-build.log`). Comprobado en `dist/` con
   `grep`: `incomeStatementByCenter`/`income-statement-by-center` en `accounting/{reports.service,accounting.router,accounting.controller}.js`,
   y `centroDeTesoreria` en `treasury/cobranzas.service.js` y `common/centro-costo.js`. `pm2 restart saves-backend` → online.
2. Frontend: `npx tsc --noEmit -p .` → 0 errores. Sin otro build corriendo (`ps aux | grep -E "[n]ext build|[n]pm run build"`:
   sólo salía mi propio shell). `pm2 stop saves-frontend && rm -rf /home/dev/saves/frontend/.next && … next build` con
   rutas absolutas → exit 0; `.next/BUILD_ID` y `.next/static` presentes (BUILD_ID escrito 2 min después del build del
   backend); el listado de rutas del build incluye `/contabilidad/centros-de-costo` y `/contabilidad/resultados-por-sede`.
   Después, `pm2 restart saves-frontend` → online.
3. Verificación con sesión: tokens firmados con `signToken` del `dist` y el `AUTH_SECRET` de `backend/.env`, para 4
   usuarios reales: superusuario, `contabilidad@`, `gerencia@` y `caja@`. El script temporal y los tokens ya están borrados.
   - Páginas `/contabilidad/resultados-por-sede` y `/contabilidad/centros-de-costo` → **200** para superusuario,
     contabilidad y gerencia. (Para la cajera la página también da 200: `middleware.ts` no filtra `/contabilidad`, igual que
     con las páginas hermanas, como anotó la fase 5. La API la cierra.)
   - API `income-statement-by-center`, `income-statement`, `cost-centers` y `cost-centers/sedes` → 200 para
     contabilidad y gerencia, y **403 para la cajera**. El selector de centro de tesorería no llama a la API cuando el
     usuario es cajera (`useCentrosCosto` exige área), así que no genera ruido de 403.
   - Barrido de las 117 páginas estáticas con superusuario: 116 dan 200 y `/login` da 307 (lo normal con sesión). Ningún 5xx.
   - **Cuadre por HTTP, comprobado de forma independiente** (no me fié sólo del campo `cuadre`): en cada fila, la suma
     de las columnas = el total de la fila = la fila de `income-statement` sin filtro. Además, la suma de las filas =
     `totals` = el P&G, y el neto de cada columna = `income-statement?costCenterId=<id>|sin-asignar`. **0 fallos en los 3 rangos:**

     | Rango | Ingresos | Gastos | Utilidad neta = Σ columnas | Sin asignar (neto) | `cuadre` |
     |---|---:|---:|---:|---:|---|
     | sep-2026 | 14.322.351 | 192.819.392 | −178.497.041 | 382.116 | ✓ |
     | ago-2026 | 194.330.300 | 20.279.088,85 | 174.051.211,15 | 185.650.424 | ✓ |
     | 2020→2026 | 521.935.225 | 213.122.714,85 | 308.812.510,15 | 186.268.495 | ✓ |

     Septiembre por sede (neto): Yopal −18.176.741 · Villanueva −16.748.964 · Monterrey −34.825.231 · Mocoa 0 ·
     Aguazul 0 · Tauramena −3.446.117 · Villavicencio 0 · Adm. general −105.682.104 · Sin asignar 382.116
     (idéntico a la fase 5).
   - Sólo lectura: no se creó ningún egreso ni se editó ningún centro. JournalLine sigue en 31.830 líneas / 8.244 sin
     centro (igual que tras el backfill: no hubo asientos nuevos entre la fase 4 y el despliegue, así que no hizo falta
     volver a correr el backfill).
4. Logs de pm2:
   - Backend (`saves-backend-error-13.log` desde el reinicio): sólo 4 WARN, que son mis propias pruebas de 403 con la cajera.
   - Frontend: 0 líneas al arrancar. En el barrido aparece `ReferenceError: window is not defined` (SSR), y **sólo**
     lo dispara `/mapa` (lo comprobé con `pm2 flush`: las páginas de esta obra no generan nada; `/mapa` sí, y aun así
     da 200). **Es previo y ajeno:** `app/mapa/page.tsx` importa de forma estática `COLOR_ESTADO` desde
     `components/map/Mapa.tsx`, y eso evalúa Leaflet en el servidor. Ninguno de esos ficheros tiene cambios (el último
     commit es del 06-08) y no forman parte de esta obra. No se tocó.

**Para el usuario (no bloquea):**
- `/mapa` deja un error SSR en el log en cada carga. La página funciona, pero se arreglaría moviendo `COLOR_ESTADO` a
  un módulo sin Leaflet.
- La cajera puede abrir la página de contabilidad (vacía, porque la API le da 403), igual que las demás de
  `/contabilidad`. Si se quiere cerrar en el borde, habría que añadir una regla a `middleware.ts` para toda la sección.

**Ficheros tocados:** sólo esta bitácora (y los artefactos de build `backend/dist/` y `frontend/.next/`). En la base:
ninguna escritura. Procesos: `saves-backend` y `saves-frontend` reiniciados con el código de las fases 1-5.

FASE 6: OK

## Fase 7 — Cierre · 2026-09-23 ~21:35 (Bogotá)

**Hecho**
1. `docs/centros-de-costo/RESULTADO.md` (nuevo): qué se hizo, las cifras del backfill, septiembre por sede
   (neto: Yopal −18.176.741 · Villanueva −16.748.964 · Monterrey −34.825.231 · Tauramena −3.446.117 ·
   Mocoa/Aguazul/Villavicencio 0 · Adm. general −105.682.104 · Sin asignar 382.116; total −178.497.041),
   las decisiones D1-D3 **pendientes de confirmar**, los pendientes de datos (facturas borradas vivas en el
   libro, cajas 21 y 4, tablas Pqr*, middleware de /contabilidad, error SSR de /mapa) y cómo revertir.
2. Memoria nueva `centro-costo-por-sede.md` y su línea en `MEMORY.md` (sección Caja y tesorería).

**Verificación (sólo lectura):** pm2 `saves-backend` y `saves-frontend` online desde el despliegue de la
fase 6. En la base: 9 centros activos (VESTEL, CC-ADMIN y 7 CC-<SEDE>); JournalLine 31.830 líneas / 8.244 sin
centro, igual que tras el backfill. No hay asientos nuevos desde entonces. Las cifras de RESULTADO.md
salen de las fases 4-6.

**Ficheros tocados:** `docs/centros-de-costo/RESULTADO.md` (nuevo), esta bitácora y la memoria
(`centro-costo-por-sede.md` y `MEMORY.md`). Ni código ni base ni procesos.

FASE 7: OK
