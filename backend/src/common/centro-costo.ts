import type { PrismaClient } from '@prisma/client';

/**
 * «¿A qué centro de costo va esto?» — LA ÚNICA FUENTE (misma lección que `sede-scope.ts`).
 *
 * Contabilidad de gestión: cada sede tiene su centro (`Branch.costCenterId`, sembrado por
 * `scripts/sembrar-centros-costo.ts` como `CC-<SEDE>`) y lo compartido va a «Administración
 * general» (`CostCenter.kind = GENERAL`, `CC-ADMIN`). Ver docs/centros-de-costo/PLAN.md.
 *
 * Reglas que hay que respetar en todos los llamadores:
 *   - Se devuelve el `CostCenter.id`, o `null` si la sede NO es inequívoca. Nunca se
 *     inventa: lo dudoso queda «Sin asignar» (decisión D3).
 *   - Un centro INACTIVO no se asigna automáticamente (sale `null`). Si alguien lo
 *     desactiva es porque no quiere que le caigan más asientos.
 *   - Las sedes se identifican por `Branch.legacyId` (el `gid`), igual que
 *     `CashAccount.branchLegacy` y las bodegas. `branchLegacy = 0` es un BANCO, no una sede.
 *   - Estas funciones pueden lanzar si falla la BD. Al contabilizar hay que envolverlas en
 *     `centroSinFallar`: un pago nunca debe dejar de registrarse por el centro de costo.
 *
 * Recibe cualquier cliente Prisma (el `PrismaService` del backend o un `PrismaClient` de
 * script, p. ej. el backfill).
 */
export type DbCentros = Pick<
  PrismaClient,
  'branch' | 'costCenter' | 'subscriber' | 'cashAccount' | 'materialWarehouse' | 'equipmentWarehouse'
>;

// ---------------------------------------------------------------------------------------
// Caché: 7 sedes y un par de centros, cambia casi nunca y se pregunta en cada asiento.
// El TTL cubre lo que se edite desde OTRO proceso (el script de siembra, un backfill);
// lo que se edite desde este proceso llama a `invalidarCacheCentros()`.
// ---------------------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60_000;
const CODIGO_GENERAL = 'CC-ADMIN';

type Mapa = {
  /** Branch.legacyId → CostCenter.id (sólo centros activos). */
  porSede: Map<number, string>;
  /** Centro de «Administración general» activo, o null si no hay. */
  general: string | null;
  exp: number;
};

let cache: Mapa | null = null;
let cargando: Promise<Mapa> | null = null;

/** Olvida la caché. Llamarla tras crear, editar, activar o desactivar un centro o su sede. */
export function invalidarCacheCentros(): void {
  cache = null;
  cargando = null;
}

async function cargarMapa(prisma: DbCentros): Promise<Mapa> {
  const [sedes, generales] = await Promise.all([
    prisma.branch.findMany({
      where: { costCenterId: { not: null } },
      select: { legacyId: true, costCenter: { select: { id: true, isActive: true } } },
    }),
    prisma.costCenter.findMany({
      where: { kind: 'GENERAL', isActive: true },
      select: { id: true, code: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const porSede = new Map<number, string>();
  for (const s of sedes) if (s.costCenter?.isActive) porSede.set(s.legacyId, s.costCenter.id);
  // Si hubiera más de un GENERAL activo, manda el del sembrado; si no, el más antiguo.
  const general = (generales.find((g) => g.code === CODIGO_GENERAL) ?? generales[0])?.id ?? null;
  return { porSede, general, exp: Date.now() + CACHE_TTL_MS };
}

async function mapa(prisma: DbCentros): Promise<Mapa> {
  if (cache && cache.exp > Date.now()) return cache;
  // Una sola carga aunque lleguen varias peticiones a la vez con la caché vencida.
  if (!cargando) {
    const p = cargarMapa(prisma);
    cargando = p;
    p.then(
      (m) => {
        if (cargando === p) {
          cache = m;
          cargando = null;
        }
      },
      () => {
        if (cargando === p) cargando = null;
      },
    );
  }
  return cargando;
}

// ---------------------------------------------------------------------------------------
// Resolutores
// ---------------------------------------------------------------------------------------

/** Centro de una sede por su `Branch.legacyId`. `0`/null (banco o sin sede) o sede sin centro → null. */
export async function centroDeSede(
  prisma: DbCentros,
  branchLegacyId: number | null | undefined,
): Promise<string | null> {
  if (branchLegacyId == null || !Number.isInteger(branchLegacyId) || branchLegacyId <= 0) return null;
  return (await mapa(prisma)).porSede.get(branchLegacyId) ?? null;
}

/** Centro de «Administración general» (gastos compartidos, D2). Null si no está sembrado o activo. */
export async function centroGeneral(prisma: DbCentros): Promise<string | null> {
  return (await mapa(prisma)).general;
}

/** Centro de la sede del abonado (`Subscriber.branchId`). Abonado inexistente o sin sede → null. */
export async function centroDeAbonado(
  prisma: DbCentros,
  subscriberId: string | null | undefined,
): Promise<string | null> {
  if (!subscriberId) return null;
  const sub = await prisma.subscriber.findUnique({
    where: { id: subscriberId },
    select: { branch: { select: { legacyId: true } } },
  });
  return centroDeSede(prisma, sub?.branch?.legacyId);
}

/**
 * Centro de la sede de una caja, por `CashAccount.legacyId` (lo que guarda
 * `Transaction.cashAccountId`). La caja de BANCO (`branchLegacy = 0`) no tiene sede → null:
 * quien llama decide si eso va a Administración general (ver fase 3 del plan).
 */
export async function centroDeCaja(
  prisma: DbCentros,
  cashAccountLegacyId: number | null | undefined,
): Promise<string | null> {
  if (cashAccountLegacyId == null || !Number.isFinite(cashAccountLegacyId)) return null;
  const caja = await prisma.cashAccount.findUnique({
    where: { legacyId: cashAccountLegacyId },
    select: { branchLegacy: true },
  });
  return centroDeSede(prisma, caja?.branchLegacy);
}

/**
 * Centro de un movimiento de TESORERÍA (ingreso o egreso libre) cuando el usuario no eligió
 * ninguno: la sede de la caja; si la caja es un BANCO (`branchLegacy = 0`), «Administración
 * general» (el banco es de toda la empresa, D2). Sin caja, caja inexistente o caja sin sede
 * (p. ej. la 4 «Mocoa», que hoy trae `branchLegacy` null) → null: null NO es banco.
 */
export async function centroDeTesoreria(
  prisma: DbCentros,
  cashAccountLegacyId: number | null | undefined,
): Promise<string | null> {
  if (cashAccountLegacyId == null || !Number.isFinite(cashAccountLegacyId)) return null;
  const caja = await prisma.cashAccount.findUnique({
    where: { legacyId: cashAccountLegacyId },
    select: { branchLegacy: true },
  });
  if (!caja) return null;
  if (caja.branchLegacy === 0) return centroGeneral(prisma);
  return centroDeSede(prisma, caja.branchLegacy);
}

/**
 * Una bodega de material (`MaterialWarehouse`) o de equipos (`EquipmentWarehouse`), por su
 * `id` (cuid) o por su `legacyId`.
 *
 * El kardex genérico (`Warehouse`, el de `InventoryMovement`) NO tiene sede, así que no se
 * resuelve aquí.
 */
export type BodegaRef =
  | { tipo: 'material' | 'equipos'; id: string; legacyId?: never }
  | { tipo: 'material' | 'equipos'; legacyId: number; id?: never };

/**
 * Centro de la sede de una bodega. Las bodegas de TRÁNSITO del legacy («Clientes»,
 * «Servicios», «Depurados»…) tienen `branchLegacy` null → null.
 */
export async function centroDeBodega(prisma: DbCentros, bodega: BodegaRef): Promise<string | null> {
  const where =
    bodega.id != null ? { id: bodega.id } : bodega.legacyId != null ? { legacyId: bodega.legacyId } : null;
  if (!where) return null;
  const fila =
    bodega.tipo === 'material'
      ? await prisma.materialWarehouse.findUnique({ where, select: { branchLegacy: true } })
      : await prisma.equipmentWarehouse.findUnique({ where, select: { branchLegacy: true } });
  return centroDeSede(prisma, fila?.branchLegacy);
}

/**
 * ¿Existe ese centro y está activo? Para validar el que elige el usuario a mano (sin caché:
 * es una consulta puntual y tiene que ver el estado real).
 */
export async function centroActivo(prisma: DbCentros, costCenterId: string | null | undefined): Promise<boolean> {
  if (!costCenterId) return false;
  const cc = await prisma.costCenter.findUnique({ where: { id: costCenterId }, select: { isActive: true } });
  return !!cc?.isActive;
}

/**
 * Ejecuta un resolutor sin dejar que un fallo tumbe la operación: si lanza, avisa por
 * `console.warn` y devuelve null (el asiento queda «Sin asignar»).
 */
export async function centroSinFallar(
  resolver: () => Promise<string | null>,
  contexto: string,
): Promise<string | null> {
  try {
    return await resolver();
  } catch (e) {
    console.warn(`[centro-costo] no se pudo resolver el centro (${contexto}):`, (e as Error)?.message ?? e);
    return null;
  }
}
