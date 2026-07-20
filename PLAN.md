# Plan de endurecimiento — SAVES

Plan completo derivado de la auditoría del **19–20 jul 2026** (arquitectura backend,
frontend, seguridad y capa de datos/testing) sobre ~62k LOC.
Rama: `refactor/fundamentos-arquitectura`.

El backlog de refactor *estructural* (extraer god services, god pages) sigue en
[`REFACTOR.md`](./REFACTOR.md). Este documento cubre lo que la auditoría encontró:
corrección, seguridad y operación. Cuando entren en conflicto, manda este.

---

## Por qué NO se hace "todo de un solo golpe"

Es un ERP en producción que factura, mueve caja y corta servicio real
(`MIKROTIK_LIVE=true`, `OLT_LIVE=true`, `CRONS_ENABLED=true`). Hacerlo todo en un
único cambio grande falla por tres razones concretas, no por prudencia genérica:

1. **La cobertura es del 0,12 %.** No hay red que detecte una regresión. Un lote
   grande hace imposible saber *cuál* de los 40 cambios rompió la facturación.
2. **El CI nunca ha corrido** — el repo no tiene remoto, así que GitHub Actions
   jamás se ejecutó. La única verificación real hoy es la local y manual.
3. **Varios arreglos son observables por el usuario** (permisos que empiezan a
   denegar, sesiones que caducan, listados que muestran menos filas). Sueltos son
   diagnosticables; juntos son "el sistema se rompió".

**Lo que sí se puede hacer sin parar**: ejecutar los bloques de abajo en orden, uno
tras otro, sin esperar aprobación entre ellos. Es continuo, no lento. Lo que no se
hace es *mezclarlos en un commit*.

**Regla de oro del plan**: ningún arreglo de dinero o permisos entra sin una prueba
que falle antes y pase después. Ya se hizo así con `collect()`
(`scripts/smoke-collect-race.ts`) y con el IDOR de tesorería.

---

## Estado — hecho el 19–20 jul 2026

| Commit | Qué |
|---|---|
| `e293c69` | Secretos fuera de `ecosystem.config.js` (los lee de `.env`); webhook WhatsApp deja de fallar abierto |
| — | `AUTH_SECRET` y contraseña de Postgres **rotados**; backup diario real restaurado (3:30) y verificado (352 MB, `pg_restore -l` OK) |
| `2f5b130` | Baseline de migraciones `0_init` (192 tablas); `db push` retirado |
| `f365524` | IDOR de tesorería cerrado + `caja-scope.spec.ts` (17 casos) |
| `18ac02d` | Carrera de `collect()` cerrada con `FOR UPDATE` + smoke de regresión |
| `6392c45` | **1.1** Consecutivos con secuencias de Postgres (4 servicios) + smoke |
| `7586371` | **1.2** Pendientes contables visibles y reintentables (`PendingPosting`) |
| `2cecd14` | **1.3** Saldo de caja bajo concurrencia + ORDEN DE BLOQUEO + smoke de deadlock |
| `9dcbe9b` | **1.4** Misma carrera en abonos de órdenes y devoluciones |
| `d8dc03d` | **5.1** `scripts/verify.sh` — la única verificación real hasta que haya remoto |
| `24c6923` | **3.1** Filtro global de excepciones con traducción de Prisma |
| `19bac12` | Asignación de sedes por usuario (alta + permisos) — desbloquea 2.1 |
| `2a33547` | **2.1** Acceso por sede en clientes, facturas y tickets (+ masivas, ⌘K, chatbot) |
| `c4a0bfb` | **2.4/2.6/2.7** Adjuntos no ejecutables, throttle en portal, helmet + rate limit |
| `d5a53de` | **2.5/2.8** Credenciales de red cifradas (+SECRET_ENC_KEY), DTOs en settings |
| `8ab6d85` | **4.1/4.2** 3 índices medidos (309ms→0,15ms) y 5 GIN duplicados retirados |
| `89a30f5` | **4.3/3.4** Secuencia para `abonado` + validación de entorno al arranque |
| `11d0bbc` | **3.2/3.3** Errores de importación con contexto, no-empty activo, paginación |
| `72a3891` | **6.1/6.4/6.5** Build valida tipos, a11y en Field y Modal, formateadores únicos |
| `0496924` | **6.3/6.7** Cancelación de peticiones (`useRequest`) y ui/ ordenado |

Tests: 14 → 86 (9 suites). Cobertura: sigue siendo ínfima fuera de estos módulos.

---

## Bloque 1 — Integridad del dinero (máxima prioridad)

Lo que puede descuadrar plata o perder documentos. Cada punto necesita prueba propia.

- [x] **1.1 `nextTid()` → secuencia de Postgres.** `billing/facturas.service.ts:68-71`
  genera el consecutivo con `MAX(tid)+1`. `tid` es `@unique`, así que no duplica:
  revienta. En `generate()` (cron mensual sobre ~21k abonados) eso se convierte en
  `failed++` con `reason:'ERROR'` y **ese abonado no se factura ese mes**, sin
  reintento y sin alerta. En `createInvoice()` sube como 500 crudo.
  *Cómo*: `CREATE SEQUENCE` en una migración, inicializada a `MAX(tid)+1`; `nextTid`
  pasa a `nextval`. *Prueba*: smoke de N facturas concurrentes, cero colisiones.
  *Riesgo*: bajo, pero toca facturación — hacerlo con el cron parado.

- [x] **1.2 Fallos de contabilización visibles.** `accounting/posting.service.ts:28-34`
  (`safePost`) traga cualquier error, loguea un warn y devuelve `null`. Puede quedar
  factura emitida o recaudo cobrado **sin asiento**, sin marca en la respuesta y sin
  forma de saber cuáles. Llamadas afectadas: `facturas.service.ts:147` y `:317`,
  `cobranzas.service.ts:148` y `:349`.
  *Cómo*: tabla de pendientes contables (documento, tipo, error, intentos) + endpoint
  para listarlos y reprocesarlos. No cambiar el comportamiento best-effort: el
  documento debe seguir guardándose aunque el asiento falle.

- [x] **1.3 `recomputeCashBalance` bajo concurrencia.** `cobranzas.service.ts:106-116`
  recalcula el saldo con un `aggregate` completo dentro de la transacción, pero en
  READ COMMITTED no ve las transacciones concurrentes sin commitear → el `balance`
  de la caja puede quedar corto. *Atenuante*: es un recálculo desde las filas
  origen, así que la siguiente escritura lo corrige — es divergencia temporal, no
  pérdida. *Cómo*: bloquear la fila `CashAccount` antes de recalcular, igual que
  se hizo con `Subscriber` en `lockSubscriber`.

- [x] **1.4 Auditar el resto de read-modify-write sobre dinero.** `collect` y
  `voidTransactionTx` ya están. Revisar `createIncome`, `createExpense`,
  `createTransfer`, `editTransaction` y los cierres de caja con el mismo criterio:
  ¿se lee fuera de la transacción algo que luego se escribe sumando?

- [ ] **1.6 Pagos de compras/devoluciones no actualizan el saldo de caja.**
  `orders.service.ts paySupplyOrder` y `returns.service.ts pay` crean un movimiento
  con `cashAccountId` pero **nunca llaman a `recomputeCashBalance`** (es privado de
  `CobranzasService`), así que el `balance` materializado de esa caja queda desfasado
  hasta que otra operación de tesorería la toque. Se autocorrige, pero mientras tanto
  un arqueo de esa caja miente. *Cómo*: extraer `recomputeSubscriber`/
  `recomputeCashBalance` a un `TreasuryBalanceService` compartido — que es justo lo
  que `REFACTOR.md` ya proponía— y usarlo desde los tres módulos. Respetar el ORDEN
  DE BLOQUEO. Encontrado al auditar 1.4.

- [ ] **1.5 Precisión decimal.** Los importes son `Decimal(18,2)` en la BD (bien),
  pero todo el cálculo pasa por `number` de JS vía `num()` (156 usos). Con IVA 19 %
  sobre líneas grandes el error es acumulable. *Cómo*: mantener `Prisma.Decimal`
  extremo a extremo en facturación. **Coste alto, beneficio hoy bajo** (COP sin
  centavos + disciplina de `round2` en cada paso). Documentado como decisión
  consciente; no se aborda salvo que aparezca un descuadre real.

---

## Bloque 2 — Autorización y seguridad

- [x] **2.1 `sedesAccede` fuera de tesorería.** El campo existe (`schema.prisma:695`)
  y su **única** lectura en todo el backend es `treasury/caja-scope.ts:55`.
  `subscribers.service.ts:129 list`, `:214 detail`, billing, support, orders y
  network consultan por id sin filtrar por sede: cualquier funcionario con el área
  lee y edita datos de **cualquier sede** cambiando el id de la URL.
  ⚠️ **Hoy no hay ningún usuario con `sedesAccede` poblado** (verificado), así que
  cablearlo no cambia nada hasta que se asignen sedes. **Es una decisión de negocio
  previa**: quién debe ver qué sede. Cablear primero, activar después.

- [ ] **2.2 Permisos por acción, no por área.** Casi todos los controladores llevan
  un único `@RequireArea` de clase. Consecuencias reales: cualquiera del área
  `tecnicos` corta servicio y borra routers (`network.controller.ts:27,41,45`,
  `mikrotik.controller.ts:31,44,60,63`, 24 rutas de `olt.controller.ts`);
  `contabilidad` dispara la facturación masiva (`cron/cron.controller.ts:17,29`);
  todo `administracion` lee la ficha de RRHH de cualquiera (`staff.controller.ts`).
  *Cómo*: `@RequirePermissions` por ruta usando el catálogo que **ya existe** y ya se
  usa bien en `accounting` y `auth`. Empezar por cortes/OLT/cron, que son los
  destructivos. *Observable por el usuario* → avisar antes.

- [ ] **2.3 Token en cookie insegura sobre HTTP.** `frontend/src/lib/auth.ts:119`
  escribe `nexus_token` sin `HttpOnly` ni `Secure`, y el despliegue es
  `http://89.117.146.226:3060`. Encadena con 2.4. *Cómo*: TLS delante de 3060/3061 +
  cookie `HttpOnly; Secure; SameSite`. Requiere que el token deje de leerse desde JS.

- [x] **2.4 XSS almacenado por adjuntos.** El `fileFilter` valida el MIME **declarado
  por el cliente** (`support.controller.ts:78`) mientras el nombre en disco toma la
  extensión del `originalname` (`:76`): un `payload.html` enviado como `image/png`
  queda servido como HTML por `res.sendFile()` en el origen de la API. Afecta a
  `support.controller.ts:89-91` y `treasury.controller.ts:175-178`;
  `extras.controller.ts:45-53` no tiene `fileFilter` en absoluto.
  *Cómo*: `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, y
  derivar la extensión del MIME validado, no del nombre que manda el cliente.

- [x] **2.5 Credenciales de red en texto plano.** `Mikrotik.password`
  (`schema.prisma:4274`) y `Olt.password` (`:4295`) se guardan tal cual. GenieACS sí
  usa `secret-box` (AES-256-GCM) — el patrón correcto ya existe en el repo.
  *Cómo*: cifrar con `secret-box` + migración que reencripte lo existente.

- [x] **2.6 Portal del abonado.** Login = número de abonado (secuencial) + documento,
  **sin throttling** (`portal/portal.controller.ts:15`), a diferencia de
  `auth.controller.ts:23`. Enumerar abonados y probar cédulas es directo.
  *Cómo*: reutilizar `LoginThrottleGuard`.

- [x] **2.7 `helmet` + rate limiting global.** No están en dependencias. El único
  freno es el login (10/5min, en memoria por proceso). PDFs, exportaciones a Excel y
  cortes masivos son fuerza-bruteables.

- [x] **2.8 Endpoints con `@Body` sin DTO.** 12 en total. El crítico es
  `PUT /settings` (`settings.controller.ts:16`), que escribe pares clave/valor
  arbitrarios — y de ahí salen los gates `network.mikrotikLive` / `network.oltLive`.
  Con `whitelist: true`, un tipo no-clase **no se valida ni se filtra**.
  También `@Allow()` en `olt.controller.ts:11-30`: 9 campos que acaban en comandos
  SSH y que `@Allow` no valida (solo evita el stripping) → `@Type(() => Number) @IsInt()`.

- [ ] **2.9 Anti-replay en el webhook de WhatsApp.** La firma ya se verifica y ya no
  falla abierto, pero no hay ventana temporal ni deduplicación de eventos.

- [ ] **2.10 Menores.** `GET /auth/users/options` filtra nombre+email de toda la
  plantilla a cualquier sesión; `middleware.ts:146` es fail-open para tokens sin
  claim `areas`; política de contraseñas de 8 caracteres sin complejidad;
  `docker-compose.yml` expone pgAdmin `admin/admin`; contraseñas demo (`admin123`,
  `sst123`…) en los seeds — verificar que no se sembraron en producción.

---

## Bloque 3 — Robustez del backend

- [x] **3.1 Filtros de excepción.** `@Catch`/`APP_FILTER`: **0 en todo el proyecto**.
  Los errores de Prisma salen como **500 con stack** en vez de 409/404/400: el cliente
  no distingue "consecutivo duplicado" de "la base se cayó".
  *Cómo*: `AllExceptionsFilter` + `PrismaExceptionFilter` (P2002→409, P2025→404,
  P2003→400) como `APP_FILTER`. Alto beneficio, riesgo bajo.

- [x] **3.2 Errores tragados.** 80 de 82 `catch` no relanzan. Muchos son best-effort
  deliberado y comentado (red), pero hay pérdida real de información:
  `data/data.service.ts:125` descarta el mensaje y la fila real (`row: -1`) en la
  importación de equipos; `support-write.service.ts:163,177,183,270` y
  `einvoice/siigo-client.ts:62,80,145` tienen catches vacíos.
  Además `eslint.config.mjs:38` lleva `allowEmptyCatch: true`, que apaga la única
  regla que lo detectaría — quitarlo y saldar la lista.

- [x] **3.3 Query params sin validar.** 153 `@Query('x')` y **cero** `@Query()` con
  DTO → 60 `Number(...)` a mano en controllers. Un `?page=abc` produce `NaN` que
  llega a `skip:` de Prisma. *Cómo*: un `PaginationQueryDto` común y adoptarlo.

- [x] **3.4 Validación de entorno al arranque.** `ConfigModule` está registrado pero
  `ConfigService` **no se inyecta en ningún sitio**: 33 variables se leen con
  `process.env` en 44 puntos, muchas congeladas en propiedades de instancia. Arrancar
  sin `KAPSO_API_KEY` degrada en silencio. *Cómo*: esquema de validación al bootstrap.
  (`ecosystem.config.js` ya falla si faltan las críticas — extenderlo al resto.)

- [ ] **3.5 `findOrThrow`.** 124 de 179 `NotFoundException` van justo detrás de un
  `findUnique`, con mensajes duplicados literalmente (`'Orden no encontrada'` ×15).
  Un helper elimina ~124 bloques. Unificar además `'Cliente no encontrado'` (×15) y
  `'Suscriptor no encontrado'` (×6), que son la misma entidad.

---

## Bloque 4 — Capa de datos

- [x] **4.1 Índices que faltan** (verificados contra las queries reales):
  `Transaction.cashAccountId` **sin ningún índice** siendo el filtro por defecto sobre
  499k filas; `AuditLog` sin índice de `createdAt` paginando por él; `Ticket` sin
  `[status,created]` ni `[type,created]` sobre 315k filas; `SubInvoice` sin nada que
  sirva al `orderBy invoiceDate desc`; `ElectronicInvoice` sin `[type,date]` sobre
  223k; `Transaction` sin `[category,date]`/`[status,date]`/`[cashAccountId,date]`;
  **36 FKs sin indexar**. *Cómo*: una migración por tanda, midiendo con `EXPLAIN` antes
  y después. Ya no hay excusa: las migraciones existen.

- [x] **4.2 Índices GIN duplicados.** Producción arrastra 5 pares exactos
  (`trgm_sub_first`, `trgm_sub_last1`, `trgm_sub_company`, `trgm_sub_doc`,
  `trgm_sub_phone`) creados a mano en la época de `optimize-search.sql`, redundantes
  con los que gestiona Prisma sobre las mismas columnas: ~3,5 MB y mantenimiento GIN
  doble en cada alta/edición. *Cómo*: `DROP INDEX` en una migración.

- [x] **4.3 `Subscriber.abonado` sin `@@unique`.** Tiene índice pero no restricción, y
  se genera con `max(abonado)+1`: nada impide duplicados. Verificar que no los haya
  hoy y añadir la restricción.

- [ ] **4.4 `onDelete: Cascade` en datos fiscales.** Borrar un `SubInvoice` borra sus
  `SubInvoiceItem` (`schema.prisma:3326`) sin dejar rastro. En contabilidad debería ser
  `Restrict` + anulación lógica. Declarado en 75 de 196 relaciones; `onUpdate`: 0.

- [ ] **4.5 Estados como String libre.** 29 campos `status`/`type`/`method` con los
  valores válidos en un comentario, conviviendo con 88 enums bien definidos, y con
  mayúsculas/idioma inconsistentes (`"pending"`, `"Pending"`, `"pendiente"`, `"Activa"`).
  Cualquier query por estado es frágil. Migrar a enum los más usados.

- [ ] **4.6 Caches denormalizados sin invalidación garantizada.** `balance`,
  `debitCache`, `creditCache`, `status`/`previousStatus` en `Subscriber` se comentan
  como "cache; la verdad se recompone desde facturas". *Cómo*: job de verificación
  que compare cache contra origen y reporte divergencias (no que las arregle en
  silencio).

---

## Bloque 5 — Verificación (habilita todo lo demás)

Va después del Bloque 1 solo porque el dinero no espera; en cuanto a valor, es lo que
hace sostenible el resto.

- [x] **5.1 Script `verify` local.** `lint && typecheck && test && build` en un comando,
  para correr antes de cada despliegue. **Es la única verificación real hoy**, porque
  el CI no se ejecuta. Coste: minutos.

- [ ] **5.2 Remoto para el repo.** Sin él, `.github/workflows/ci.yml` es decorativo.
  Hasta entonces, no invertir más en el workflow.

- [ ] **5.3 Añadir los builds al CI** (`nest build`, `next build`) — el propio
  `README.md:63-72` documenta que `nest build` puede terminar en éxito sin emitir
  `dist/src/main.js`, que es exactamente lo que el CI debería atrapar. Solo tiene
  sentido tras 5.2.

- [ ] **5.4 Tests de la lógica crítica**, en este orden: cálculo de totales e IVA de
  factura → cierre de caja y arrastre (`cierre-legacy.ts`, ya aislado y testeable) →
  reparto en cascada de `collect` → RBAC. Los clientes externos (RouterOS, OLT,
  Siigo, GenieACS) **ya están aislados en clases propias**: son mockeables tal cual,
  sin refactor previo.

- [ ] **5.5 Postgres en CI** para que las migraciones y las queries se verifiquen.
  Hoy ningún job levanta base, así que ningún índice ni ningún cambio de esquema se
  comprueba jamás.

---

## Bloque 6 — Frontend

- [x] **6.1 Retirar `ignoreBuildErrors`.** `next.config.mjs:5` tiene
  `typescript: { ignoreBuildErrors: true }`: el build **no valida tipos**. Mientras
  esté, `strict: true` es decorativo.

- [ ] **6.2 Tipar el contrato de API.** 605 `any` en 85 archivos (el 75 % de los 795
  warnings). Peores: `clientes/[id]` (40), `configuracion` (30), `inventario` (27).
  Sin esto `tsc` no detecta que el backend renombró un campo. Empezar por las 6
  páginas peores (168 `any` concentrados).

- [x] **6.3 Capa de datos con cancelación.** **0 `AbortController`** en todo el
  frontend: en cada listado con filtros, una respuesta vieja puede sobrescribir a una
  nueva (`clientes/page.tsx:45-69` es el patrón). Adoptar SWR/TanStack Query sobre
  `authFetch` elimina de un golpe las carreras, los 143 `set-state-in-effect`, los 56
  `catch` vacíos y ~500 líneas de `useState(loading/error/data)` repetidas.
  Alternativa mínima: adoptar `lib/usePaginatedList.ts`, que **ya está escrito y no lo
  usa nadie**, añadiéndole cancelación y estado de error.

- [x] **6.4 Accesibilidad.** `htmlFor`: **0 ocurrencias** en 76 `<label>`. El defecto
  está en el wrapper `components/ui/Field.tsx:47-70`, así que **arreglar un archivo**
  (con `useId()`) asocia ~76 etiquetas de golpe. Después: `role="dialog"` + focus trap
  en `components/Modal.tsx`, y `aria-label` en los botones icon-only (34 para 221
  botones).

- [x] **6.5 Consolidar duplicados.** `StatCard` definido 7 veces, `fmtDate` 31 veces,
  `Row` 5, `Card` 2, moneda con 4 implementaciones, `Modal` duplicado. Existe
  `lib/format.ts` y casi nadie lo usa. Mover a `lib/format.ts` y `components/ui/`.

- [ ] **6.6 God pages.** `configuracion/usuarios` (1041 líneas, 37 `useState`),
  `clientes/[id]` (956), `empleados/[id]` (935). La técnica ya está probada en el
  repo: `reportes` pasó de 703 a 110 líneas en `3c81957`.

- [x] **6.7 Recolocar lo mal ubicado.** `PageHeading` vive en `components/accounting/`
  y lo importan 82 archivos de todos los dominios; `DataTable` en
  `components/inventory/` con 66 consumidores. Mover a `components/ui/`.

- [ ] **6.8 RSC donde aporte.** 93 de 93 `page.tsx` son `"use client"`; 0 `error.tsx`,
  0 `not-found.tsx`, 2 `loading.tsx`. No hace falta migrar las 93: quitar
  `"use client"` de las 10-15 páginas de solo lectura (reportes, informes, detalles)
  recupera parte del valor del framework. Añadir `error.tsx` en la raíz.

---

## Bloque 7 — Deuda estructural

Ver [`REFACTOR.md`](./REFACTOR.md) para el detalle y el orden por dependencias.
Resumen: `mikrotik.service.ts` (900), `subscribers.service.ts` (867),
`cobranzas.service.ts` (856) y 6 métodos de más de 100 líneas
(`generate()` 161, `collect()` 142, `arqueo()` 124).

⚠️ **Esto va al final a propósito.** Extraer servicios sin tests es mover código a
ciegas. Con el Bloque 5 hecho, deja de ser una apuesta.

Oportunidad transversal ya identificada: unificar el patrón
`connect → try/comm/close → audit` de Mikrotik en un `withRouterConnection(router, fn)`
y el bloque dry-run "steps" repetido 4 veces.

---

## Orden de ejecución

```
1.1 → 1.2 → 1.3 → 1.4        dinero (con prueba cada uno)
5.1                          script verify (habilita el resto)
3.1                          filtros de excepción
2.4 → 2.6 → 2.7 → 2.8        seguridad sin impacto visible
2.5                          cifrar credenciales de red
4.1 → 4.2 → 4.3              índices y limpieza (medir con EXPLAIN)
5.4                          tests de facturación y cierre de caja
6.1 → 6.4 → 6.5              frontend barato y de alto impacto
2.2 → 2.1                    permisos finos y sedes  ← AVISAR ANTES: visible
2.3 + 5.2/5.3                TLS y remoto             ← requiere infraestructura
3.2 → 3.3 → 3.4 → 3.5        robustez
6.2 → 6.3 → 6.6 → 6.7 → 6.8  frontend de fondo
4.4 → 4.5 → 4.6              modelo de datos
7                            deuda estructural (ya con tests)
```

**Dependencias duras**: 2.1 necesita una decisión de negocio (qué sede ve cada
usuario). 2.3 y 5.2/5.3 necesitan infraestructura (TLS, remoto git). 7 necesita 5.4.

**Notas de método**: las referencias `archivo:línea` son de la auditoría del 19–20 jul;
verificarlas al abordar cada punto, no darlas por vigentes. Todo cambio de dinero o
permisos entra con prueba que falle antes y pase después. Nada se marca como hecho sin
verificación ejecutada — no basta con que compile.
