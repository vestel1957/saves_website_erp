# Refactor — estado y backlog

Refactor incremental y seguro del proyecto SAVES (backend NestJS + frontend Next.js).
Rama de trabajo: `refactor/fundamentos-arquitectura`. Cada paso verifica build
(`tsc --noEmit`, `eslint`, `nest build`/`next build`) y va en su propio commit.

## Principios

- **Sin cambiar comportamiento**: las extracciones mueven código; no reescriben lógica.
- **Adopción progresiva del linter**: reglas ruidosas (`any`, react-hooks del compiler)
  como `warning`, no `error`, para no bloquear el build sobre código existente. Se van
  saldando fila a fila.
- **Verificar en cada paso**: nada se da por hecho sin `tsc`/`eslint`/build en verde.

---

## Hecho

### Fase 1 — Base limpia
- 120 archivos en curso consolidados en un commit snapshot reversible.
- `*.xlsx` añadido a `.gitignore`.

### Fase 2 — Fundamentos y tooling
- **ESLint 9 (flat config)** en backend (typescript-eslint) y frontend (eslint-config-next).
- **Prettier 3** con estándar único (`singleQuote`, `trailingComma: all`, `printWidth: 100`).
- **TypeScript `strict: true`** en backend (antes parcial) + `@types/multer`.
- **`.editorconfig`** raíz.
- Scripts homogéneos en ambos: `typecheck`, `lint`, `lint:fix`, `format`, `format:check`.
- Estado del linter: **0 errores** en ambos (backend 280 warnings, frontend 795 warnings = deuda progresiva visible).

### Fase 3 — Backend (en curso)
- `subscribers.service.ts` (945→867): extraídos `SubscriberGeoService`,
  `SubscriberFilesService`, `SubscriberNotesService` (bloques 100% aislados).
- Helpers canónicos `common/money.ts` (`num`/`round2`) y `common/subscriber-name.ts`
  (`subName`/`displayName`) + tests.

### Fase 5 — Tests + CI (arrancada)
- Jest operativo con primeros tests unitarios (`common/*.spec.ts`).
- **GitHub Actions** (`.github/workflows/ci.yml`): lint + typecheck + test (backend) y
  lint + typecheck (frontend) en cada push/PR.

---

## Backlog priorizado (menor → mayor riesgo)

### Backend — extracciones de god services

Orden recomendado (del análisis de dependencias):

1. **Deduplicación de helpers** (en curso): reemplazar las ~22 copias de `num`, ~12 de
   `round2` y ~14 de `subName`/`displayName` por los helpers de `src/common/`.
2. **`subscribers.service.ts`** (867 líneas restantes):
   - `SubscriberInvoicesService` — bloque de facturas del cliente (`invoices`,
     `updateInvoice`, `deleteInvoice`, `statement`) + `INVOICE_SELECT`/`mapInvoice`.
     Cuidado: `update/deleteInvoice` llaman `this.detail(...)`.
   - `SubscriberQueryBuilder` — `buildListWhere`/`computeWhere`/`matchingIds`/`debtCountIds`
     (lógica pura de `where`, compartida por `list` y las masivas).
   - `SubscriberBulkOpsService` — `cutByFilter`/`reconnectByFilter`/`messageByFilter`
     (aísla la dependencia a Mikrotik; conservar `MAX_BULK=2000`).
   - `PppUsernameValidator` — `pppUsernameTaken`/`checkDuplicates` (única dependencia a
     `MikrotikAdminService`; conservar el fail-safe que nunca reporta "libre").
3. **`treasury/cobranzas.service.ts`** (857 líneas):
   - `TxCategoriesService` (CRUD de categorías, autónomo).
   - `CashAccountsService` (CRUD de cajas + `recomputeCashAccount`).
   - `CashOpenService` (apertura de caja).
   - `CashCloseService` (cierre/arrastre; ya aislado por `cierre-legacy.ts`/`caja-scope.ts`).
   - **Núcleo que NO se separa**: `createIncome`/`collect`/`voidTransaction(Tx)`/
     `editTransaction`/`createExpense`/`createTransfer` comparten `recomputeSubscriber`/
     `recomputeCashBalance` dentro de transacciones Prisma. Solo extraer esos dos
     `recompute*` a un `TreasuryBalanceService`.
   - ⚠️ Riesgos: `voidTransactionTx(tx, id, dto, user)` lo llama `FacturasService` con una
     `tx` abierta — **no cambiar su firma**. `posting.*` se invoca fuera de la `$transaction`
     (idempotente) — no moverlo dentro. `mikrotik.reconnect` en `collect` es best-effort.
4. **`network/mikrotik.service.ts`** (900 líneas) — el más delicado (todo side-effects
   SSH/RouterOS; el gate `this.live`/`syncLive()` es la protección crítica):
   - `MikrotikMessagingService` (`toE164`/`messageBatch`) — quita la dependencia a WhatsApp.
   - `AddressListOps` (helper puro: `cutOnApi`/`reconnectOnApi`/`markMorosoOnApi`/`unmark…`).
   - `RouterResolver` (`loadSubscriber`/`resolveRouter`/`comment`/`sedeOtherRouters`).
   - `MikrotikAudit` (`audit`/`history`).
   - `MikrotikBatchService` (`cutBatch`/`reconnectBatch`/`restoreBranch`/`batchByRouter`) — último.
   - Oportunidad transversal: unificar el patrón `connect → try/comm/close → audit` en un
     `withRouterConnection(router, fn)` y el bloque dry-run "steps" repetido 4 veces.

### Frontend — extracción de god pages

Cliente HTTP: **ya existe** `useAuth().authFetch` (canónico) y el molde `accountingApi(authFetch)`.
El trabajo es mover llamadas inline a `src/lib/xxxApi(authFetch)` y sacar sub-componentes.

1. **`reportes/page.tsx`** (703, en curso): `buildExportDoc`/`datePresets`/constantes →
   `src/lib/reportes.ts`; 11 renderers → `src/components/reportes/`.
2. **`empleados/[id]/page.tsx`** (935): extraer `PermisosCard` (~480 líneas, casi una página),
   `EditarEmpleadoModal`, y las funciones puras del árbol de permisos (`buildPermTree`/
   `prunePermTree`) → `src/lib/permtree.ts`. Crear `src/lib/staff.ts` → `staffApi(authFetch)`.
3. **`configuracion/usuarios/page.tsx`** (1041): extraer los 4 modales (`CreateUserModal`,
   `EditRolesModal`, `EditUserModal`, `RoleBuilderModal`) + eliminar el `Modal` local
   duplicado usando `@/components/Modal`. Crear `src/lib/users.ts` → `usersApi(authFetch)`.
4. **`clientes/[id]/page.tsx`** (956): extraer `FacturaInfoModal` (único modal aún inline) y
   los presentacionales; hook `useSubscriberDetalle(id)` que agrupe las 4 cargas + 8 mutaciones.
5. **Transversal**: `Card`/`Row`/`StatCard`/`initials` están triplicados entre las 3 páginas de
   detalle → consolidar en `src/components/ui/`.

### Deuda de calidad (progresiva, no bloqueante)

- Bajar los **warnings** de ESLint fila a fila: tipar los `any` (600 front / 257 back),
  resolver `react-hooks/exhaustive-deps` y `set-state-in-effect`.
- Ampliar cobertura de tests hacia la lógica de negocio crítica (facturación, cierres de caja,
  cortes/reconexión) a medida que se extraen a servicios testeables.
