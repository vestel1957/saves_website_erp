# Nexus Business OS — Executive Dashboard

Implementación 100% funcional de la pantalla **Screen 1 · Executive Dashboard**
(Dashboard + CRM) del diseño `untitled.pen`.

## Stack

| Capa       | Tecnología                                   |
| ---------- | -------------------------------------------- |
| Frontend   | Next.js 15 (App Router) + Tailwind v4 + lucide-react |
| Backend    | NestJS 10 + Prisma ORM                       |
| Base datos | PostgreSQL 16 (Docker)                       |

## Estructura

```
nexus-erp/
├── docker-compose.yml      → PostgreSQL (puerto 5544) + pgAdmin (puerto 5050)
├── backend/                → API NestJS  (http://localhost:4000/api)
└── frontend/               → Dashboard Next.js (http://localhost:3000)
```

## Cómo levantar todo

### 1. Base de datos (Docker Desktop debe estar abierto)

```powershell
cd nexus-erp
docker compose up -d db
```

### 2. Backend

```powershell
cd backend
npm install
npm run db:setup      # genera Prisma client, crea tablas y siembra datos
npm run start:dev     # API en http://localhost:4000/api
```

### 3. Frontend

```powershell
cd frontend
npm install
npm run dev           # Dashboard en http://localhost:3000
```

## Endpoints de la API

| Método | Ruta                         | Descripción                          |
| ------ | ---------------------------- | ------------------------------------ |
| GET    | `/api/dashboard/overview`    | Payload completo del dashboard       |
| GET    | `/api/dashboard/kpis`        | Tarjetas KPI                         |
| GET    | `/api/dashboard/revenue`     | Revenue mensual (12 meses)           |
| GET    | `/api/dashboard/deals`       | Top deals por cerrar                 |
| GET    | `/api/dashboard/activity`    | Feed de actividad reciente           |
| GET    | `/api/dashboard/leaderboard` | Ranking de ventas Q2                 |
| GET    | `/api/dashboard/regions`     | Revenue por región                   |

## Módulo de Contabilidad

Contabilidad profesional con **partida doble** y **posteo automático dirigido por eventos**.
Los módulos de origen (Ventas, Compras, Bancos, Inventario) solo **emiten eventos**; el módulo
contable los escucha y genera los asientos balanceados — integración 100% desacoplada.

### Flujo automático

| Evento del sistema             | Asiento generado                                     |
| ------------------------------ | ---------------------------------------------------- |
| Venta realizada                | Dr Cuentas por cobrar / Cr Ingreso / Cr Impuesto     |
| Compra registrada              | Dr Gasto\|Inventario / Dr Impuesto desc. / Cr CxP    |
| Pago recibido                  | Mov. bancario → abono CxC → Dr Banco / Cr CxC        |
| Pago a proveedor               | Mov. bancario → abono CxP → Dr CxP / Cr Banco        |
| Movimiento de inventario (OUT) | Dr Costo de ventas / Cr Inventario                   |

Las cuentas se resuelven desde `AccountMapping` (configurable en BD), nunca hardcodeadas.
Cada asiento es idempotente por `(sourceType, sourceId)` y siempre valida **Débitos = Créditos**.

### Submódulos

Plan de cuentas (árbol) · Asientos (manual/automático/recurrente) · Libro diario · Libro mayor ·
Balance de comprobación · Estados financieros (balance general, resultados, flujo de efectivo) ·
Centros de costo · Cuentas por cobrar/pagar (derivadas, sin duplicar) · Conciliación bancaria ·
Cierre mensual/anual · Motor de impuestos configurable (sin país específico).

### Endpoints principales (`/api`)

| Método   | Ruta                                            | Descripción                      |
| -------- | ----------------------------------------------- | -------------------------------- |
| GET/POST | `/accounting/accounts` · `/accounts/tree`       | Plan de cuentas                  |
| GET/POST | `/accounting/journal-entries`                   | Libro diario / asientos manuales |
| POST     | `/accounting/journal-entries/:id/reverse`       | Reversar asiento                 |
| GET      | `/accounting/ledger/:accountId`                 | Libro mayor por cuenta           |
| GET      | `/accounting/reports/trial-balance`             | Balance de comprobación          |
| GET      | `/accounting/reports/balance-sheet`             | Balance general                  |
| GET      | `/accounting/reports/income-statement`          | Estado de resultados             |
| GET      | `/accounting/reports/cash-flow`                 | Flujo de efectivo                |
| GET      | `/accounting/receivables` · `/payables`         | CxC / CxP + aging                |
| POST     | `/accounting/periods/:id/close` · `/close-year` | Cierre mensual / anual           |
| GET/POST | `/accounting/tax-codes`                         | Motor de impuestos               |
| POST     | `/sales/invoices` · `/sales/payments`           | Demo: dispara posteo automático  |
| POST     | `/purchases/bills` · `/inventory/movements`     | Demo: dispara posteo automático  |

UI bajo `/contabilidad` (Next.js): plan de cuentas, libro diario, libro mayor, balance de
comprobación y estados financieros conectados a la API en tiempo real.

## Notas

- El puerto de Postgres es **5544** (no el 5432) para evitar conflicto con un
  PostgreSQL nativo de Windows que ya ocupa el 5432.
- Credenciales DB: `nexus` / `nexus`, base `nexus`.
- pgAdmin disponible en http://localhost:5050 (`admin@nexus.dev` / `admin`).
