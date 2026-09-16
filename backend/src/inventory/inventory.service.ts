import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { Prisma } from '@prisma/client';
import { Workbook } from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { orden } from '../common/pagination-params';
import { AuthUser } from '../auth/current-user.decorator';
import { CreateMaterialDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto, WarehouseDto } from './dto/inventory.dto';
import { num } from '../common/money';
import { SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';
import { bodegaMaterialDelTecnico, esTecnicoDeCampo, fichaDelUsuario } from '../common/tecnico-scope';
import { cajerasDeSede } from '../common/sede-scope';
import { SignatureOtpService } from '../common/signature/signature-otp.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { NotificationsService } from '../common/notifications/notifications.service';
import { pdfToBuffer } from '../common/pdf/pdf-buffer';
import { actaPdf, ActaPdfData } from '../common/pdf/pdf-docs';
import { anotarBorradoLegacy } from '../common/legacy-deletion';

/**
 * Categoría que la cajera puede entregarle a un técnico. Decisión de negocio
 * (2026-07-30): la cajera mueve consumible y nada más; herramienta, dotación y
 * activos los entrega bodega, que responde por la devolución.
 *
 * Es UN punto de cambio a propósito: si mañana nace otra categoría de consumible,
 * se añade aquí (o se convierte en un check por categoría) y no hay que tocar la
 * lógica del traspaso.
 */
const CONSUMABLE_CATEGORY_TITLES = ['CONSUMIBLES'];

/**
 * Áreas cuyo traspaso NO se restringe: ven todas las bodegas y todo el material.
 * Quien no esté en ninguna (la cajera) queda acotado a los técnicos de su sede y
 * a los consumibles.
 */
const UNRESTRICTED_AREAS = ['area.administracion', 'area.tecnicos'];

/**
 * Parsea el CSV legacy de sedes de `Staff.sedeAccede` ('-3-,-4-'). El '0' del
 * legacy, el vacío y el null significan TODAS, que aquí se representa con `[]`
 * (igual criterio que `User.sedesAccede`).
 */
function parseSedesCsv(csv: string | null | undefined): number[] {
  if (!csv) return [];
  const ids = csv.split(',').map((p) => Number(p.replace(/-/g, '').trim())).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ids)];
}

/** Dos ámbitos de sede se cruzan si comparten alguna, o si alguno es "todas" (`[]`). */
function sedesOverlap(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.includes(x));
}

/**
 * `MaterialWarehouse.technicianRef` es texto libre venido del legacy y trae basura
 * de captura ('OmarTec ', mayúsculas distintas), así que nunca se compara a pelo.
 */
const normalizarRef = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * Índice empleado ← texto de `technicianRef`, por sus DOS llaves posibles: el
 * username (bodegas heredadas del legacy) y el nombre completo (las que se crean
 * aquí, donde el username ya no se teclea). Sin la segunda, un técnico dado de alta
 * en nexus no aparecía como dueño de ninguna bodega.
 */
function indicePorClaves<T extends { name: string; username: string | null }>(staff: T[]): Map<string, T> {
  const idx = new Map<string, T>();
  for (const s of staff) {
    for (const clave of [s.username, s.name]) {
      const k = normalizarRef(clave);
      if (k && !idx.has(k)) idx.set(k, s);
    }
  }
  return idx;
}

export class InventoryService {
  private readonly logger = new Logger('Inventory');

  constructor(
    private readonly prisma: PrismaService,
    private readonly firma: SignatureOtpService,
    private readonly whatsapp: WhatsappService,
    private readonly avisos: NotificationsService,
  ) {}

  /** Resumen de inventario de material. */
  /**
   * Cabecera del inventario. Al técnico de campo se le cuenta SÓLO su bodega: los
   * números de la empresa entera (2.884 materiales, 233 mil millones en existencias)
   * no son suyos que ver, y encima contradecían la tabla de abajo, que sí va acotada.
   */
  async stats(user?: AuthUser) {
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    const bodegaId = soloSuya ? soloSuya.id ?? '—sin-bodega—' : null;
    // Fragmento reutilizado por las dos consultas crudas: comparar dos columnas
    // (`qty <= alert`) y sumar `price*qty` no se puede pedir con el query builder.
    const suyo = bodegaId ? Prisma.sql`AND "warehouseId" = ${bodegaId}` : Prisma.empty;
    const [count, categories, warehouses, lowStock, agg] = await Promise.all([
      this.prisma.material.count({ where: bodegaId ? { warehouseId: bodegaId } : {} }),
      bodegaId
        ? this.prisma.material
            .findMany({ where: { warehouseId: bodegaId, categoryId: { not: null } }, select: { categoryId: true }, distinct: ['categoryId'] })
            .then((r) => r.length)
        : this.prisma.materialCategory.count(),
      bodegaId ? (soloSuya?.id ? 1 : 0) : this.prisma.materialWarehouse.count(),
      this.prisma.$queryRaw<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM "Material" WHERE alert IS NOT NULL AND alert > 0 AND qty <= alert ${suyo}`,
      // Valor físico: excluye "servicios" y filas basura (qty gigante = stock ilimitado del legacy).
      this.prisma.$queryRaw<{ v: number; u: number }[]>`SELECT COALESCE(SUM(price*qty),0)::float AS v, COALESCE(SUM(qty),0)::float AS u FROM "Material" WHERE qty < 100000 ${suyo}`,
    ]);
    return {
      materiales: count, categorias: categories, bodegas: warehouses,
      stockBajo: Number(lowStock[0]?.c ?? 0),
      valorInventario: Number(agg[0]?.v ?? 0), unidades: Number(agg[0]?.u ?? 0),
    };
  }

  /** Sedes para el selector de la bodega (`Branch.legacyId`, que es lo que se guarda). */
  async branches() {
    const rows = await this.prisma.branch.findMany({ orderBy: { legacyId: 'asc' }, select: { legacyId: true, name: true } });
    return rows.filter((b) => b.legacyId != null).map((b) => ({ legacyId: b.legacyId!, name: b.name }));
  }

  async categories() {
    const [rows, vals] = await Promise.all([
      this.prisma.materialCategory.findMany({ orderBy: { title: 'asc' }, include: { _count: { select: { materials: true } } } }),
      // Valor físico por categoría (excluye stock "ilimitado" del legacy, igual que stats).
      this.prisma.$queryRaw<{ id: string; v: number }[]>`SELECT "categoryId" AS id, COALESCE(SUM(price*qty),0)::float AS v FROM "Material" WHERE qty < 100000 AND "categoryId" IS NOT NULL GROUP BY "categoryId"`,
    ]);
    const valueById = new Map(vals.map((x) => [x.id, x.v]));
    return rows.map((c) => ({ id: c.id, title: c.title, extra: c.extra, materials: c._count.materials, value: valueById.get(c.id) ?? 0 }));
  }
  /**
   * Bodegas de material. Un técnico de campo ve SÓLO la suya (2026-07-31): la
   * pantalla es "mi bodega", no el mapa del inventario de la empresa. Sin bodega
   * personal —o sin ficha de empleado— no ve ninguna, que es el lado seguro.
   */
  async warehouses(user?: AuthUser) {
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    const where: Prisma.MaterialWarehouseWhereInput = soloSuya ? { id: soloSuya.id ?? '—sin-bodega—' } : {};
    const [rows, vals, staff] = await Promise.all([
      this.prisma.materialWarehouse.findMany({
        where,
        orderBy: { title: 'asc' },
        include: { _count: { select: { materials: true } }, manager: { select: { id: true, name: true } } },
      }),
      // Valor físico por bodega (excluye stock "ilimitado" del legacy, igual que stats).
      this.prisma.$queryRaw<{ id: string; v: number }[]>`SELECT "warehouseId" AS id, COALESCE(SUM(price*qty),0)::float AS v FROM "Material" WHERE qty < 100000 AND "warehouseId" IS NOT NULL GROUP BY "warehouseId"`,
      this.prisma.staff.findMany({ select: { id: true, name: true, username: true } }),
    ]);
    const valueById = new Map(vals.map((x) => [x.id, x.v]));
    // `technicianRef` es texto (el username del legacy): la pantalla necesita el id
    // del empleado para preseleccionarlo en el desplegable, así que se traduce aquí.
    const staffByRef = indicePorClaves(staff);
    return rows.map((w) => ({
      id: w.id, title: w.title, extra: w.extra, technicianRef: w.technicianRef,
      technicianStaffId: staffByRef.get(normalizarRef(w.technicianRef))?.id ?? null,
      managerId: w.managerId, managerName: w.manager?.name ?? null,
      branchLegacy: w.branchLegacy, isMain: w.isMain,
      materials: w._count.materials, value: valueById.get(w.id) ?? 0,
    }));
  }

  // ── Alcance del técnico de campo ────────────────────────────────────────────

  /**
   * Bodega a la que hay que acotar a este usuario, o `null` si no hay que acotarlo.
   *
   * El `{ id: null }` NO es lo mismo que `null`: significa "es técnico y no tiene
   * bodega personal" (no está vinculado o su almacén no existe), y en ese caso no
   * puede ver el material de nadie más. Los dos casos se distinguen a propósito —
   * confundirlos abriría el inventario entero justo al que menos debe verlo.
   */
  private async bodegaPropiaSiEsTecnico(user?: AuthUser): Promise<{ id: string | null } | null> {
    if (!esTecnicoDeCampo(user)) return null;
    const bodega = await bodegaMaterialDelTecnico(this.prisma, user!);
    return { id: bodega?.id ?? null };
  }

  /** Puerta de las escrituras: el técnico entra a mirar su bodega, no a administrar. */
  private exigirNoSerTecnico(user: AuthUser | undefined, accion: string): void {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException(`No tienes permiso para ${accion}. Tu acceso al inventario es de consulta sobre tu propia bodega.`);
    }
  }

  // ── Devolución del técnico ──────────────────────────────────────────────────

  /**
   * Lo que un técnico de campo puede devolver, y a dónde: de SU bodega personal a la
   * bodega PRINCIPAL de su sede (`MaterialWarehouse.isMain`), que es donde responde
   * la cajera. Pedido del usuario (2026-09-03): al técnico le sobra material de una
   * instalación y hasta ahora no tenía forma de entregarlo — sólo la cajera podía
   * emitir traspasos, así que el sobrante se quedaba en su almacén.
   *
   * Devuelve el `motivo` en vez de lanzar: la pantalla lo dice y no se rompe. Los
   * tres casos que se ven en los datos de hoy son reales — 2 técnicos sin sede
   * asignada, Mocoa sin bodega principal, y un técnico nuevo sin bodega creada.
   */
  private async devolucionDelTecnico(user: AuthUser): Promise<{
    from: { id: string; title: string } | null;
    targets: { id: string; title: string; branchLegacy: number; branchName: string }[];
    motivo: string | null;
  }> {
    const from = await bodegaMaterialDelTecnico(this.prisma, user);
    if (!from) {
      return { from: null, targets: [], motivo: 'No tienes una bodega de material asignada, así que no hay de dónde devolver. Pídele a bodega que te la cree.' };
    }
    const sedes = await this.sedesDelTecnico(user);
    if (!sedes.length) {
      return { from, targets: [], motivo: 'No tienes una sede asignada, así que no se sabe a qué bodega devolver. Pídele a Sistemas que te asigne la sede.' };
    }
    const [bodegas, branches] = await Promise.all([
      this.prisma.materialWarehouse.findMany({
        where: { isMain: true, branchLegacy: { in: sedes } },
        select: { id: true, title: true, branchLegacy: true },
        orderBy: { title: 'asc' },
      }),
      this.prisma.branch.findMany({ select: { legacyId: true, name: true } }),
    ]);
    const nombreSede = new Map(branches.map((b) => [b.legacyId, b.name]));
    const targets = bodegas
      // La bodega principal NO puede ser la suya: devolverse material a sí mismo no
      // es una devolución (y `transfer` rechaza origen = destino).
      .filter((b) => b.id !== from.id)
      .map((b) => ({ id: b.id, title: b.title, branchLegacy: b.branchLegacy!, branchName: nombreSede.get(b.branchLegacy!) ?? `Sede ${b.branchLegacy}` }));
    if (!targets.length) {
      const nombres = sedes.map((n) => nombreSede.get(n) ?? `Sede ${n}`).join(', ');
      return { from, targets: [], motivo: `${nombres} no tiene marcada una bodega principal, que es a donde va la devolución. Se marca en Bodegas de material.` };
    }
    return { from, targets, motivo: null };
  }

  /**
   * Sedes del técnico, por sus dos fuentes. `User.sedesAccede` es la de la sesión;
   * `Staff.sedeAccede` (el CSV legacy '-3-,-4-') es el respaldo, y es la única que
   * traen algunas fichas importadas. Vacío = no consta, y aquí eso significa
   * "ninguna" y no "todas": sin sede no se sabe a qué bodega devolver.
   */
  private async sedesDelTecnico(user: AuthUser): Promise<number[]> {
    const deSesion = (user.sedes ?? []).filter((n) => Number.isFinite(n) && n > 0);
    if (deSesion.length) return [...new Set(deSesion)];
    const fila = await this.prisma.user.findUnique({ where: { id: user.id }, select: { sedesAccede: true } });
    const deCuenta = (fila?.sedesAccede ?? []).filter((n) => Number.isFinite(n) && n > 0);
    if (deCuenta.length) return [...new Set(deCuenta)];
    const ficha = await fichaDelUsuario(this.prisma, user);
    if (!ficha) return [];
    const staff = await this.prisma.staff.findUnique({ where: { id: ficha.id }, select: { sedeAccede: true } });
    return parseSedesCsv(staff?.sedeAccede);
  }

  // ── Contexto del traspaso ───────────────────────────────────────────────────

  /** Sedes del usuario autenticado. `[]` = todas (gerencia/admin y el '0' legacy). */
  private async userSedes(userId: string): Promise<number[]> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { sedesAccede: true } });
    return (u?.sedesAccede ?? []).filter((n) => Number.isFinite(n) && n > 0);
  }

  /** Ids de las categorías que cuentan como consumible (ver CONSUMABLE_CATEGORY_TITLES). */
  private async consumableCategoryIds(): Promise<string[]> {
    const rows = await this.prisma.materialCategory.findMany({
      where: { OR: CONSUMABLE_CATEGORY_TITLES.map((t) => ({ title: { equals: t, mode: 'insensitive' as const } })) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Todo lo que la pantalla de "nuevo traspaso" necesita para pintarse, resuelto
   * en el servidor: qué modos puede usar, qué bodegas y qué técnicos ve, y quién
   * recibe en cada destino. La pantalla NO decide nada de esto; `transfer()`
   * vuelve a validarlo, así que tocar la petición a mano no salta la regla.
   */
  async transferContext(user: AuthUser) {
    const perms = user.permissions ?? [];
    const isSuperadmin = perms.includes(SUPERADMIN_PERMISSION);
    // El técnico de campo tiene su propio contexto: sólo DEVOLVER lo suyo (ver
    // `contextoDevolucion`). Va ANTES de `unrestricted` porque `area.tecnicos` está
    // en la lista de áreas sin restricción —pensada para bodega, que la comparte—, y
    // por ese hueco al técnico se le ofrecían las 61 bodegas y los 35 almacenes de
    // sus compañeros como origen. `resolveTransfer` cierra el hueco por su lado.
    if (esTecnicoDeCampo(user)) return this.contextoDevolucion(user);
    // "Bodega" = administración o técnicos. La cajera no está en ninguna: es la
    // única que queda restringida (decisión 2026-07-30).
    const unrestricted = isSuperadmin || UNRESTRICTED_AREAS.some((a) => perms.includes(a));

    const [warehouses, branches, staff, users, consumableIds, sedesDeCuenta] = await Promise.all([
      this.prisma.materialWarehouse.findMany({
        orderBy: { title: 'asc' },
        include: { _count: { select: { materials: true } }, manager: { select: { id: true, name: true } } },
      }),
      this.prisma.branch.findMany({ orderBy: { legacyId: 'asc' }, select: { legacyId: true, name: true } }),
      // Sin filtrar por username: un empleado dado de alta en nexus puede tener su
      // bodega apuntada por nombre, y filtrando aquí no se le podía entregar nada.
      this.prisma.staff.findMany({ select: { id: true, username: true, name: true, email: true, sedeAccede: true, banned: true } }),
      this.prisma.user.findMany({ where: { isActive: true }, select: { id: true, email: true } }),
      this.consumableCategoryIds(),
      this.userSedes(user.id),
    ]);
    // La sesión ya trae la sede de la caja cuando la cuenta no tiene sedes marcadas
    // (`resolverSedes`); leyendo sólo `sedesAccede`, a esa cajera se le abría todo.
    const mySedes = user.sedes?.length ? user.sedes : sedesDeCuenta;

    const branchName = new Map(branches.map((b) => [b.legacyId, b.name]));
    // `technicianRef` viene del legacy y trae basura de captura (mayúsculas
    // distintas, espacios al final: 'OmarTec '), así que se casa normalizado — y
    // por sus dos llaves posibles, username (legacy) o nombre (altas de nexus).
    const staffByRef = indicePorClaves(staff);
    const userByEmail = new Map(users.map((u) => [(u.email ?? '').trim().toLowerCase(), u.id]));

    const todosLosTecnicos = warehouses
      .filter((w) => w.technicianRef)
      .map((w) => {
        const s = staffByRef.get(normalizarRef(w.technicianRef));
        const sedes = parseSedesCsv(s?.sedeAccede);
        return {
          warehouseId: w.id, warehouseTitle: w.title, technicianRef: w.technicianRef,
          name: s?.name ?? null,
          // Sin empleado que case, no hay a quién designar ni de qué sede es.
          // Pasa en 2 almacenes cuyo `technicianRef` quedó apuntando a un username
          // que ya no existe; se ven, con su aviso, para que los arreglen.
          linked: Boolean(s),
          retired: Boolean(s?.banned),
          userId: s?.email ? userByEmail.get(s.email.trim().toLowerCase()) ?? null : null,
          sedes, sedeNames: sedes.length ? sedes.map((n) => branchName.get(n) ?? `Sede ${n}`) : branches.map((b) => b.name),
          materials: w._count.materials,
        };
      });

    const technicians = todosLosTecnicos
      // A un ex-empleado no se le entrega material: su usuario está desactivado, no
      // puede firmar el acta y ya no trabaja aquí. Son 17 de 35 almacenes (Staff
      // `banned` calza 1-a-1 con `User.isActive=false`). El material que aún tengan
      // se recupera por el modo "entre bodegas", que sí lista todas las bodegas.
      .filter((t) => !t.retired)
      // La cajera sólo ve técnicos de su sede; sin empleado vinculado no se puede
      // saber la sede, así que no se le ofrece.
      .filter((t) => (unrestricted ? true : t.linked && sedesOverlap(mySedes, t.sedes)))
      .sort((a, b) => (a.name ?? a.warehouseTitle).localeCompare(b.name ?? b.warehouseTitle, 'es'));

    // El nombre del dueño va con la bodega: los almacenes de técnico se llaman
    // "Almacen Omar" o "Depurados", y quien traspasa piensa en la persona.
    const mapWarehouse = (w: (typeof warehouses)[number]) => {
      const s = w.technicianRef ? staffByRef.get(normalizarRef(w.technicianRef)) : undefined;
      return {
        id: w.id, title: w.title, extra: w.extra,
        isTechnician: Boolean(w.technicianRef),
        technicianName: s?.name ?? null,
        technicianRetired: Boolean(s?.banned),
        managerId: w.managerId, managerName: w.manager?.name ?? null,
        branchLegacy: w.branchLegacy,
        branchName: w.branchLegacy != null ? branchName.get(w.branchLegacy) ?? `Sede ${w.branchLegacy}` : null,
        materials: w._count.materials,
      };
    };

    // "Entre bodegas" para la cajera (2026-09-11): sólo dentro de SU sede, igual que
    // las transferencias de equipos. Entra a una bodega general de su sede —nunca al
    // almacén de un técnico: eso sería entregarle herramienta por la puerta de atrás
    // de la regla del consumible— y sale de una bodega de su sede o del almacén de un
    // técnico de su sede, retirados incluidos, que es como se recupera su material.
    // Sin sede conocida no ve ninguna (lado seguro, como `network/bodega-scope.ts`).
    const deMiSede = (w: (typeof warehouses)[number]) =>
      mySedes.length > 0 && w.branchLegacy != null && mySedes.includes(w.branchLegacy);
    const tecnicosDeMiSede = new Set(
      todosLosTecnicos.filter((t) => mySedes.length > 0 && t.linked && sedesOverlap(mySedes, t.sedes)).map((t) => t.warehouseId),
    );
    const warehouseTargets = unrestricted ? warehouses : warehouses.filter((w) => !w.technicianRef && deMiSede(w));
    const warehouseOrigins = unrestricted
      ? warehouses
      : warehouses.filter((w) => (w.technicianRef ? tecnicosDeMiSede.has(w.id) : deMiSede(w)));

    return {
      // La cajera no elige libremente quién recibe ni qué mueve.
      restricted: !unrestricted,
      // Qué modos puede usar la pantalla. "Devolver" es sólo del técnico: los demás
      // mueven material entre bodegas por el modo de siempre.
      canTechnicianMode: true,
      canReturnMode: false,
      // "Entre bodegas": bodega/admin sobre todo; la cajera, entre las de su sede.
      canWarehouseMode: unrestricted || warehouseTargets.length > 0,
      // Sólo en el modo "a técnico": lo que se ENTREGA a una persona. Entre bodegas
      // la cajera mueve cualquier material, porque no sale de la custodia de la sede.
      onlyConsumable: !unrestricted,
      consumableCategoryIds: consumableIds,
      mySedes, mySedeNames: mySedes.length ? mySedes.map((n) => branchName.get(n) ?? `Sede ${n}`) : branches.map((b) => b.name),
      // Todas las bodegas (incluidas las de técnico) para el modo entre bodegas:
      // así bodega puede devolver material desde el almacén de un técnico.
      warehouses: warehouses.map(mapWarehouse),
      // Origen del modo "a técnico". A la cajera sólo se le ofrecen las bodegas
      // generales: no saca material del almacén personal de un técnico para
      // dárselo a otro. Bodega/administración sí, porque pasar material de un
      // técnico a otro es cosa de todos los días (y antes obligaba a rodearlo
      // por "entre bodegas", donde el destino se elige por bodega y no por
      // persona). `resolveTransfer` vuelve a exigirlo al emitir.
      originWarehouses: (unrestricted ? warehouses : warehouses.filter((w) => !w.technicianRef)).map(mapWarehouse),
      // Origen y destino del modo "entre bodegas" (ver arriba).
      warehouseOrigins: warehouseOrigins.map(mapWarehouse),
      warehouseTargets: warehouseTargets.map(mapWarehouse),
      technicians,
      // Cuántos almacenes de técnico quedaron fuera por ser de un ex-empleado, y
      // cuánto material siguen guardando: si no se dice, la lista corta parece
      // completa y ese material queda invisible.
      retiredTechnicians: todosLosTecnicos.filter((t) => t.retired).length,
      retiredMaterials: todosLosTecnicos.filter((t) => t.retired).reduce((a, t) => a + t.materials, 0),
    };
  }
  /**
   * El contexto del TÉCNICO: un solo modo, "devolver", y sin nada que elegir salvo
   * el material. El origen es su bodega y el destino la principal de su sede; quien
   * firma el recibido es la cajera de esa sede, no una persona designada.
   *
   * Se devuelven las mismas claves que el contexto general para que la pantalla sea
   * una sola: con las listas vacías, los otros dos modos ni se pintan.
   */
  private async contextoDevolucion(user: AuthUser) {
    const { from, targets, motivo } = await this.devolucionDelTecnico(user);
    // A quién le va a llegar el acta, para decírselo antes de emitirla (y para que
    // se sepa a quién reclamarle). Puede no haber nadie: entonces sólo firma el
    // superusuario, y vale más que se vea de antemano.
    const cajeras = await Promise.all(
      targets.map(async (t) => ({ ...t, receivers: (await cajerasDeSede(this.prisma, t.branchLegacy)).map((c) => c.name) })),
    );
    const bodega = (b: { id: string; title: string }) => ({
      id: b.id, title: b.title, extra: null as string | null,
      isTechnician: false, technicianName: null as string | null, technicianRetired: false,
      managerId: null as string | null, managerName: null as string | null,
      branchLegacy: null as number | null, branchName: null as string | null, materials: 0,
    });
    return {
      restricted: true,
      canTechnicianMode: false,
      canWarehouseMode: false,
      canReturnMode: true,
      // Devuelve TODO lo que le sobre, no sólo consumible: en su almacén hay
      // material de instalación, y el sentido de esto es que no se le quede nada.
      onlyConsumable: false,
      consumableCategoryIds: [] as string[],
      mySedes: [] as number[],
      mySedeNames: [...new Set(cajeras.map((t) => t.branchName))],
      warehouses: [...(from ? [bodega(from)] : []), ...cajeras.map(bodega)],
      originWarehouses: from ? [bodega(from)] : [],
      warehouseOrigins: [] as ReturnType<typeof bodega>[],
      warehouseTargets: [] as ReturnType<typeof bodega>[],
      technicians: [] as never[],
      retiredTechnicians: 0,
      retiredMaterials: 0,
      // Lo propio de la devolución.
      returnFrom: from,
      returnTargets: cajeras,
      returnBlocked: motivo,
    };
  }

  createCategory(dto: SimpleCatalogDto) { return this.prisma.materialCategory.create({ data: { title: dto.title, extra: dto.extra ?? null } }); }
  updateCategory(id: string, dto: SimpleCatalogDto) { return this.prisma.materialCategory.update({ where: { id }, data: { title: dto.title, extra: dto.extra ?? null } }); }
  async deleteCategory(id: string) {
    const count = await this.prisma.material.count({ where: { categoryId: id } });
    if (count > 0) throw new BadRequestException(`No se puede eliminar: la categoría tiene ${count} material(es) asociado(s). Reasígnalos primero.`);
    await this.prisma.materialCategory.delete({ where: { id } });
    return { ok: true };
  }
  async createWarehouse(dto: WarehouseDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'crear bodegas');
    const bodega = await this.prisma.materialWarehouse.create({ data: {
      title: dto.title, extra: dto.extra ?? null, managerId: dto.managerId || null,
      technicianRef: await this.refDelTecnico(dto.technicianStaffId),
      branchLegacy: dto.branchLegacy || null, isMain: dto.isMain ?? false,
    } });
    if (bodega.isMain) await this.dejarUnaSolaPrincipal(bodega.id, bodega.branchLegacy);
    return bodega;
  }
  async updateWarehouse(id: string, dto: WarehouseDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'editar bodegas');
    // `managerId: ''` (o null) desasigna al encargado; no enviarlo lo deja igual.
    const data: Prisma.MaterialWarehouseUpdateInput = { title: dto.title, extra: dto.extra ?? null };
    if (dto.managerId !== undefined) {
      data.manager = dto.managerId ? { connect: { id: dto.managerId } } : { disconnect: true };
    }
    if (dto.technicianStaffId !== undefined) data.technicianRef = await this.refDelTecnico(dto.technicianStaffId);
    if (dto.branchLegacy !== undefined) data.branchLegacy = dto.branchLegacy || null;
    if (dto.isMain !== undefined) data.isMain = dto.isMain;
    const bodega = await this.prisma.materialWarehouse.update({ where: { id }, data });
    if (bodega.isMain) await this.dejarUnaSolaPrincipal(bodega.id, bodega.branchLegacy);
    return bodega;
  }

  /**
   * Una sola bodega principal por sede: al marcar ésta, se desmarca la que lo fuera.
   * No hay índice único en la BD a propósito —la sede puede quedarse sin principal, y
   * eso es válido (Mocoa hoy)—, así que el invariante se mantiene aquí.
   */
  private async dejarUnaSolaPrincipal(id: string, branchLegacy: number | null): Promise<void> {
    if (branchLegacy == null) {
      // Principal "de ninguna sede" no significa nada: sin sede no se puede devolver.
      await this.prisma.materialWarehouse.update({ where: { id }, data: { isMain: false } });
      throw new BadRequestException('Para marcarla como bodega principal, primero dile de qué sede es.');
    }
    await this.prisma.materialWarehouse.updateMany({
      where: { branchLegacy, isMain: true, id: { not: id } },
      data: { isMain: false },
    });
  }

  /**
   * Traduce el empleado elegido en la pantalla al texto que guarda la columna.
   *
   * `technicianRef` es texto libre heredado del legacy, no una llave foránea: allá
   * era el `username` del técnico. Se sigue escribiendo el username cuando existe
   * —así las bodegas creadas aquí se ven igual que las 35 que ya venían— y el nombre
   * completo cuando no, que es la otra llave con la que `tecnico-scope` las casa.
   */
  private async refDelTecnico(staffId?: string): Promise<string | null> {
    if (!staffId) return null; // '' o ausente = bodega general, sin dueño
    const s = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { name: true, username: true } });
    if (!s) throw new NotFoundException('Empleado no encontrado');
    return s.username?.trim() || s.name;
  }
  async deleteWarehouse(id: string, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'eliminar bodegas');
    const count = await this.prisma.material.count({ where: { warehouseId: id } });
    if (count > 0) throw new BadRequestException(`No se puede eliminar: la bodega tiene ${count} material(es). Trasládalos primero.`);
    await this.prisma.materialWarehouse.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Importa materiales desde un Excel. Cabeceras reconocidas (fila 1, insensible a
   * mayúsculas): nombre, codigo, categoria, bodega, precio, costo, iva, cantidad,
   * alerta. Crea la categoría/bodega por título si no existe. Devuelve el resumen.
   */
  async importMaterials(buffer: Buffer) {
    const wb = new Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas.');

    const headers: Record<string, number> = {};
    ws.getRow(1).eachCell((cell, col) => { headers[String(cell.value ?? '').trim().toLowerCase()] = col; });
    const pick = (names: string[]) => { for (const n of names) if (headers[n] != null) return headers[n]; return null; };
    const cName = pick(['nombre', 'name', 'material', 'producto']);
    if (!cName) throw new BadRequestException('Falta la columna "nombre" en la primera fila.');
    const cCode = pick(['codigo', 'código', 'code', 'sku']);
    const cCat = pick(['categoria', 'categoría', 'category']);
    const cWh = pick(['bodega', 'almacen', 'almacén', 'warehouse']);
    const cPrice = pick(['precio', 'price', 'venta']);
    const cCost = pick(['costo', 'cost', 'compra']);
    const cTax = pick(['iva', 'impuesto', 'tax']);
    const cQty = pick(['cantidad', 'qty', 'stock', 'existencia']);
    const cAlert = pick(['alerta', 'minimo', 'mínimo', 'alert']);

    const [cats, whs] = await Promise.all([
      this.prisma.materialCategory.findMany({ select: { id: true, title: true } }),
      this.prisma.materialWarehouse.findMany({ select: { id: true, title: true } }),
    ]);
    const catMap = new Map(cats.map((c) => [c.title.trim().toLowerCase(), c.id]));
    const whMap = new Map(whs.map((w) => [w.title.trim().toLowerCase(), w.id]));

    const str = (row: any, col: number | null) => (col ? String(row.getCell(col).value ?? '').trim() : '');
    const numv = (row: any, col: number | null) => {
      if (!col) return 0;
      const v = row.getCell(col).value;
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };

    let created = 0, skipped = 0;
    const errors: string[] = [];
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const name = str(row, cName);
      if (!name) { skipped++; continue; }
      try {
        let categoryId: string | null = null;
        const catTitle = str(row, cCat);
        if (catTitle) {
          const key = catTitle.toLowerCase();
          categoryId = catMap.get(key) ?? null;
          if (!categoryId) { const c = await this.prisma.materialCategory.create({ data: { title: catTitle } }); categoryId = c.id; catMap.set(key, c.id); }
        }
        let warehouseId: string | null = null;
        const whTitle = str(row, cWh);
        if (whTitle) {
          const key = whTitle.toLowerCase();
          warehouseId = whMap.get(key) ?? null;
          if (!warehouseId) { const w = await this.prisma.materialWarehouse.create({ data: { title: whTitle } }); warehouseId = w.id; whMap.set(key, w.id); }
        }
        await this.prisma.material.create({
          data: {
            name, code: str(row, cCode) || null, categoryId, warehouseId,
            price: numv(row, cPrice), cost: numv(row, cCost), taxRate: numv(row, cTax),
            qty: Math.round(numv(row, cQty)), alert: cAlert ? Math.round(numv(row, cAlert)) : null,
          },
        });
        created++;
      } catch (e) {
        if (errors.length < 12) errors.push(`Fila ${i} (${name}): ${(e as Error).message}`);
        skipped++;
      }
    }
    return { created, skipped, errors };
  }

  /** Listado de material con filtros. */
  /**
   * Columnas ordenables del inventario de materiales.
   *
   * `value` (valor = precio × stock) no está: es una multiplicación y Prisma no
   * la sabe poner en un ORDER BY. Se ordena por precio o por stock.
   */
  private static readonly ORDEN_MATERIALES = {
    name: 'name',
    code: 'code',
    category: 'category.title',
    warehouse: 'warehouse.title',
    price: 'price',
    qty: 'qty',
  };

  async materials(params: { search?: string; categoryId?: string; warehouseId?: string; lowStock?: string; onlyConsumable?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }, user?: AuthUser) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.MaterialWhereInput = {};
    if (params.categoryId) where.categoryId = params.categoryId;
    // Lo que la cajera puede entregarle a un técnico. El filtro de verdad está en
    // `transfer()`; esto es para no ofrecerle en pantalla lo que le van a rechazar.
    if (params.onlyConsumable === '1') where.categoryId = { in: await this.consumableCategoryIds() };
    if (params.warehouseId) where.warehouseId = params.warehouseId;
    // A un técnico se le fija SU bodega, pida la que pida: el `warehouseId` de la
    // query se ignora en vez de servírselo (mismo criterio que `NetworkService.equipment`).
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    if (soloSuya) where.warehouseId = soloSuya.id ?? '—sin-bodega—';
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.material.findMany({ where, orderBy: orden(params, InventoryService.ORDEN_MATERIALES, { name: 'asc' }), skip: (page - 1) * pageSize, take: pageSize, include: { category: true, warehouse: true } }),
      this.prisma.material.count({ where }),
    ]);
    let items = rows.map((m) => ({
      id: m.id, name: m.name, code: m.code, category: m.category?.title ?? null, warehouse: m.warehouse?.title ?? null,
      price: num(m.price), cost: num(m.cost), taxRate: num(m.taxRate), qty: m.qty, alert: m.alert,
      low: m.alert != null && m.alert > 0 && m.qty <= m.alert, value: num(m.price) * m.qty,
    }));
    if (params.lowStock === '1') items = items.filter((i) => i.low);
    return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  async materialDetail(id: string, user?: AuthUser) {
    const m = await this.prisma.material.findUnique({ where: { id }, include: { category: true, warehouse: true } });
    if (!m) throw new NotFoundException('Material no encontrado');
    // La lista ya va acotada; la ficha se abre por URL y necesita su propia puerta.
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    if (soloSuya && m.warehouseId !== soloSuya.id) {
      throw new ForbiddenException('Ese material no está en tu bodega.');
    }
    return {
      id: m.id, name: m.name, code: m.code, description: m.description,
      category: m.category ? { id: m.category.id, title: m.category.title } : null,
      warehouse: m.warehouse ? { id: m.warehouse.id, title: m.warehouse.title } : null,
      price: num(m.price), cost: num(m.cost), taxRate: num(m.taxRate), discRate: num(m.discRate),
      qty: m.qty, alert: m.alert, serviceType: m.serviceType, tvOrNet: m.tvOrNet,
    };
  }

  async createMaterial(dto: CreateMaterialDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'crear material');
    return this.prisma.material.create({
      data: {
        name: dto.name, code: dto.code ?? null, categoryId: dto.categoryId ?? null, warehouseId: dto.warehouseId ?? null,
        price: dto.price ?? 0, cost: dto.cost ?? 0, taxRate: dto.taxRate ?? 0, qty: dto.qty ?? 0, alert: dto.alert ?? null, description: dto.description ?? null,
      },
    });
  }
  async updateMaterial(id: string, dto: UpdateMaterialDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'editar material');
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material no encontrado');
    return this.prisma.material.update({ where: { id }, data: { ...dto, editedAt: new Date() } });
  }
  async deleteMaterial(id: string, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'eliminar material');
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material no encontrado');
    await anotarBorradoLegacy(this.prisma, 'material', m, { label: m.name });
    await this.prisma.material.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Comprueba, contra el contexto del usuario, que este traspaso le está permitido,
   * y devuelve quién recibe. La pantalla ya filtra, pero la frontera es ésta: una
   * cajera que reenvíe la petición a mano choca igual con estas tres reglas.
   */
  private async resolveTransfer(dto: TransferDto, user: AuthUser, materialIds: string[]) {
    // El técnico sólo devuelve: de SU bodega a la principal de su sede, y la firma
    // no es de una persona sino de la cajera de esa sede (cualquiera de ellas).
    if (esTecnicoDeCampo(user)) {
      const { from, targets, motivo } = await this.devolucionDelTecnico(user);
      if (motivo) throw new ForbiddenException(motivo);
      if (dto.fromWarehouseId !== from!.id) throw new ForbiddenException('Sólo puedes devolver material de tu propia bodega.');
      const destino = targets.find((t) => t.id === dto.toWarehouseId);
      if (!destino) throw new ForbiddenException('El material se devuelve a la bodega principal de tu sede, no a otra bodega.');
      return { receiver: { id: null, name: `Cajera de ${destino.branchName}`, branchLegacy: destino.branchLegacy } };
    }

    const ctx = await this.transferContext(user);
    const to = ctx.warehouses.find((w) => w.id === dto.toWarehouseId);
    const from = ctx.warehouses.find((w) => w.id === dto.fromWarehouseId);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');

    if (ctx.restricted) {
      const aTecnico = ctx.technicians.find((t) => t.warehouseId === to.id);
      if (aTecnico) {
        // A técnico: 1) de su sede, 2) desde una bodega general, 3) sólo consumible.
        if (from.isTechnician) throw new ForbiddenException('El material debe salir de una bodega, no del almacén de otro técnico.');
        const noConsumible = await this.prisma.material.findFirst({
          where: { id: { in: materialIds }, OR: [{ categoryId: null }, { categoryId: { notIn: ctx.consumableCategoryIds } }] },
          select: { name: true },
        });
        if (noConsumible) throw new ForbiddenException(`"${noConsumible.name}" no es consumible; ese material lo entrega bodega.`);
      } else {
        // Entre bodegas: origen y destino de su sede (el destino, bodega general).
        if (!ctx.warehouseTargets.some((w) => w.id === to.id)) {
          throw new ForbiddenException('Sólo puedes entregarle material a un técnico de tu sede o moverlo a una bodega de tu sede.');
        }
        if (!ctx.warehouseOrigins.some((w) => w.id === from.id)) {
          throw new ForbiddenException('El material tiene que salir de una bodega de tu sede.');
        }
      }
    }

    // Quien recibe NO lo elige quien emite: en una bodega de técnico es el técnico
    // (dueño de su material) y en una bodega general su encargado. Si el destino no
    // tiene a nadie, el acta queda sin designado y la puede recibir cualquiera con
    // acceso — es el comportamiento que ya había, no un bloqueo nuevo.
    //
    // Excepción: la cajera moviendo a una bodega de su sede SIN encargado (hoy lo son
    // todas). Sin designado nadie se enteraría del acta; la firma, como en la
    // devolución del técnico, cualquier cajera de esa sede.
    const tech = ctx.technicians.find((t) => t.warehouseId === to.id);
    const receiver = to.isTechnician
      ? (tech?.userId ? { id: tech.userId, name: tech.name ?? to.title, branchLegacy: null } : null)
      : to.managerId
        ? { id: to.managerId, name: to.managerName ?? to.title, branchLegacy: null }
        : ctx.restricted && to.branchLegacy != null
          ? { id: null, name: `Cajera de ${to.branchName}`, branchLegacy: to.branchLegacy }
          : null;

    return { receiver };
  }

  /**
   * Emite un traspaso de material entre bodegas (flujo de dos pasos).
   * Descuenta del origen y deja el acta EN TRÁNSITO; el destino se acredita
   * al recibir (ver receiveActa). No mueve stock al destino todavía.
   */
  async transfer(dto: TransferDto, user: AuthUser) {
    if (dto.fromWarehouseId === dto.toWarehouseId) throw new BadRequestException('Bodega origen y destino deben ser distintas');
    if (!dto.items?.length) throw new BadRequestException('Sin ítems a transferir');
    // Consolida ítems repetidos y valida cantidades.
    const byMaterial = new Map<string, number>();
    for (const it of dto.items) {
      const qty = Number(it.qty);
      if (!it.materialId || !Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Cada ítem debe tener una cantidad mayor a 0');
      byMaterial.set(it.materialId, (byMaterial.get(it.materialId) ?? 0) + qty);
    }
    const [from, to, { receiver }] = await Promise.all([
      this.prisma.materialWarehouse.findUnique({ where: { id: dto.fromWarehouseId } }),
      this.prisma.materialWarehouse.findUnique({ where: { id: dto.toWarehouseId } }),
      // Valida permiso y deriva a quien recibe (técnico o encargado de la bodega).
      this.resolveTransfer(dto, user, [...byMaterial.keys()]),
    ]);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');

    return this.prisma.$transaction(async (tx) => {
      const acta = await tx.materialActa.create({
        data: {
          date: new Date(), fromWarehouseLegacy: from.legacyId ?? null, toWarehouseLegacy: to.legacyId ?? null,
          fromWarehouseId: from.id, toWarehouseId: to.id,
          fromWarehouseName: from.title, toWarehouseName: to.title, observations: dto.observations ?? null,
          status: 'En tránsito', itemsCount: byMaterial.size,
          createdByName: user.name,
          assignedToId: receiver?.id ?? null, assignedToName: receiver?.name ?? null,
          // Devolución del técnico: no hay designado, firma la cajera de esa sede.
          assignedBranchLegacy: receiver?.branchLegacy ?? null,
        },
      });
      for (const [materialId, qty] of byMaterial) {
        const src = await tx.material.findUnique({ where: { id: materialId } });
        if (!src || src.warehouseId !== dto.fromWarehouseId) throw new BadRequestException('El material no está en la bodega origen');
        if (qty > src.qty) throw new BadRequestException(`Stock insuficiente de ${src.name} (${src.qty} disponibles)`);
        // Solo resta del origen; el destino se acredita al recibir.
        await tx.material.update({ where: { id: src.id }, data: { qty: src.qty - qty, editedAt: new Date() } });
        await tx.materialActaItem.create({ data: { actaId: acta.id, materialId: src.id, qty } });
      }
      return { actaId: acta.id, items: byMaterial.size, status: 'En tránsito' };
    }).then(async (r) => {
      // El acta sale sola hacia quien la tiene que firmar. Fuera de la transacción
      // a propósito: armar el PDF y hablar con Meta tarda, y no se va a tener el
      // stock bloqueado esperando a WhatsApp. Que el envío falle NO invalida el
      // traspaso —el material ya salió de la bodega—, solo queda sin avisar y se
      // devuelve el porqué para que la pantalla lo diga.
      const envio = await this.enviarActa(r.actaId).catch((e) => {
        this.logger.warn(`No se pudo enviar el acta ${r.actaId}: ${(e as Error).message}`);
        return { enviado: false as const, motivo: 'Error al enviar el acta.' };
      });
      return { ...r, envio };
    });
  }

  // ── El acta: PDF, envío automático y firma de quien recibe ─────────────────

  /** Datos del acta para el PDF (mismo render que se descarga y que se manda). */
  async actaPdfData(id: string): Promise<ActaPdfData & { assignedToId: string | null; assignedBranchLegacy: number | null }> {
    const a = await this.prisma.materialActa.findUnique({
      where: { id },
      include: { items: { include: { material: true } } },
    });
    if (!a) throw new NotFoundException('Acta no encontrada');
    return {
      titulo: 'Acta de traspaso de material',
      // El id es un cuid: se muestran los últimos 6 en mayúsculas, que es lo que
      // alguien puede leer por teléfono sin equivocarse.
      numero: (a.legacyId ? String(a.legacyId) : a.id.slice(-6).toUpperCase()),
      date: a.date,
      status: a.status,
      from: a.fromWarehouseName ?? '—',
      to: a.toWarehouseName ?? '—',
      observations: a.observations,
      columnaDerecha: 'Cantidad',
      items: a.items.map((it) => ({
        descripcion: it.material?.name ?? `#${it.materialLegacy}`,
        detalle: it.material?.code ?? null,
        cantidad: String(it.qty),
      })),
      entrega: { nombre: a.createdByName, fecha: a.date },
      recibe: { nombre: a.receivedByName, fecha: a.receivedAt, nota: a.receivedSignature },
      assignedToId: a.assignedToId,
      assignedBranchLegacy: a.assignedBranchLegacy,
    };
  }

  /**
   * Le manda el acta en PDF, por WhatsApp, a quien tiene que firmarla.
   *
   * Sin designado no hay a quién mandársela (actas viejas o bodegas sin encargado):
   * no es un error, es que ese traspaso lo recibe cualquiera con acceso.
   */
  private async enviarActa(id: string): Promise<{ enviado: boolean; motivo?: string; a?: string | null }> {
    const data = await this.actaPdfData(id);
    const destinatarios = await this.quienFirma(data.assignedToId, data.assignedBranchLegacy);
    if (!destinatarios.length) {
      return {
        enviado: false,
        motivo: data.assignedBranchLegacy
          // Devolución a una sede sin cajera asignada: el acta existe y el material
          // ya salió, pero no hay quién la firme salvo el superusuario. Decirlo.
          ? 'Ninguna cajera tiene asignada esa sede, así que no hay quién reciba el material (sólo el superusuario puede firmarlo en su lugar).'
          : 'La bodega destino no tiene encargado, así que no hay a quién mandarle el acta.',
      };
    }

    // La campanita ANTES del WhatsApp, y pase lo que pase con él: el aviso que de
    // verdad no puede fallar es el de dentro del sistema. Con la ventana de 24 h de
    // Meta cerrada —que es lo normal con un técnico que no le escribe al bot— el PDF
    // se cae con un 422 y hasta ahora eso dejaba al designado sin enterarse de nada.
    await this.avisos.notify(destinatarios.map((d) => d.id), {
      kind: 'inventario.acta',
      title: `Material por recibir: ${data.items.length} ítem(s)`,
      body: `${data.from} te envió material a ${data.to}. Ábrelo para revisarlo y firmar el recibido.`,
      link: `/inventario/actas/${id}`,
      groupKey: `acta:${id}`,
    });

    const pdf = await pdfToBuffer((res) => actaPdf(res, data));
    const caption =
      `Traspaso de ${data.from} a ${data.to}: ${data.items.length} ítem(s). ` +
      `Para firmar el recibido entra al sistema (Inventario ▸ Actas) y pide tu código.`;

    // Con designado es uno; en la devolución del técnico son todas las cajeras de la
    // sede y firma la que esté (mismo criterio que las transferencias de equipos).
    let ultimo: string | null = null;
    let enviadas = 0;
    const sinCelular: string[] = [];
    for (const d of destinatarios) {
      const { phone } = await this.firma.telefono(d.id);
      if (!phone) { sinCelular.push(d.name); continue; }
      if (await this.whatsapp.sendDocument(phone, pdf, `acta-traspaso-${data.numero}.pdf`, caption)) {
        enviadas++;
        ultimo = phone;
      }
    }
    if (!enviadas) {
      const quien = sinCelular.length === destinatarios.length
        ? `${destinatarios.map((d) => d.name).join(', ')} no tiene(n) celular registrado`
        : 'WhatsApp no pudo entregar el acta en este momento';
      return { enviado: false, motivo: `${quien}; el aviso ya le(s) quedó en el sistema y el acta está en Inventario ▸ Actas.` };
    }
    await this.prisma.materialActa.update({
      where: { id },
      data: { notifiedAt: new Date(), notifiedTo: ultimo },
    });
    this.logger.log(`Acta ${data.numero} enviada a ${enviadas}/${destinatarios.length} destinatario(s) (${destinatarios.map((d) => d.name).join(', ')}).`);
    return { enviado: true, a: SignatureOtpService.mask(ultimo) };
  }

  /**
   * Quién puede firmar el recibido de un acta: la persona designada, o —cuando el
   * acta va a una sede y no a una persona (devolución del técnico)— las cajeras de
   * esa sede, cualquiera de ellas. Una lista vacía significa que sólo queda el
   * superusuario, y se dice en pantalla.
   */
  private async quienFirma(assignedToId: string | null, branchLegacy: number | null): Promise<{ id: string; name: string }[]> {
    if (assignedToId) {
      const u = await this.prisma.user.findUnique({ where: { id: assignedToId }, select: { id: true, name: true } });
      return u ? [u] : [];
    }
    if (branchLegacy != null) return cajerasDeSede(this.prisma, branchLegacy);
    return [];
  }

  /** Reenvía el acta a quien la tiene que firmar (botón de la pantalla). */
  async reenviarActa(id: string, user: AuthUser) {
    const a = await this.prisma.materialActa.findUnique({ where: { id }, select: { status: true, toWarehouseId: true, assignedToId: true, assignedBranchLegacy: true } });
    if (!a) throw new NotFoundException('Acta no encontrada');
    if (a.status === 'Recibida') throw new BadRequestException('El acta ya fue recibida y firmada.');
    await this.assertCanReceive({ ...a, status: a.status }, user, { permitirEmisor: true });
    return this.enviarActa(id);
  }

  /** Manda al WhatsApp de quien recibe el código para firmar el acta. */
  async pedirCodigoActa(id: string, user: AuthUser) {
    const a = await this.prisma.materialActa.findUnique({
      where: { id },
      select: { status: true, toWarehouseId: true, assignedToId: true, assignedBranchLegacy: true, fromWarehouseName: true, toWarehouseName: true, itemsCount: true },
    });
    if (!a) throw new NotFoundException('Acta no encontrada');
    await this.assertCanReceive(a, user);
    return this.firma.pedir({
      userId: user.id,
      purpose: 'material.receive',
      targetId: id,
      detalle: `el recibido de ${a.itemsCount} ítem(s) de material que ${a.fromWarehouseName ?? 'otra bodega'} le manda a ${a.toWarehouseName ?? 'su bodega'}`,
    });
  }

  /** Actas de traspaso (con filtros de búsqueda y estado). */
  /** Columnas ordenables de la tabla de actas de traspaso. */
  private static readonly ORDEN_ACTAS = {
    date: 'date', from: 'fromWarehouseName', to: 'toWarehouseName',
    obs: 'observations', status: 'status',
    items: (dir: 'asc' | 'desc') => ({ items: { _count: dir } }),
  };

  /**
   * Actas que le conciernen a quien mira: al técnico de campo, sólo las de SU
   * almacén (o las que le designaron a él). Sin esto, abrirle la pantalla —que es
   * la única forma que tiene de firmar un recibido— le enseñaba los traspasos de
   * toda la empresa.
   */
  private async filtroActasDelTecnico(user?: AuthUser): Promise<Prisma.MaterialActaWhereInput | null> {
    if (!esTecnicoDeCampo(user)) return null;
    const bodega = await bodegaMaterialDelTecnico(this.prisma, user!);
    // Sin bodega no hay nada suyo: se le devuelve vacío, que es el lado seguro.
    if (!bodega) return { id: { in: [] } };
    return { OR: [{ toWarehouseId: bodega.id }, { fromWarehouseId: bodega.id }, { assignedToId: user!.id }] };
  }

  async actas(params: { page?: number; pageSize?: number; search?: string; status?: string; sortBy?: string; sortDir?: string }, user?: AuthUser) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const and: Prisma.MaterialActaWhereInput[] = [];
    const suyas = await this.filtroActasDelTecnico(user);
    if (suyas) and.push(suyas);
    const q = params.search?.trim();
    if (q) {
      const ins = { contains: q, mode: 'insensitive' as const };
      and.push({ OR: [{ fromWarehouseName: ins }, { toWarehouseName: ins }, { observations: ins }, { createdByName: ins }, { receivedByName: ins }] });
    }
    if (params.status?.trim()) and.push({ status: params.status.trim() });
    const where: Prisma.MaterialActaWhereInput = and.length ? { AND: and } : {};
    const [rows, total] = await Promise.all([
      this.prisma.materialActa.findMany({ where, orderBy: orden(params, InventoryService.ORDEN_ACTAS, { date: 'desc' }), skip: (page - 1) * pageSize, take: pageSize, include: { items: { select: { qty: true } } } }),
      this.prisma.materialActa.count({ where }),
    ]);
    return {
      items: rows.map((a) => ({
        id: a.id, date: a.date, from: a.fromWarehouseName, to: a.toWarehouseName, observations: a.observations, status: a.status,
        items: a.items.length, units: a.items.reduce((s, it) => s + it.qty, 0),
        createdBy: a.createdByName, assignedTo: a.assignedToName, receivedBy: a.receivedByName, receivedAt: a.receivedAt,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
  async actaDetail(id: string, user?: AuthUser) {
    const [a, firmaCfg] = await Promise.all([
      this.prisma.materialActa.findUnique({ where: { id }, include: { items: { include: { material: true } } } }),
      this.firma.config(),
    ]);
    if (!a) throw new NotFoundException('Acta no encontrada');
    // Mismo alcance que el listado: el técnico no llega a un acta ajena escribiendo
    // el id en la barra de direcciones.
    if (esTecnicoDeCampo(user)) {
      const bodega = await bodegaMaterialDelTecnico(this.prisma, user!);
      const suya = a.assignedToId === user!.id || (!!bodega && (a.toWarehouseId === bodega.id || a.fromWarehouseId === bodega.id));
      if (!suya) throw new ForbiddenException('Esa acta no es de tu almacén.');
    }
    const receivedCount = a.items.filter((it) => it.received).length;
    return {
      id: a.id, date: a.date, from: a.fromWarehouseName, to: a.toWarehouseName, observations: a.observations, status: a.status,
      createdBy: a.createdByName, assignedTo: a.assignedToName, assignedToId: a.assignedToId,
      receivedBy: a.receivedByName, receivedAt: a.receivedAt, createdAt: a.createdAt,
      // Cómo firmó quien recibió, y si se le alcanzó a mandar el acta por WhatsApp.
      receivedSignature: a.receivedSignature,
      notifiedAt: a.notifiedAt, notifiedTo: SignatureOtpService.mask(a.notifiedTo),
      units: a.items.reduce((s, it) => s + it.qty, 0),
      receivedCount, itemsTotal: a.items.length,
      // ¿El recibido va con código? Lo manda `signature.otpRequired`. Viaja al
      // frontend para que la pantalla sepa si abrir el diálogo de firma o recibir
      // de una: preguntárselo aparte era un viaje más, y adivinarlo, un diálogo
      // que pide un código que nadie va a comprobar.
      otpRequired: firmaCfg.required,
      // Todo marcado pero sin firmar: lo único que falta es cerrarla.
      faltaFirma: !!a.toWarehouseId && a.status !== 'Recibida' && receivedCount === a.items.length && a.items.length > 0,
      // Flujo nuevo (en tránsito) y, si hay designado, solo él puede recibir.
      receivable: !!a.toWarehouseId && a.status !== 'Recibida',
      isReceiver: !!a.toWarehouseId && a.status !== 'Recibida' && (await this.puedeFirmar(a, user)),
      // Devolución del técnico: la firma la cajera de esta sede, no una persona.
      assignedBranch: a.assignedBranchLegacy != null
        ? (await this.prisma.branch.findFirst({ where: { legacyId: a.assignedBranchLegacy }, select: { name: true } }))?.name ?? null
        : null,
      items: a.items.map((it) => ({
        id: it.id, material: it.material?.name ?? `#${it.materialLegacy}`, code: it.material?.code ?? null,
        qty: it.qty, price: num(it.material?.price ?? 0), value: num(it.material?.price ?? 0) * it.qty,
        received: it.received, receivedAt: it.receivedAt,
      })),
    };
  }

  /**
   * ¿Este usuario es quien firma el recibido? Es la misma regla que aplica
   * `assertCanReceive` —la puerta de verdad—, pero en forma de pregunta: la pantalla
   * la usa para pintar (o no) el botón de firmar. Si divergen, lo que manda es la otra.
   */
  private async puedeFirmar(
    a: { assignedToId: string | null; assignedBranchLegacy: number | null },
    user?: AuthUser,
  ): Promise<boolean> {
    if (user?.permissions?.includes(SUPERADMIN_PERMISSION)) return true;
    if (a.assignedToId) return a.assignedToId === user?.id;
    if (a.assignedBranchLegacy != null) {
      const cajeras = await cajerasDeSede(this.prisma, a.assignedBranchLegacy);
      return cajeras.some((c) => c.id === user?.id);
    }
    // Acta sin designado (las viejas): la recibe cualquiera con acceso.
    return true;
  }

  /** Acredita un ítem en la bodega destino (busca/crea material por nombre). */
  private async creditItem(tx: Prisma.TransactionClient, warehouseId: string, src: { name: string; code: string | null; categoryId: string | null; price: Prisma.Decimal; cost: Prisma.Decimal; taxRate: Prisma.Decimal; discRate: Prisma.Decimal; alert: number | null; description: string | null }, qty: number) {
    const dst = await tx.material.findFirst({ where: { name: src.name, warehouseId } });
    if (dst) {
      await tx.material.update({ where: { id: dst.id }, data: { qty: dst.qty + qty, editedAt: new Date() } });
    } else {
      await tx.material.create({ data: {
        name: src.name, code: src.code, categoryId: src.categoryId, warehouseId,
        price: src.price, cost: src.cost, taxRate: src.taxRate, discRate: src.discRate, qty, alert: src.alert, description: src.description,
      } });
    }
  }

  /**
   * Verifica que el usuario pueda recibir el acta (flujo nuevo + designado).
   *
   * El designado ya no lo escoge quien emite: sale del destino (el técnico, o el
   * encargado de la bodega). Como ahora casi toda acta lleva designado, el
   * superadministrador puede firmar en su lugar; si no, un técnico de vacaciones
   * dejaría el material colgado en tránsito sin forma de acreditarlo.
   */
  private async assertCanReceive(
    a: { status: string; toWarehouseId: string | null; assignedToId: string | null; assignedBranchLegacy: number | null },
    user: AuthUser,
    opts: { permitirEmisor?: boolean } = {},
  ): Promise<void> {
    if (a.status === 'Recibida') throw new BadRequestException('El acta ya fue recibida');
    if (user.permissions?.includes(SUPERADMIN_PERMISSION)) return;
    // Reenviar el acta sí lo puede hacer quien la emitió (es su papel, y es quien
    // se entera de que al otro no le llegó); firmarla no.
    if (opts.permitirEmisor) return;
    if (a.assignedToId) {
      if (a.assignedToId !== user.id) throw new ForbiddenException('Solo la persona designada puede recibir este traspaso');
      return;
    }
    // Devolución del técnico: no hay designado, responde la CAJERA de esa sede
    // (cualquiera de ellas, como en las transferencias de equipos entre sedes).
    if (a.assignedBranchLegacy != null) {
      const cajeras = await cajerasDeSede(this.prisma, a.assignedBranchLegacy);
      if (!cajeras.some((c) => c.id === user.id)) {
        throw new ForbiddenException('Este traspaso lo recibe la cajera de esa sede.');
      }
    }
  }

  /**
   * Recibe UN ítem del acta (checklist): acredita ese ítem en el destino y lo
   * marca recibido. Cuando todos los ítems quedan recibidos, cierra el acta.
   * Solo el usuario designado (si lo hay) puede recibir.
   */
  async receiveActaItem(actaId: string, itemId: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.materialActa.findUnique({ where: { id: actaId }, include: { items: { include: { material: true } } } });
      if (!a) throw new NotFoundException('Acta no encontrada');
      if (!a.toWarehouseId) throw new BadRequestException('Esta acta no admite recepción por ítem');
      await this.assertCanReceive(a, user);
      const item = a.items.find((it) => it.id === itemId);
      if (!item) throw new NotFoundException('Ítem no encontrado');
      if (item.received) throw new BadRequestException('Ese ítem ya fue recibido');

      if (item.material) await this.creditItem(tx, a.toWarehouseId, item.material, item.qty);
      await tx.materialActaItem.update({ where: { id: item.id }, data: { received: true, receivedAt: new Date() } });

      const remaining = a.items.filter((it) => it.id !== item.id && !it.received).length;
      // Marcar el último ítem YA NO cierra el acta: cerrarla es firmarla, y eso va
      // con código (ver `receiveActa`). Si no, el checklist sería la puerta de atrás
      // para cerrar un acta sin firma. El acta queda con todo recibido y esperando
      // la firma; la pantalla lo dice así.
      const todoRecibido = remaining === 0;
      return {
        id: actaId, itemId, received: true, status: a.status,
        receivedCount: a.items.filter((it) => it.received).length + 1,
        itemsTotal: a.items.length,
        faltaFirma: todoRecibido,
      };
    });
  }

  /**
   * Recibe y FIRMA el acta completa: acredita lo que falte en la bodega destino y
   * la cierra con la firma de quien recibe.
   *
   * La firma es un código de un solo uso que le llegó a su WhatsApp
   * (`signature.otpRequired`; el mismo mecanismo de las órdenes de compra). Se
   * consume ANTES de abrir la transacción —verificarlo cuesta un scrypt y no se va
   * a tener el stock bloqueado mientras tanto—; si la recepción falla justo después,
   * el código queda quemado y se pide otro.
   *
   * Las actas del flujo antiguo (sin `toWarehouseId`) solo se sellan, y sin código:
   * no tienen designado ni acreditan stock, son historia importada.
   */
  async receiveActa(id: string, user: AuthUser, code?: string) {
    const previa = await this.prisma.materialActa.findUnique({
      where: { id },
      select: { status: true, toWarehouseId: true, assignedToId: true, assignedBranchLegacy: true },
    });
    if (!previa) throw new NotFoundException('Acta no encontrada');
    await this.assertCanReceive(previa, user);

    const { required } = await this.firma.config();
    const exigeFirma = required && !!previa.toWarehouseId;
    if (exigeFirma && !code) {
      throw new BadRequestException('Este recibido va firmado: pide tu código y escríbelo para confirmar.');
    }
    const firma = exigeFirma
      ? await this.firma.firmar({ userId: user.id, purpose: 'material.receive', targetId: id, code: code ?? '' })
      : null;

    return this.prisma.$transaction(async (tx) => {
      const a = await tx.materialActa.findUnique({ where: { id }, include: { items: { include: { material: true } } } });
      if (!a) throw new NotFoundException('Acta no encontrada');
      await this.assertCanReceive(a, user);

      // Acredita el destino solo para actas del flujo nuevo, ítems no recibidos aún.
      if (a.toWarehouseId) {
        for (const it of a.items) {
          if (it.received || !it.material) continue;
          await this.creditItem(tx, a.toWarehouseId, it.material, it.qty);
          await tx.materialActaItem.update({ where: { id: it.id }, data: { received: true, receivedAt: new Date() } });
        }
      }

      await tx.materialActa.update({
        where: { id },
        data: {
          status: 'Recibida', receivedAt: new Date(), receivedByName: user.name, receivedById: user.id,
          receivedSignature: firma ? SignatureOtpService.rastro(firma) : null,
        },
      });
      return { id, status: 'Recibida', firmada: !!firma };
    });
  }
}
