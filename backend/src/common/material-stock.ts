import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { bodegaMaterialDelTecnico, esTecnicoDeCampo } from './tecnico-scope';

/** Fila del buscador de material: lo que necesita el selector de un modal. */
export type MaterialConStock = {
  id: string;
  name: string;
  code: string | null;
  price: number;
  qty: number;
  categoryId: string | null;
  category: string | null;
  warehouseId: string | null;
  warehouse: string | null;
  /** Está por debajo del mínimo de la ficha: el selector lo avisa antes de gastarlo. */
  low: boolean;
};

/** Bodega como la ve el selector: un estante con cuánto hay dentro. */
export type BodegaConMaterial = {
  id: string;
  title: string;
  extra: string | null;
  manager: string | null;
  /** Referencias distintas con stock. */
  items: number;
  /** Unidades sumadas. */
  units: number;
  /** Valor del contenido (excluye el stock "ilimitado" del legacy, igual que inventario). */
  value: number;
  isMain: boolean;
  /** Es la bodega personal de un técnico (`technicianRef`), no un almacén general. */
  personal: boolean;
  /** Es la bodega personal del usuario que pregunta (el técnico entra directo a ella). */
  mine: boolean;
};

/** Filtros del selector. `search` suelto se acepta por comodidad de las llamadas viejas. */
export type FiltroMaterial = {
  search?: string;
  warehouseId?: string;
  categoryId?: string;
  page?: number | string;
  pageSize?: number | string;
};

export type PaginaMaterial = {
  rows: MaterialConStock[];
  total: number;
  page: number;
  pageSize: number;
  /** Categorías presentes en lo que se está mirando: los chips del filtro. */
  categories: { id: string; title: string; count: number }[];
};

/** El stock "ilimitado" heredado del legacy (99.999+) no es plata: no se valora. */
const STOCK_ILIMITADO = 100000;

const entero = (v: unknown, porDefecto: number, tope: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, tope) : porDefecto;
};

/**
 * Bodega a la que hay que acotar al usuario, o `undefined` si ve todas.
 *
 * Devuelve la cadena vacía cuando es técnico de campo SIN bodega: es un id que no
 * existe, así que no ve el material de nadie. Es el lado seguro (ver `warehouses()`
 * de inventario, que distingue los mismos tres casos).
 */
async function bodegaDelTecnico(prisma: PrismaService, user: AuthUser): Promise<string | undefined> {
  if (!esTecnicoDeCampo(user)) return undefined;
  const suya = await bodegaMaterialDelTecnico(prisma, user);
  return suya?.id ?? '';
}

/**
 * Bodegas con material disponible, para entrar a ellas y ver qué hay.
 *
 * El selector de material era una caja de texto a ciegas: había que saber de
 * memoria el nombre de lo que se busca. Con esto se entra por el estante —"¿qué
 * tengo en la bodega de Mocoa?"— que es como se piensa el inventario en la calle.
 *
 * Sólo salen las que tienen algo: una bodega vacía es una tarjeta que no se puede
 * abrir. El técnico de campo ve la suya y ninguna más (misma regla que el resto).
 */
export async function bodegasConMaterial(
  prisma: PrismaService,
  user: AuthUser,
  search?: string,
): Promise<BodegaConMaterial[]> {
  const acotada = await bodegaDelTecnico(prisma, user);
  if (acotada === '') return [];

  const where: Prisma.MaterialWhereInput = { qty: { gt: 0 }, warehouseId: { not: null } };
  if (acotada) where.warehouseId = acotada;

  const [grupos, valores] = await Promise.all([
    prisma.material.groupBy({ by: ['warehouseId'], where, _count: { _all: true }, _sum: { qty: true } }),
    prisma.$queryRaw<{ id: string; v: number }[]>`
      SELECT "warehouseId" AS id, COALESCE(SUM(price*qty),0)::float AS v
      FROM "Material"
      WHERE qty > 0 AND qty < ${STOCK_ILIMITADO} AND "warehouseId" IS NOT NULL
      GROUP BY "warehouseId"`,
  ]);
  const ids = grupos.map((g) => g.warehouseId!).filter(Boolean);
  if (!ids.length) return [];
  // "Tu bodega" no es sólo cosa del técnico de campo: a quien entra con un rol de
  // mando (ve todas) y además tiene almacén propio, esa bodega le quedaba escondida
  // entre las "personales" y el material que acababa de recibir no aparecía.
  const propia = acotada ?? (await bodegaMaterialDelTecnico(prisma, user))?.id;

  const s = search?.trim();
  const bodegas = await prisma.materialWarehouse.findMany({
    where: {
      id: { in: ids },
      ...(s ? { OR: [{ title: { contains: s, mode: 'insensitive' } }, { extra: { contains: s, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { title: 'asc' },
    select: { id: true, title: true, extra: true, isMain: true, technicianRef: true, manager: { select: { name: true } } },
  });

  const porId = new Map(grupos.map((g) => [g.warehouseId!, g]));
  const valorPorId = new Map(valores.map((v) => [v.id, v.v]));
  return bodegas
    .map((w) => ({
      id: w.id,
      title: w.title,
      extra: w.extra,
      manager: w.manager?.name ?? null,
      items: porId.get(w.id)?._count._all ?? 0,
      units: porId.get(w.id)?._sum.qty ?? 0,
      value: valorPorId.get(w.id) ?? 0,
      isMain: w.isMain,
      personal: Boolean(w.technicianRef),
      mine: propia === w.id,
    }))
    // Son 57 bodegas y 35 de ellas son el almacén personal de un técnico: quien
    // carga material a una obra busca el almacén de la sede, no el de Miguel.
    // Orden: la tuya, la principal de sede, los almacenes generales y, al final,
    // las personales (que la pantalla además esconde tras un botón).
    .sort((a, b) => {
      const peso = (w: typeof a) => (w.mine ? 0 : w.isMain ? 1 : w.personal ? 3 : 2);
      return peso(a) - peso(b) || a.title.localeCompare(b.title, 'es');
    });
}

/**
 * Materiales con stock para los selectores de consumo (orden de soporte, proyecto).
 *
 * El técnico de campo gasta de SU bodega y de ninguna otra (misma regla que
 * /inventario/bodegas, ver `tecnico-scope.ts`). Sin esto el buscador le ofrecía el
 * material de las 35 bodegas personales y el de los almacenes generales, y el
 * consumo se lo descontaba a su dueño sin preguntar. Si no tiene bodega asignada
 * no puede consumir nada: mejor una lista vacía que gastar del almacén de otro.
 *
 * Vive aquí, y no en el servicio de soporte, porque la puerta de escritura de cada
 * módulo repite esta misma acotación y tienen que decir lo mismo.
 *
 * Devuelve página + las categorías de lo que se está mirando (los chips del
 * filtro): con 30 filas sueltas no se podía recorrer una bodega entera.
 */
export async function buscarMaterialConStock(
  prisma: PrismaService,
  user: AuthUser,
  filtro: FiltroMaterial | string = {},
): Promise<PaginaMaterial> {
  const f: FiltroMaterial = typeof filtro === 'string' ? { search: filtro } : (filtro ?? {});
  const page = entero(f.page, 1, 10000);
  const pageSize = entero(f.pageSize, 30, 100);
  const vacia: PaginaMaterial = { rows: [], total: 0, page, pageSize, categories: [] };

  const acotada = await bodegaDelTecnico(prisma, user);
  if (acotada === '') return vacia;

  const where: Prisma.MaterialWhereInput = { qty: { gt: 0 } };
  const bodega = acotada ?? (f.warehouseId?.trim() || undefined);
  if (bodega) where.warehouseId = bodega;
  const s = f.search?.trim();
  if (s) where.OR = [{ name: { contains: s, mode: 'insensitive' } }, { code: { contains: s, mode: 'insensitive' } }];

  // Los chips salen de TODO lo que hay en la bodega buscada, sin la categoría ya
  // elegida: si no, al pulsar una categoría desaparecerían las demás.
  const conCategoria: Prisma.MaterialWhereInput = { ...where };
  if (f.categoryId?.trim()) where.categoryId = f.categoryId.trim();

  const [total, rows, grupos] = await Promise.all([
    prisma.material.count({ where }),
    prisma.material.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, name: true, code: true, price: true, qty: true, alert: true,
        categoryId: true, category: { select: { title: true } },
        warehouseId: true, warehouse: { select: { title: true } },
      },
    }),
    prisma.material.groupBy({ by: ['categoryId'], where: conCategoria, _count: { _all: true } }),
  ]);

  const catIds = grupos.map((g) => g.categoryId).filter((x): x is string => Boolean(x));
  const cats = catIds.length
    ? await prisma.materialCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, title: true } })
    : [];
  const tituloCat = new Map(cats.map((c) => [c.id, c.title]));

  return {
    total,
    page,
    pageSize,
    rows: rows.map((m) => ({
      id: m.id, name: m.name, code: m.code, price: Number(m.price), qty: m.qty,
      categoryId: m.categoryId, category: m.category?.title ?? null,
      warehouseId: m.warehouseId, warehouse: m.warehouse?.title ?? null,
      low: m.alert != null && m.qty <= m.alert,
    })),
    categories: grupos
      .filter((g) => g.categoryId && tituloCat.has(g.categoryId))
      .map((g) => ({ id: g.categoryId!, title: tituloCat.get(g.categoryId!)!, count: g._count._all }))
      .sort((a, b) => a.title.localeCompare(b.title, 'es')),
  };
}

/**
 * La respuesta del buscador, tolerante con el cliente que no ha recargado.
 *
 * El 8/9/2026 el endpoint dejó de devolver un ARRAY y pasó a devolver una página
 * (`{rows,total,…}`). El navegador que siga con el bundle anterior —el móvil del
 * técnico que lleva la app abierta desde ayer— mete la respuesta por `listaJson()`,
 * que descarta lo que no sea un array y devuelve `[]`: el selector se queda VACÍO y
 * sin un solo error a la vista, que es exactamente "tengo fibra drop en el almacén y
 * la orden no me muestra nada".
 *
 * El cliente nuevo manda SIEMPRE `page`; cuando no viene, se responde como antes.
 * Se puede quitar cuando no queden móviles con el bundle viejo.
 */
export function respuestaMaterial(
  pagina: PaginaMaterial,
  page?: string,
): PaginaMaterial | MaterialConStock[] {
  return page === undefined ? pagina.rows : pagina;
}
