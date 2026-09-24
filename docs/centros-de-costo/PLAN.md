# Centro de costo por sede — plan de trabajo

Iniciado el 2026-09-23 (noche, hora Bogotá). Se ejecuta por fases con `claude -p` dentro de la
sesión tmux `saves-centros-costo`, lanzada por `docs/centros-de-costo/correr.sh`. Cada fase
arranca con contexto limpio, lee este plan y la `BITACORA.md`, trabaja y **deja constancia en la
bitácora**. El lanzador sólo pasa a la siguiente fase si la bitácora tiene la línea
`FASE <n>: OK`.

## Objetivo

Que cada sede (Yopal, Villanueva, Monterrey, Mocoa, Aguazul, Tauramena, Villavicencio) tenga su
**centro de costo** y que la gerencia pueda ver el **estado de resultados por sede**. Todo en la
MISMA base de datos: dividirla por sede queda descartado (movimientos entre sedes, un legacy
único, límite de 100 conexiones en un Postgres compartido, migraciones ×7).

## Decisiones provisionales (a confirmar con el usuario y contabilidad)

Se toman por defecto para poder avanzar. Todas son **reversibles**, y el código debe quedar de
modo que cambiarlas sea configuración, no un rediseño:

- **D1. Es contabilidad de gestión, no empresas separadas.** Mismo NIT, mismo Siigo. El mapa
  `SiigoAccount.costCenterByBranch` (`{2:69, 3:167, 4:165, default:69}`) **no se toca** y la
  factura electrónica sigue igual.
- **D2. Los gastos compartidos NO se reparten todavía.** Van al centro **«Administración
  general»**, que sale como una columna aparte en el informe. El reparto (por abonados o por
  ingresos) queda para después, cuando lo decidan.
- **D3. Se asigna desde ya a todo lo nuevo** y se rellena hacia atrás **sólo donde la sede sea
  inequívoca**. Lo dudoso queda en «Sin asignar», visible en el informe y nunca inventado.

## Lo que hay hoy (investigado el 2026-09-23)

- `CostCenter` (schema.prisma ~293) es jerárquico y tiene **0 filas**. Tiene relación con
  `JournalLine.costCenterId` e `InventoryMovement.costCenterId`. `FixedAsset.costCenterId` es un
  `String?` sin relación.
- Hay 12.359 `JournalEntry` y 31.830 `JournalLine`, **todas con costCenterId null**.
- En `accounting/posting.service.ts`, los tipos (líneas 9-33) sólo tienen `costCenterId` en
  `SalesInvoiceArgs`, `SalesInvoiceAdjustmentArgs` y `PurchaseBillArgs`, y **ningún llamador lo
  pasa**. Los llamadores son:
  - `postSalesInvoice`: `billing/facturas.service.ts:285` (manual), `:764` (corrida mensual) y
    `omni/omni.service.ts:511` (cotización que pasa a factura).
  - `postSalesInvoiceAdjustment`: `facturas.service.ts:467`.
  - `postCustomerPayment`: `treasury/cobranzas.service.ts:810`.
  - `postTreasuryIncome`: `cobranzas.service.ts:301`.
  - `postTreasuryExpense`: `cobranzas.service.ts:994` (egresos).
  - `postPurchaseBill` y `postSupplierPayment` no tienen llamadores.
  - `journal.service.ts:140,159,191` ya guarda `l.costCenterId`. El asiento manual
    (`JournalEntryModal.tsx`) ya permite elegirlo.
- **De dónde sale la sede de cada cosa:**
  - Factura: la sede del abonado (`Subscriber.branchId` → `Branch`). `SubInvoice.branchRef` es
    texto libre y las facturas nuevas no lo llenan; se usa sólo como respaldo.
  - Movimiento de tesorería: `Transaction.cashAccountId` = `CashAccount.legacyId` →
    `CashAccount.branchLegacy` (**0 = banco**, sin sede). Hay un precedente en
    `treasury/cierre-informe.ts:74-81` (`sedeDelMovimiento`).
  - Bodegas: `MaterialWarehouse.branchLegacy` y `EquipmentWarehouse.branchLegacy`.
  - `SupplyOrder.branchRef` (nombre de la sede) y `Supplier.branchRef` (gid).
  - `Employee` no tiene sede, sólo `area` y `city`. La nómina y la depreciación no generan
    asientos, así que quedan **fuera de alcance**.
- **Informes:** `accounting/reports.service.ts:117` `incomeStatement(range)` no filtra por
  centro. La página es `frontend/src/app/contabilidad/informes/page.tsx`. No hay pantalla para
  administrar centros de costo (el router `accounting.router.ts:66-84` tiene list, create y
  deactivate).
- **Permisos:** `SCREENS` en `backend/src/auth/permissions.catalog.ts:431` (contabilidad hacia
  :516), `screenKey(href)`, la navegación en `frontend/src/lib/nav.ts` y el subnav en
  `components/accounting/ContabilidadSubnav.tsx`.
- **Migraciones:** `backend/prisma/migrations/`, con nombre `YYYYMMDDHHMMSS_snake_case` en
  español. La última es `20260923220000_cartera_seguimiento`.

## Fases

### Fase 0 — Preparación y respaldo
1. Leer las memorias del proyecto (`/home/dev/.claude/projects/-home-dev-saves/memory/`),
   como mínimo: `build-restart-pm2`, `migraciones-y-backup-saves`,
   `contrato-http-es-la-fuente`, `generador-contenedor-roto`, `routers-a-mano-indice`,
   `alcance-sede-una-sola-fuente`, `sql-crudo-fechas-date`, `prisma-not-descarta-null`,
   `pantallas-sin-llave-invisibles`, `fechas-utc-cierre-caja`.
2. Hacer un respaldo de la base con `cd /home/dev/saves/backend && ./scripts/backup-db.sh` y
   anotar en la bitácora la ruta y el tamaño del dump.
3. Guardar una foto del árbol: `git status --porcelain` y `git diff --stat` en
   `docs/centros-de-costo/estado-inicial.txt`, más una copia de `contrato-http.json` y de los
   `*.router.ts` en `docs/centros-de-costo/respaldo-inicial/`.
4. Comprobar que `npm run prisma:status` está al día y que el backend compila
   (`npx tsc --noEmit -p .`). Si ya venía roto, anotar qué errores había antes de empezar.

### Fase 1 — Datos: centros de costo y vínculo con la sede
1. Migración **aditiva** (`npm run prisma:migrate`; `db push` está prohibido):
   - `Branch.costCenterId String? @unique` con relación a `CostCenter`.
   - `CostCenter.kind`: `SEDE | GENERAL | OTRO`, con default `OTRO`. Opcional, sólo si aporta.
2. Script idempotente `backend/scripts/sembrar-centros-costo.ts`, que crea (o reutiliza por
   `code`):
   - La raíz `VESTEL`.
   - Un centro por cada sede, hijo de la raíz, con código `CC-<SEDE>` (`CC-YOPAL`,
     `CC-VILLANUEVA`…), enlazado a su `Branch`.
   - `CC-ADMIN`, «Administración general».

   Correrlo y anotar el resultado.
3. `CostCenter` ya existe en el contenedor. Si hace falta un endpoint nuevo, se sigue el
   procedimiento de las memorias: contrato + `generar:routers` con diff de los routers antes y
   después. **Nunca `generar:contenedor`.**

### Fase 2 — Resolver único: «¿a qué centro va esto?»
1. `backend/src/common/centro-costo.ts`, **la única fuente** (misma lección que
   `sede-scope.ts`), con estas funciones:
   - `centroDeSede(branchLegacyId)`, con caché en memoria que se invalida al sembrar o editar.
   - `centroDeAbonado(subscriberId)`.
   - `centroDeCaja(cashAccountLegacyId)`: la caja de banco (`branchLegacy` 0) → `null`.
   - `centroDeBodega(...)`.
   - `centroGeneral()`.
2. Tests `centro-costo.spec.ts` con los casos borde: abonado sin sede, caja de banco, sede sin
   centro y bodega de tránsito.

### Fase 3 — Poner el centro al crear cada asiento
1. Añadir `costCenterId?` a `CustomerPaymentArgs`, `TreasuryIncomeArgs` y
   `TreasuryExpenseArgs`, y pasarlo a las líneas de ingreso o gasto. En las cuentas de caja,
   bancos y cartera se puede dejar también: no estorba y permite filtrar.
2. Llamadores:
   - Facturas, ajustes, omni y pagos de cliente: el centro del abonado.
   - Ingresos y egresos de tesorería: si el usuario eligió un centro, ese. Si no, el de la
     sede de la caja. Si es banco y no eligió nada, `CC-ADMIN`.
3. En el formulario de egreso o ingreso de tesorería, un **selector opcional «Centro de
   costo»** que por defecto sugiere el de la caja. **No debe hacerse obligatorio:** no puede
   bloquear a las cajeras. Validar en el backend que el centro exista y esté activo.
4. `InventoryMovement` de salida: si no trae centro, el de la sede de la bodega.
5. **Nada de esto puede tumbar la operación:** si el resolver falla, el asiento se crea igual
   con `null` y se registra un aviso (`console.warn`). Contabilizar un pago nunca debe fallar por
   el centro de costo.

### Fase 4 — Rellenar lo que ya existe (backfill)
1. Script `backend/scripts/backfill-centros-costo.ts`:
   - Tiene `--dry` por defecto y sólo escribe con `--aplicar`.
   - Toca **únicamente** líneas con `costCenterId IS NULL`.
   - Se guía por `JournalEntry.sourceType`/`sourceId` (o como se llamen: verificarlo) para
     llegar a la factura, el pago o la transacción, y de ahí a la sede con el resolver de la
     fase 2.
   - Lo ambiguo lo deja en null.
   - Imprime el conteo por centro, cuántas líneas quedan sin asignar y **por qué**.
2. Correr el dry, pegar el resumen en la bitácora y, si cuadra (sin sumas raras ni más del
   ~30 % sin asignar sin explicación), correr `--aplicar` dentro de una transacción o por lotes.
3. Comprobación: la suma de débitos y créditos por cuenta **no cambia** antes y después, porque
   sólo se añade una etiqueta.

### Fase 5 — Informe «Resultados por sede» y administración
1. Backend:
   - `incomeStatement(range, { costCenterId? })`.
   - Un endpoint nuevo `GET /accounting/reports/income-statement-by-center?from&to` que devuelve
     las cuentas de ingreso, costo y gasto en filas, y en columnas cada sede, «Administración
     general», «Sin asignar» y el total. **Invariante:** la suma de las columnas es igual al
     estado de resultados total. Hay que respetar las memorias de fechas (`sql-crudo-fechas-date`
     y `fechas-utc-cierre-caja`).
   - Endpoint de edición de centro de costo (nombre, activo, sede).
2. Frontend:
   - Página `/contabilidad/resultados-por-sede` con la tabla, el selector de rango (mes actual
     por defecto) y la exportación a Excel si el patrón ya existe en otras tablas.
   - Página sencilla `/contabilidad/centros-de-costo`: lista, crear, editar y ver la sede
     vinculada.
   - Cada pantalla con su entrada en `SCREENS` (sin ella sólo la ve el superusuario), en
     `nav.ts` y en el subnav de contabilidad.
   - Acceso: contabilidad, administración y gerencia.
3. Contrato HTTP y routers según las memorias, con diff de los routers antes y después.

### Fase 6 — Build, despliegue y verificación
1. `cd /home/dev/saves/backend && npx tsc --noEmit -p . && npm test` (o los specs tocados) y
   `npm run build`. Confirmar con un `grep` de una cadena nueva en `dist/`, y después
   `pm2 restart saves-backend`.
2. Frontend: **antes de tocar nada, comprobar que no haya otro build corriendo**
   (`ps aux | grep -E "next build|npm run build"`); si lo hay, esperar. Después:
   `pm2 stop saves-frontend && rm -rf /home/dev/saves/frontend/.next && cd /home/dev/saves/frontend && ./node_modules/.bin/next build`
   y, cuando exista `.next/BUILD_ID`, `pm2 restart saves-frontend`. Todo con rutas absolutas.
   **Hacerlo sólo entre las 20:00 y las 06:00 hora Bogotá**; si no, esperar a esa ventana.
3. Verificación con sesión (el token se firma con `AUTH_SECRET` de `backend/.env`):
   - Las páginas nuevas dan 200.
   - El endpoint del informe cuadra: la suma de las columnas = el total = `income-statement`
     sin filtro.
   - Crear un egreso de prueba NO: sólo lectura en producción.
4. Barrer el log de errores de pm2 para ver si aparecen errores nuevos.

### Fase 7 — Cierre
1. `docs/centros-de-costo/RESULTADO.md`: qué se hizo, cifras del backfill, el informe de
   septiembre por sede (resumen) y la lista de decisiones D1-D3 **pendientes de confirmar**.
2. Memoria nueva `centro-costo-por-sede.md`, con su línea en `MEMORY.md` (sección Caja y
   tesorería o Facturación).
3. `FASE 7: OK`.

## Reglas para todas las fases

- **No hacer commit, checkout, restore, stash ni reset.** El árbol tiene cientos de cambios sin
  commitear en `refactor/fundamentos-arquitectura` y el usuario hace el commit él mismo.
- **Nada de `prisma db push` ni de `generar:contenedor`.** Las migraciones son sólo aditivas y
  no se borran ni renombran columnas.
- No tocar el sync ni el writeback con el legacy, ni la factura electrónica, ni los
  cron/WhatsApp.
- **Sólo lectura** sobre datos de negocio. Lo único que se escribe en la base: la migración,
  la siembra de centros y el backfill de `costCenterId` en líneas null.
- Toda llamada Bash que compile lleva `cd /home/dev/saves/<app> &&`.
- Si algo no cuadra o la fase exige una decisión de negocio, **anotarlo en la bitácora como
  BLOQUEO con el detalle y NO escribir `FASE n: OK`**. Mejor detenerse que improvisar sobre
  producción.
- Al final de cada fase, añadir a `BITACORA.md`: la hora, lo hecho, los ficheros tocados, las
  cifras y la línea `FASE <n>: OK`.
