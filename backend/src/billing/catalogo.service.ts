import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { num } from '../common/money';
import { MOTIVOS_FACTURA } from './motivos-factura';

/** Origen del ítem: catálogo de planes (precio vigente) o producto del legacy. */
export type CatalogoKind = 'PLAN' | 'PRODUCTO';

/** Entrada facturable del catálogo, lista para volcar en una línea de factura. */
export type CatalogoItem = {
  /** Clave estable para el selector (no es un id de BD: el catálogo es una fusión). */
  key: string;
  kind: CatalogoKind;
  name: string;
  /** `Material.legacyId` (pid del legacy). 0 = sin producto asociado (planes). */
  productId: number;
  code: string | null;
  price: number;
  taxRate: number;
  /** Veces que se ha facturado este concepto (ordena el catálogo por uso real). */
  usos: number;
};

/** Vida de la foto en memoria. El catálogo cambia de mes a mes, no de minuto a minuto. */
const TTL_MS = 10 * 60_000;

/** Tope de resultados por consulta (el selector es un buscador, no un volcado). */
const LIMITE_DEF = 40;
const LIMITE_MAX = 100;

/**
 * Conceptos que NO se facturan a mano desde "Nueva factura": las notas tienen su
 * propio flujo (modal de nota crédito/débito) y precio negativo, y "Saldo anterior"
 * lo arrastra la facturación recurrente. Ofrecerlos aquí invita a descuadrar.
 */
const EXCLUIDOS = new Set(['nota credito', 'nota debito', 'saldo anterior']);

/** Sin tildes y en minúsculas, para que "reconexion" encuentre "Reconexión". */
const plano = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Catálogo facturable: qué se le puede cobrar a un cliente.
 *
 * Funde dos fuentes que en el legacy eran una sola tabla `productos`:
 *  - `Plan` activo → la mensualidad, con el precio VIGENTE del catálogo de planes.
 *  - `Material` → el resto de la tabla `productos` del legacy (afiliaciones,
 *    reconexiones, traslados, punto adicional, repetidores, equipos…), que es de
 *    donde el legacy sacaba las líneas al facturar a mano.
 *
 * Ambas fuentes traen nombres repetidos (el legacy tenía una fila de producto por
 * bodega/sede), así que se deduplica por nombre+precio y el plan gana: su precio es
 * el que se cobra hoy. El orden lo pone el uso real (cuántas veces se ha facturado
 * cada concepto), no el alfabeto: lo que más se cobra sale primero.
 *
 * Todo se resuelve sobre una foto en memoria porque el conteo de uso recorre
 * `SubInvoiceItem` entero (~770k filas, ~1,4 s): a cada tecleo del buscador sería
 * inviable, una vez cada 10 minutos no se nota.
 */
export class CatalogoService {
  private readonly log = new Logger(CatalogoService.name);
  private foto: { at: number; items: CatalogoItem[] } | null = null;
  /** Refresco en vuelo: varias pestañas abriendo el modal no disparan N consultas. */
  private cargando: Promise<CatalogoItem[]> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POR QUÉ se puede facturar: el catálogo de motivos, cada uno con el concepto del
   * catálogo que le corresponde (nombre, precio e IVA de HOY).
   *
   * El precio viaja desde aquí y no escrito en la web por lo mismo que el cargo de
   * una orden: el día que el traslado suba de 30.000, la pantalla no puede seguir
   * proponiendo el viejo mientras la factura dice otra cosa. Un motivo cuyo producto
   * no esté en el catálogo sale con `producto: null` — se factura igual, eligiendo el
   * concepto a mano.
   */
  async motivos() {
    const items = await this.items();
    return MOTIVOS_FACTURA.map((m) => {
      // El nombre exacto primero y el que empieza igual después: las afiliaciones son
      // 12 productos distintos ('Afiliación Combo', 'Afiliación Villavo'…) y ninguno
      // se llama 'Afiliación' a secas.
      const busca = m.producto ? plano(m.producto) : null;
      const producto = busca
        ? items.find((i) => plano(i.name) === busca) ?? items.find((i) => plano(i.name).startsWith(busca))
        : undefined;
      return {
        clave: m.clave,
        etiqueta: m.etiqueta,
        ayuda: m.ayuda,
        kind: m.kind,
        /** El tipo de orden que abre al pagarse, si abre alguna. */
        abreOrden: m.abreOrden ?? null,
        pideDestino: !!m.pideDestino,
        producto: producto
          ? { name: producto.name, productId: producto.productId, price: producto.price, taxRate: producto.taxRate }
          : null,
      };
    });
  }

  /** Catálogo filtrado por texto (nombre o código). Sin texto: los más usados. */
  async buscar(search?: string, limit?: number): Promise<{ items: CatalogoItem[]; total: number }> {
    const todos = await this.items();
    const q = plano(search ?? '');
    const tope = Math.min(Math.max(Number(limit) || LIMITE_DEF, 1), LIMITE_MAX);
    if (q) {
      const hallados = todos.filter((i) => plano(i.name).includes(q) || plano(i.code ?? '').includes(q));
      return { items: hallados.slice(0, tope), total: hallados.length };
    }
    // Sin texto no se puede ordenar solo por uso: la corrida mensual factura los
    // planes cientos de miles de veces y taparía a los cobros sueltos (reconexión,
    // traslado, punto adicional), que es justo lo que se factura A MANO. Se alternan
    // las dos familias, cada una por su uso, para que ninguna esconda a la otra.
    return { items: this.alternar(todos, tope), total: todos.length };
  }

  /** Intercala productos y planes (cada grupo ya viene ordenado por uso). */
  private alternar(items: CatalogoItem[], tope: number): CatalogoItem[] {
    const productos = items.filter((i) => i.kind === 'PRODUCTO');
    const planes = items.filter((i) => i.kind === 'PLAN');
    const mezcla: CatalogoItem[] = [];
    for (let i = 0; mezcla.length < tope && (i < productos.length || i < planes.length); i++) {
      if (productos[i]) mezcla.push(productos[i]);
      if (mezcla.length < tope && planes[i]) mezcla.push(planes[i]);
    }
    return mezcla;
  }

  /** Foto vigente del catálogo (la recalcula si venció el TTL). */
  private async items(): Promise<CatalogoItem[]> {
    if (this.foto && Date.now() - this.foto.at < TTL_MS) return this.foto.items;
    if (this.cargando) return this.cargando;
    this.cargando = this.construir()
      .then((items) => {
        this.foto = { at: Date.now(), items };
        return items;
      })
      .catch((e) => {
        // Un fallo del refresco no debe dejar el selector vacío: se sirve la foto
        // anterior (aunque esté vencida) y se reintenta en la siguiente llamada.
        this.log.error(`No se pudo refrescar el catálogo facturable: ${String(e)}`);
        return this.foto?.items ?? [];
      })
      .finally(() => { this.cargando = null; });
    return this.cargando;
  }

  private async construir(): Promise<CatalogoItem[]> {
    const [planes, materiales, usos] = await Promise.all([
      this.prisma.plan.findMany({
        where: { active: true },
        select: { name: true, price: true, taxRate: true },
      }),
      this.prisma.material.findMany({
        select: { legacyId: true, name: true, code: true, price: true, taxRate: true },
      }),
      this.prisma.$queryRaw<{ productName: string | null; n: bigint }[]>`
        SELECT "productName", count(*)::bigint AS n
          FROM "SubInvoiceItem"
         WHERE "productName" IS NOT NULL AND btrim("productName") <> ''
         GROUP BY 1
      `,
    ]);

    // Se SUMA, no se pisa: el histórico trae el mismo concepto escrito de varias
    // formas ("Reconexión Internet" / "Reconexion internet") y todas cuentan igual.
    const porUso = new Map<string, number>();
    for (const u of usos) {
      const k = plano(u.productName ?? '');
      porUso.set(k, (porUso.get(k) ?? 0) + Number(u.n));
    }

    const items: CatalogoItem[] = [];
    const vistos = new Set<string>();
    // El plan va primero a propósito: si un producto del legacy repite su nombre con
    // un precio viejo, el que sobrevive es el del catálogo de planes.
    const crudos = [
      ...planes.map((p) => ({ kind: 'PLAN' as const, name: p.name, code: null, productId: 0, price: num(p.price), taxRate: num(p.taxRate) })),
      ...materiales.map((m) => ({ kind: 'PRODUCTO' as const, name: m.name, code: m.code, productId: m.legacyId ?? 0, price: num(m.price), taxRate: num(m.taxRate) })),
    ];

    for (const r of crudos) {
      const name = (r.name ?? '').trim();
      // Nombres vacíos o que son solo el código (el legacy tiene filas así) no sirven
      // de concepto en una factura: nadie los reconoce en el PDF.
      if (!name || /^\d+$/.test(name)) continue;
      const norm = plano(name);
      if (EXCLUIDOS.has(norm)) continue;
      const clave = `${norm}|${r.price}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      items.push({ key: `${r.kind}:${clave}`, kind: r.kind, name, productId: r.productId, code: r.code, price: r.price, taxRate: r.taxRate, usos: porUso.get(norm) ?? 0 });
    }

    items.sort((a, b) => b.usos - a.usos || a.name.localeCompare(b.name, 'es'));
    return items;
  }
}
