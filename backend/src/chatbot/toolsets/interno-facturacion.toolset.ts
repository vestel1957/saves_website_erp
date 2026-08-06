import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { BillingService } from '../../billing/billing.service';
import { FacturasService } from '../../billing/facturas.service';
import { RecurringService } from '../../billing/recurring.service';
import { EinvoiceService } from '../../einvoice/einvoice.service';
import { ChatbotDocsService, enviarDoc } from '../chatbot-docs.service';
import { authUserOf } from '../chatbot.identity';
import {
  canAny, cop, DOCUMENTO_DENEGADO, fecha, gated, HERRAMIENTAS_DOCUMENTOS, puedeDocumentos, safe,
} from './toolset.util';

/** Mismo gate que `BillingController` (`@RequireArea('contabilidad','caja')`). */
const FACTURACION = [P.AREA_CONTABILIDAD, P.AREA_CAJA, P.AREA_ADMINISTRACION];
/** La e-factura es de contabilidad, igual que su controller. */
const EFACTURA = [P.AREA_CONTABILIDAD];

/**
 * Facturación para el agente interno: qué se facturó, qué está pendiente, cómo está
 * la cartera por edades, las notas crédito y las facturaciones recurrentes.
 *
 * SOLO LECTURA. La generación masiva (`generate`) factura a más de 20.000 abonados de
 * un golpe y anular una factura mueve contabilidad y cartera: eso NO se dispara desde
 * un chat, donde no hay forma de revisar el previo antes de aceptar. Las facturas
 * individuales se emiten desde /facturacion.
 *
 * `list` recibe el AuthUser real porque el acotado por sede vive ahí: un usuario de
 * una sede no puede ver la facturación de otra, ni por la web ni por WhatsApp.
 */
export class InternoFacturacionToolset implements Toolset {
  constructor(
    private readonly billing: BillingService,
    private readonly facturas: FacturasService,
    private readonly recurring: RecurringService,
    private readonly einvoice: EinvoiceService,
    private readonly docs: ChatbotDocsService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return [
      ...gated(canAny(ctx, FACTURACION), [
        {
          name: 'resumen_facturacion',
          description:
            'Cómo va la facturación: cuántas facturas se emitieron, cuánto suman, cuántas están pagadas, ' +
            'pendientes o parciales, y cuánta cartera hay. Úsala para "cómo vamos de facturación", ' +
            '"cuánta cartera tenemos".',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'buscar_facturas',
          description:
            'Busca facturas de abonados por cliente, número o estado, y dice cuántas hay. ' +
            'Estados: DUE (pendiente), PAID (pagada), PARTIAL (abono parcial), VOID (anulada). ' +
            'Con vencidas=true trae solo las que ya pasaron su fecha de pago.',
          input_schema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'Cliente, número de abonado o de factura' },
              estado: { type: 'string', enum: ['DUE', 'PAID', 'PARTIAL', 'VOID'] },
              vencidas: { type: 'boolean', description: 'Solo facturas vencidas con saldo' },
            },
          },
        },
      ]),
      ...gated(canAny(ctx, FACTURACION) && puedeDocumentos(ctx), [
        {
          name: 'enviar_pdf_factura',
          description:
            'Genera el PDF de una factura de abonado y lo adjunta A ESTE CHAT (no se le manda al cliente). ' +
            'Es la misma impresión del ERP. Dale el número de factura o su id (de buscar_facturas / ' +
            'facturas_abonado).',
          input_schema: {
            type: 'object',
            properties: {
              numero: { type: 'string', description: 'Número (tid) de la factura' },
              facturaId: { type: 'string', description: 'id de la factura, si ya lo tienes' },
            },
          },
        },
      ]),
      ...gated(canAny(ctx, FACTURACION), [
        {
          name: 'cartera_por_edades',
          description:
            'Reparte la cartera por antigüedad: corriente, 1-30, 31-60, 61-90 y más de 90 días. ' +
            'Es la foto para decidir a quién cobrar primero.',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'notas_credito',
          description: 'Últimas notas crédito y débito emitidas sobre facturas de abonados.',
          input_schema: {
            type: 'object',
            properties: { q: { type: 'string', description: 'Cliente o número. Opcional.' } },
          },
        },
        {
          name: 'facturacion_recurrente',
          description:
            'Facturaciones automáticas configuradas (cargos que se repiten cada mes): cuáles hay, ' +
            'a quién y si están activas.',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
      ...gated(canAny(ctx, EFACTURA), [
        {
          name: 'estado_efactura',
          description:
            'Cómo va la facturación electrónica ante la DIAN vía Siigo: cuántas aceptadas, rechazadas ' +
            'o pendientes, y las últimas con problema.',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'estado_efactura') {
      if (!canAny(ctx, EFACTURA)) return 'PERMISO_DENEGADO';
      return safe(() => this.efactura());
    }
    if (!canAny(ctx, FACTURACION)) return 'PERMISO_DENEGADO';
    // Segunda barrera de los documentos: declararlos solo a administración evita que
    // el modelo los ofrezca, pero no que los invoque si se inventa el nombre.
    if (HERRAMIENTAS_DOCUMENTOS.has(name) && !puedeDocumentos(ctx)) return DOCUMENTO_DENEGADO;
    switch (name) {
      case 'resumen_facturacion':
        return safe(() => this.resumen());
      case 'buscar_facturas':
        return safe(() => this.buscar(input, ctx));
      case 'enviar_pdf_factura':
        return safe(() => this.enviarPdf(input, ctx));
      case 'cartera_por_edades':
        return safe(() => this.edades());
      case 'notas_credito':
        return safe(() => this.notas(input));
      case 'facturacion_recurrente':
        return safe(() => this.recurrente());
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async resumen(): Promise<string> {
    const s: any = await this.billing.stats();
    return [
      `Facturación (${s.periodo}): ${s.total} facturas por ${cop(s.facturadoTotal)}.`,
      `• Pagadas: ${s.pagadas} · pendientes: ${s.pendientes} · con abono parcial: ${s.parciales}`,
      `Cartera viva: ${cop(s.carteraTotal)} en ${s.carteraFacturas} factura(s) sin saldar.`,
    ].join('\n');
  }

  private async buscar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const res: any = await this.billing.list(
      {
        search: input.q ? String(input.q) : undefined,
        status: input.estado ? String(input.estado).toUpperCase() : undefined,
        overdue: input.vencidas ? '1' : undefined,
        pageSize: 8,
      },
      authUserOf(ctx.user),
    );
    if (!res.items?.length) return 'No encontré facturas con esos criterios.';

    // El id va en la línea (como en el resto de toolsets) porque es lo que necesita
    // `enviar_pdf_factura` para sacar la impresión sin volver a buscar.
    const lineas = res.items.map(
      (f: any) => `• #${f.tid} ${f.subscriber} (ab. ${f.abonado ?? '—'}) — ${cop(f.total)}` +
        `${f.balance > 0 ? ` · debe ${cop(f.balance)}` : ' · pagada'} · vence ${fecha(f.dueDate)}` +
        `\n  id: ${f.id}`,
    );
    const extra = res.total > res.items.length
      ? `\n(+${res.total - res.items.length} más; el filtro completo suma ${cop(res.sum?.total)} con ${cop(res.sum?.balance)} por cobrar)`
      : '';
    return `${res.total} factura(s):\n${lineas.join('\n')}${extra}`;
  }

  /**
   * PDF de una factura, al chat del funcionario.
   *
   * Acepta el número (que es lo que la gente tiene a mano: está impreso en la factura)
   * y lo resuelve buscando con `all: '1'` — sin eso el listado se acota al año en
   * curso y una factura del año pasado "no existiría". La búsqueda por número también
   * calza con el número de abonado, así que se exige que el `tid` coincida exactamente:
   * mandar la factura equivocada es peor que no mandar ninguna.
   */
  private async enviarPdf(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const user = authUserOf(ctx.user);
    let id = String(input.facturaId ?? '').trim();

    if (!id) {
      const numero = String(input.numero ?? '').replace(/\D/g, '');
      if (!numero) return 'Dime el número de la factura (o su id) para generarte el PDF.';
      const res: any = await this.billing.list({ search: numero, all: '1', pageSize: 10 }, user);
      const exactas = (res.items ?? []).filter((f: any) => String(f.tid) === numero);
      if (!exactas.length) return `No encontré la factura ${numero} (o no es de una sede a la que tengas acceso).`;
      if (exactas.length > 1) {
        return `Hay ${exactas.length} facturas con el número ${numero}. Dime cuál con su id:\n` +
          exactas.map((f: any) => `• #${f.tid} ${f.subscriber} — ${cop(f.total)}\n  id: ${f.id}`).join('\n');
      }
      id = exactas[0].id;
    }

    return enviarDoc(ctx, await this.docs.factura(id, user));
  }

  private async edades(): Promise<string> {
    const a: any = await this.billing.aging();
    const total = a.corriente + a.d1_30 + a.d31_60 + a.d61_90 + a.d90;
    return [
      `Cartera por edades (total ${cop(total)}):`,
      `• Al día / por vencer: ${cop(a.corriente)}`,
      `• 1 a 30 días: ${cop(a.d1_30)}`,
      `• 31 a 60 días: ${cop(a.d31_60)}`,
      `• 61 a 90 días: ${cop(a.d61_90)}`,
      `• Más de 90 días: ${cop(a.d90)}`,
    ].join('\n');
  }

  private async notas(input: Record<string, unknown>): Promise<string> {
    const res: any = await this.facturas.listNotes({
      search: input.q ? String(input.q) : undefined,
      pageSize: 8,
    });
    if (!res.items?.length) return 'No hay notas crédito o débito con esos criterios.';
    const lineas = res.items.map(
      (n: any) => `• Nota ${n.type} de ${cop(n.amount)} — ${n.subscriber} (factura #${n.tid ?? '—'})` +
        `${n.description ? `: ${n.description}` : ''}${n.author ? ` · la hizo ${n.author}` : ''} · ${fecha(n.date)}`,
    );
    return `${res.total} nota(s):\n${lineas.join('\n')}`;
  }

  private async recurrente(): Promise<string> {
    const [s, res]: any[] = await Promise.all([this.recurring.stats(), this.recurring.list({ pageSize: 8 })]);
    if (!res.items?.length) return 'No hay facturaciones recurrentes configuradas.';
    const lineas = res.items.map(
      (r: any) => `• #${r.tid} ${r.subscriber} (ab. ${r.abonado ?? '—'}) — ${cop(r.total)} · ` +
        `${r.rec ?? 'periódica'} · ${r.active ? 'activa' : 'INACTIVA'}`,
    );
    const cab = s ? `${s.total ?? res.total} plantilla(s) recurrente(s)${s.activas != null ? `, ${s.activas} activa(s)` : ''}.` : '';
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más)` : '';
    return [cab, lineas.join('\n') + extra].filter(Boolean).join('\n');
  }

  private async efactura(): Promise<string> {
    const [s, res]: any[] = await Promise.all([this.einvoice.stats(), this.einvoice.list({ pageSize: 20 })]);
    // `errorMessage` es lo que hay que mirar: una e-factura creada pero rechazada por
    // la DIAN se ve "emitida" en el conteo y sin embargo no existe legalmente.
    const conError = (res.items ?? []).filter((e: any) => e.error).slice(0, 5);
    return [
      `Facturación electrónica: ${s.total} documento(s) registrados, ${s.conDian} con número DIAN.`,
      // Sin esta aclaración el conteo asusta: la migración del sistema viejo trajo
      // cientos de miles de documentos que nunca guardaron el CUFE, y "0 con número
      // DIAN" se lee como si nada estuviera timbrado.
      s.sinDian
        ? `${s.sinDian} sin número DIAN — en su mayoría documentos heredados del sistema viejo, que nunca guardaron el CUFE; no significa que estén rechazados.`
        : '',
      `Marcadas para timbrar y aún sin crear: ${s.pendientes}.`,
      conError.length
        ? `Últimas con error:\n${conError.map((e: any) => `• ${e.client ?? '—'} (${fecha(e.date)}): ${String(e.error).slice(0, 90)}`).join('\n')}`
        : 'Ninguna de las últimas tiene error registrado.',
    ].join('\n');
  }
}
