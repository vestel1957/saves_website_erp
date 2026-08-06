import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { OrdersService } from '../../orders/orders.service';
import { ChatbotDocsService, enviarDoc } from '../chatbot-docs.service';
import {
  canAny, cop, DOCUMENTO_DENEGADO, fecha, gated, HERRAMIENTAS_DOCUMENTOS, puedeDocumentos, safe,
} from './toolset.util';

/** Mismo gate que `OrdersController` (`@RequireArea('administracion','caja')`). */
const COMPRAS = [P.AREA_ADMINISTRACION, P.AREA_CAJA];

/** Estados reales de una orden en la BD, y cómo los nombra la gente. */
const ESTADOS = ['pendiente', 'aprobado', 'recibido', 'finalizado', 'abonado', 'cancelado', 'anulado'] as const;
const SINONIMOS: Record<string, (typeof ESTADOS)[number]> = {
  PENDIENTES: 'pendiente', 'POR APROBAR': 'pendiente', 'SIN APROBAR': 'pendiente', 'POR AUTORIZAR': 'pendiente',
  APROBADAS: 'aprobado', APROBADOS: 'aprobado', AUTORIZADO: 'aprobado', AUTORIZADAS: 'aprobado',
  RECIBIDAS: 'recibido', RECIBIDOS: 'recibido',
  FINALIZADAS: 'finalizado', FINALIZADOS: 'finalizado', CERRADA: 'finalizado', CERRADAS: 'finalizado',
  ABONADAS: 'abonado', ABONADOS: 'abonado',
  CANCELADAS: 'cancelado', CANCELADOS: 'cancelado',
  ANULADAS: 'anulado', ANULADOS: 'anulado',
};

/** Traduce lo que diga el modelo al estado real; null si no se reconoce. */
function estadoDe(raw: unknown): (typeof ESTADOS)[number] | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  const min = v.toLowerCase();
  if ((ESTADOS as readonly string[]).includes(min)) return min as (typeof ESTADOS)[number];
  return SINONIMOS[v.toUpperCase()] ?? null;
}

/**
 * Órdenes de compra y proveedores para el agente interno.
 *
 * SOLO LECTURA, y la omisión es deliberada: **aprobar** una orden no se expone por
 * chat. Es un compromiso de plata con doble firma por monto, y una confirmación
 * "SÍ/NO" por WhatsApp no da para revisar ítems, precios y adjuntos — que es
 * justamente lo que hace que una firma signifique algo. El bot dice qué hay
 * pendiente y con qué detalle; firmar se hace en /ordenes.
 */
export class InternoComprasToolset implements Toolset {
  constructor(
    private readonly orders: OrdersService,
    private readonly docs: ChatbotDocsService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return [
      ...gated(canAny(ctx, COMPRAS), [
      {
        name: 'ordenes_de_compra',
        description:
          'Órdenes de compra y de servicio a proveedores, con su estado, proveedor y monto. Devuelve cuántas hay. ' +
          'Úsala para "qué órdenes hay pendientes de aprobar/autorizar", "órdenes de tal proveedor", ' +
          '"cuánto llevamos comprado". Las que esperan firma son las de estado "pendiente".',
        input_schema: {
          type: 'object',
          properties: {
            estado: { type: 'string', description: `Estado: ${ESTADOS.join(', ')}. "pendiente" = espera aprobación.` },
            proveedor: { type: 'string', description: 'Nombre del proveedor o número de orden. Opcional.' },
            tipo: { type: 'string', enum: ['compra', 'servicio'], description: 'Opcional.' },
          },
        },
      },
      {
        name: 'detalle_orden_compra',
        description:
          'Detalle de una orden: proveedor, ítems, montos, saldo por pagar y en qué va su aprobación ' +
          '(quién firmó y si le falta la segunda firma). Necesita el id de ordenes_de_compra.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'id de la orden (de ordenes_de_compra)' } },
          required: ['id'],
        },
      },
      ]),
      ...gated(canAny(ctx, COMPRAS) && puedeDocumentos(ctx), [{
        name: 'enviar_pdf_orden_compra',
        description:
          'Genera el PDF imprimible de una orden de compra/servicio y lo adjunta A ESTE CHAT: ítems, ' +
          'montos, observaciones y el cuadro de firmas (quién elaboró y quién autorizó). Sirve para ' +
          'revisarla o mandársela al proveedor, pero NO la aprueba: firmar sigue siendo en /ordenes.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'id de la orden (de ordenes_de_compra)' } },
          required: ['id'],
        },
      }]),
      ...gated(canAny(ctx, COMPRAS), [
      {
        name: 'resumen_compras',
        description: 'Cuántas órdenes hay por estado y cuánto suman, separando compras de servicios.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'estado_cuenta_proveedor',
        description:
          'Cuánto se le ha comprado a un proveedor, cuánto se le ha pagado y cuánto se le debe. ' +
          'Úsala para "cuánto le debemos a X". Busca el proveedor por nombre.',
        input_schema: {
          type: 'object',
          properties: { proveedor: { type: 'string', description: 'Nombre del proveedor' } },
          required: ['proveedor'],
        },
      },
      ]),
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, COMPRAS)) return 'PERMISO_DENEGADO';
    // Segunda barrera de los documentos: declararlos solo a administración evita que
    // el modelo los ofrezca, pero no que los invoque si se inventa el nombre.
    if (HERRAMIENTAS_DOCUMENTOS.has(name) && !puedeDocumentos(ctx)) return DOCUMENTO_DENEGADO;
    switch (name) {
      case 'ordenes_de_compra':
        return safe(() => this.lista(input));
      case 'detalle_orden_compra':
        return safe(() => this.detalle(String(input.id ?? '')));
      case 'enviar_pdf_orden_compra':
        return safe(() => this.enviarPdf(String(input.id ?? ''), ctx));
      case 'resumen_compras':
        return safe(() => this.resumen());
      case 'estado_cuenta_proveedor':
        return safe(() => this.proveedor(String(input.proveedor ?? '')));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async lista(input: Record<string, unknown>): Promise<string> {
    // "por autorizar" no es un estado de la BD: se traduce antes de consultar, igual
    // que en tickets, en vez de mandarle a Prisma un valor que no existe.
    const estado = input.estado ? estadoDe(input.estado) : undefined;
    if (input.estado && !estado) {
      return `No conozco el estado "${String(input.estado)}". Son: ${ESTADOS.join(', ')} ` +
        '(las que esperan firma son las "pendiente").';
    }

    const res: any = await this.orders.list({
      status: estado ?? undefined,
      search: input.proveedor ? String(input.proveedor) : undefined,
      kind: input.tipo ? String(input.tipo) : undefined,
      pageSize: 8,
    });
    if (!res.items?.length) return 'No encontré órdenes con esos criterios.';

    const suma = res.items.reduce((a: number, o: any) => a + (o.total ?? 0), 0);
    const lineas = res.items.map(
      (o: any) => `• #${o.tid} [${o.status}] ${o.supplier} — ${cop(o.total)}` +
        `${o.paid > 0 && o.paid < o.total ? ` (abonado ${cop(o.paid)})` : ''} · ${fecha(o.date)}\n  id: ${o.id}`,
    );
    const extra = res.total > res.items.length
      ? `\n(+${res.total - res.items.length} más; se muestran las ${res.items.length} más recientes, que suman ${cop(suma)})`
      : '';
    return `${res.total} orden(es):\n${lineas.join('\n')}${extra}`;
  }

  private async detalle(id: string): Promise<string> {
    if (!id) return 'Indica el id de la orden (búscala primero con ordenes_de_compra).';
    const o: any = await this.orders.detail(id);

    const items = (o.items ?? []).slice(0, 8)
      .map((it: any) => `  – ${it.qty} × ${it.product} = ${cop(it.subtotal)}`)
      .join('\n');
    const masItems = (o.items ?? []).length > 8 ? `\n  … y ${o.items.length - 8} ítem(s) más` : '';

    // El estado de la firma es lo que de verdad se pregunta por chat ("¿ya la
    // aprobaron?"), así que se dice en palabras y no como un par de campos sueltos.
    const a = o.approval ?? {};
    const firma = !a.enFlujo
      ? 'Orden heredada del sistema viejo: no pasa por el flujo de aprobación.'
      : a.awaiting
        ? a.firstBy
          ? `ESPERA LA 2.ª FIRMA (ya firmó ${a.firstBy} el ${fecha(a.firstAt)}; por el monto necesita otra persona distinta).`
          : `ESPERA APROBACIÓN${a.needsTwo ? ' (por el monto necesitará DOS firmas)' : ''}.`
        : `Aprobada por ${a.firstBy ?? '—'}${a.secondBy ? ` y ${a.secondBy}` : ''}.`;

    return [
      `Orden #${o.tid} [${o.status}] · ${o.kind} · ${fecha(o.date)}`,
      `Proveedor: ${o.supplier?.name ?? '—'}${o.supplier?.nit ? ` (NIT ${o.supplier.nit})` : ''}`,
      `Total: ${cop(o.total)} · pagado ${cop(o.paid)} · saldo ${cop(o.balance)}`,
      firma,
      o.createdByName ? `La creó: ${o.createdByName}` : '',
      items ? `Ítems:\n${items}${masItems}` : '',
      o.notes ? `Notas: ${o.notes}` : '',
      `Para firmarla hay que entrar a /ordenes: por chat no se aprueban.`,
    ].filter(Boolean).join('\n');
  }

  private async enviarPdf(id: string, ctx: ToolContext): Promise<string> {
    if (!id) return 'Indica el id de la orden (búscala primero con ordenes_de_compra).';
    return enviarDoc(ctx, await this.docs.ordenCompra(id));
  }

  private async resumen(): Promise<string> {
    const s: any = await this.orders.stats();
    const porEstado = Object.entries(s.status ?? {})
      .sort((a: any, b: any) => b[1] - a[1])
      .map(([e, n]) => `• ${e}: ${n}`)
      .join('\n');
    return [
      `${s.total} órdenes por ${cop(s.montoTotal)} en total.`,
      `Compras: ${s.compra?.count ?? 0} por ${cop(s.compra?.total)} · Servicios: ${s.servicio?.count ?? 0} por ${cop(s.servicio?.total)}`,
      porEstado ? `Por estado:\n${porEstado}` : '',
    ].filter(Boolean).join('\n');
  }

  private async proveedor(nombre: string): Promise<string> {
    if (!nombre) return 'Dime el nombre del proveedor.';
    const encontrados: any = await this.orders.suppliers({ search: nombre, pageSize: 5 });
    if (!encontrados.items?.length) return `No encontré ningún proveedor que se llame "${nombre}".`;
    if (encontrados.items.length > 1) {
      // Con varios candidatos NO se adivina: el saldo del proveedor equivocado es un
      // dato que alguien puede usar para pagar.
      return `Hay ${encontrados.items.length} proveedores que calzan con "${nombre}":\n` +
        encontrados.items.map((p: any) => `• ${p.name}`).join('\n') +
        '\nPregunta cuál es y vuelve a buscar con el nombre completo.';
    }

    const e: any = await this.orders.supplierStatement(encontrados.items[0].id);
    const pendientes = (e.orders ?? []).filter((o: any) => o.balance > 0).slice(0, 5);
    return [
      `${e.supplier.name}${e.supplier.nit ? ` (NIT ${e.supplier.nit})` : ''}${e.supplier.phone ? ` · tel ${e.supplier.phone}` : ''}`,
      `Comprado: ${cop(e.totals.totalOrdered)} · pagado: ${cop(e.totals.totalPaid)} · SALDO: ${cop(e.totals.saldo)}`,
      pendientes.length
        ? `Órdenes con saldo:\n${pendientes.map((o: any) => `• #${o.tid} (${o.status}) ${fecha(o.date)} — debe ${cop(o.balance)}`).join('\n')}`
        : 'No tiene órdenes con saldo pendiente.',
    ].join('\n');
  }
}
