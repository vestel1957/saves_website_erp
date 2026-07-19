# SAVES — ISP Vestel

Sistema de gestión del ISP **Vestel**: clientes, facturación (incluida la electrónica ante
la DIAN vía Siigo), cartera y cobranza, tesorería, contabilidad, red (Mikrotik / OLT /
GenieACS), soporte técnico, inventario y compras.

Es la reescritura del sistema legacy en PHP (CodeIgniter) que hoy sigue en producción, en
`/var/www/vhosts/saves.com.co/httpdocs/saves-vestel`. **No es una copia 1:1**: replica la
lógica del legacy en los caminos que mueven plata, se aparta de él de forma deliberada
donde el legacy estaba mal, y agrega capacidades que no existían (contabilidad, permisos
granulares, auditoría).

> El proyecto arrancó desde una copia de "Nexus ERP" y de ahí heredó parte del andamiaje.
> No comparte historia de git con aquel proyecto: es un repositorio independiente.

## Estado (15 jul 2026)

**Esto todavía no reemplaza al legacy.** El legacy sigue siendo el sistema de verdad.

| | |
| --- | --- |
| Brechas críticas de paridad | 13/13 cerradas |
| P0 (plata y cumplimiento) | 8/8 cerrados, verificados contra la BD real |
| Datos | Foto del **2 jul 2026**. Nexus **no ha creado ninguna factura ni pago real** |
| Facturación electrónica | `EINVOICE_LIVE` apagado → arma el documento pero **no timbra** |
| Backlog vivo | ~60 puntos entre P1 (operación) y P2 (estabilización) |

Antes de cualquier corte hay que: re-migrar o sincronizar el delta de datos, correr la
facturación en paralelo contra el legacy y comparar factura por factura, y timbrar unas
pocas facturas reales antes de soltar el lote.

## Stack

| Capa | Tecnología |
| --- | --- |
| Frontend | Next.js 16 (App Router) + Tailwind v4 |
| Backend | NestJS 10 + Prisma ORM |
| Base de datos | PostgreSQL (`localhost:5432`, base `saves_vestel`) |
| Procesos | PM2 (`ecosystem.config.js`) |

## Cómo levantar

En este servidor ya corre bajo PM2:

```bash
pm2 list                      # saves-backend (3061) · saves-frontend (3060)
pm2 logs saves-backend
```

- Backend: http://localhost:3061/api
- Frontend: http://localhost:3060

Desde cero:

```bash
cd backend  && npm install && npx prisma generate && npx nest build
cd frontend && npm install && npm run build
pm2 start ecosystem.config.js
```

### Al cambiar código del backend

PM2 ejecuta **`dist/src/main.js`**, no los fuentes. Un `pm2 reload` sin compilar **no toma
los cambios**:

```bash
cd backend && npx nest build && ls dist/src/main.js && pm2 reload saves-backend
```

El `ls` no sobra: `nest build` puede terminar con éxito sin emitir nada (borra `dist/` y el
`tsconfig.tsbuildinfo` incremental le hace creer que no hay nada que recompilar). Si el
archivo no está, vuelve a correr `nest build` — la segunda vez sí emite. Recargar contra un
`dist` inexistente deja el backend caído.

## Desarrollo y calidad de código

Ambos paquetes comparten el mismo tooling (ESLint 9 flat config + Prettier 3):

```bash
# backend/ o frontend/
npm run lint          # ESLint (0 errores; warnings = deuda progresiva)
npm run lint:fix      # autofix
npm run format        # Prettier --write
npm run format:check  # Prettier --check
npm run typecheck     # tsc --noEmit
npm test              # Jest (solo backend, por ahora)
```

- El backend compila en **TypeScript `strict`**.
- Las reglas ruidosas del linter (`any`, react-hooks del compiler) están como **warning**
  a propósito, para ir saldándolas sin bloquear el build. No añadas código con **errores**.
- **CI** (`.github/workflows/ci.yml`) corre lint + typecheck + test en cada push/PR.
- El plan de refactor incremental y su backlog están en [`REFACTOR.md`](./REFACTOR.md).

## Migraciones de base de datos

El esquema se versiona con **migraciones Prisma**. La base de producción está
baselineada en `0_init` (192 tablas), verificado aplicándolo sobre una base vacía.

```bash
# backend/
npm run prisma:status    # ¿está la BD al día con las migraciones?
npm run prisma:migrate   # crear una migración tras editar schema.prisma (pide nombre)
npm run prisma:deploy    # aplicar migraciones pendientes (producción)
```

> ⚠️ **No uses `prisma db push`.** Sincroniza el esquema sin dejar rastro: no hay
> historial, ni rollback, ni forma de revisar el cambio en un PR, y provoca drift
> respecto a las migraciones. Por eso se retiró el script `prisma:push`.

- `0_init/migration.sql` empieza con `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  que Prisma no emite solo y sin el cual fallan los índices GIN de `Subscriber`.
- **Backup**: `npm run db:backup` (`pg_dump -Fc`, rotación a 14 días). Programado
  a diario a las 3:30 en el crontab del servidor; restaurar con `pg_restore`.

## Módulos

| Módulo | Qué hace |
| --- | --- |
| `subscribers` | Clientes: alta, estados, cortes masivos, datos de conectividad |
| `billing` | Facturación: manual, recurrente, notas crédito/débito, anulación, retenciones |
| `einvoice` | Facturación electrónica DIAN vía Siigo (facturas y notas crédito) |
| `treasury` | Tesorería: recaudo en cascada, cajas, arqueo, egresos |
| `collections` | Cobranza: llamadas y acuerdos de pago |
| `payment-imports` | Carga masiva de pagos externos (Efecty) |
| `accounting` | Contabilidad por partida doble (PUC Colombia) |
| `network` | Mikrotik, OLT y GenieACS/TR-069 |
| `support` | Órdenes de trabajo, firma, materiales, evidencia |
| `orders` · `inventory` · `returns` | Compras, bodegas, devoluciones |
| `plans` · `promotions` | Planes de servicio y promociones |
| `playhub` | Integración IPTV |
| `movil` | Móviles y cuadrillas |
| `reports` · `dashboard` | Reportes de gerencia (incluido el de IVA) e indicadores |
| `auth` | Autenticación y permisos por rol, con excepciones por usuario |
| `chatbot` | Agente de WhatsApp (ajeno a la migración; depende de `@s4gk/wa-agent`) |

### Contabilidad

Partida doble con plan de cuentas del PUC Colombia. **No es dirigida por eventos**: los
flujos de negocio llaman a `PostingService` directamente (`postSalesInvoice`,
`postCustomerPayment`, `postTreasuryIncome`, `postTreasuryExpense`). Cada asiento es
idempotente por `(sourceType, sourceId)` y valida que débitos = créditos. El posteo va
siempre fuera de la transacción del negocio y nunca rompe el flujo si falla.

Cableado hoy: facturación (crear, recurrente, convertir cotización) y tesorería (recaudo,
ingreso, egreso). **Sin cablear**: pagos a proveedor y devoluciones. Las transferencias
entre cajas no se contabilizan (no impactan resultados).

## Interruptores importantes

Viven en `ecosystem.config.js` y algunos tienen un ajuste equivalente en la tabla de
configuración, que manda sobre la variable de entorno.

| Variable | Hoy | Efecto |
| --- | --- | --- |
| `MIKROTIK_LIVE` | `true` | Cortes y reconexiones **ejecutan de verdad** contra los routers |
| `OLT_LIVE` | `true` | Autorizar/reiniciar ONU ejecuta por SSH contra las OLT |
| `EINVOICE_LIVE` | sin definir | Sin esto **no se timbra** ante la DIAN: solo se arma el payload |
| `CRONS_ENABLED` | `true` | Facturación recurrente y paso a cartera programados |

Ajustes en base de datos que cambian comportamiento: `billing.dueDay` (día de vencimiento,
por defecto 20, como el legacy) y `tickets.cascadeBilling` (cobrar al cerrar una orden;
hoy **apagado**, mientras que el legacy siempre cobraba).

## Relación con el legacy

El principio es que SAVES se parezca lo más posible al legacy: mismos defaults, mismos
topes, misma cascada. Cuando el legacy y una auditoría discrepan, **manda el código legacy
vivo**. Las desviaciones son decisiones tomadas a conciencia, no accidentes — y las
importantes están documentadas en el código, junto a la referencia `archivo:línea` del
legacy que replican.
