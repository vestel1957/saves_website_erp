import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { SubscribersService } from '../../subscribers/subscribers.service';
import { CobranzasService } from '../../treasury/cobranzas.service';
import { ChatbotDocsService, enviarDoc } from '../chatbot-docs.service';
import {
  canAny, cop, DOCUMENTO_DENEGADO, fecha, gated, HERRAMIENTAS_DOCUMENTOS, puedeDocumentos, safe,
} from './toolset.util';
import { authUserOf } from '../chatbot.identity';

/** Mismo gate que el controller de clientes: cualquier área operativa consulta. */
const VER_ABONADOS = [P.AREA_ADMINISTRACION, P.AREA_CONTABILIDAD, P.AREA_TECNICOS, P.AREA_CAJA];

/**
 * Consultas de abonado para el agente interno: buscar, ficha, estado de cuenta y
 * facturas. Todo es lectura y reutiliza los mismos servicios que la web, así que
 * un funcionario ve por WhatsApp exactamente lo que vería en pantalla.
 */
export class InternoAbonadosToolset implements Toolset {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly cobranzas: CobranzasService,
    private readonly docs: ChatbotDocsService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return [
      ...gated(canAny(ctx, VER_ABONADOS), [
      {
        name: 'buscar_abonado',
        description:
          'Busca abonados (clientes) por nombre, número de abonado, documento o teléfono. ' +
          'Devuelve hasta 5 coincidencias con su id, que sirve para las demás herramientas.',
        input_schema: {
          type: 'object',
          properties: { q: { type: 'string', description: 'Nombre, nº de abonado, documento o teléfono' } },
          required: ['q'],
        },
      },
      {
        name: 'ficha_abonado',
        description:
          'Ficha de un abonado: datos de contacto, dirección, sede, estado, plan(es) y datos de red (usuario PPPoE, perfil, MAC).',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string', description: 'id del abonado (de buscar_abonado)' } },
          required: ['subscriberId'],
        },
      },
      {
        name: 'estado_cuenta_abonado',
        description:
          'Saldo y deuda de un abonado: total adeudado, saldo a favor y facturas pendientes con su vencimiento.',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string' } },
          required: ['subscriberId'],
        },
      },
      {
        name: 'facturas_abonado',
        description: 'Últimas facturas de un abonado (por defecto 5), con total, pagado y estado.',
        input_schema: {
          type: 'object',
          properties: {
            subscriberId: { type: 'string' },
            limite: { type: 'number', description: 'Cuántas facturas devolver (máx. 10)' },
          },
          required: ['subscriberId'],
        },
      },
      ]),
      ...gated(canAny(ctx, VER_ABONADOS) && puedeDocumentos(ctx), [{
        name: 'enviar_pdf_abonado',
        description:
          'Genera un documento del abonado en PDF y lo adjunta A ESTE CHAT (no se le manda al cliente). ' +
          'Tipos: "estado_cuenta" (cargos, abonos y saldo corrido), "paz_y_salvo" (certificado; si tiene ' +
          'deuda sale como constancia de cartera) y "contrato" (contrato de servicios con sus cláusulas). ' +
          'Es el mismo PDF que se imprime desde el ERP.',
        input_schema: {
          type: 'object',
          properties: {
            subscriberId: { type: 'string', description: 'id del abonado (de buscar_abonado)' },
            tipo: { type: 'string', enum: ['estado_cuenta', 'paz_y_salvo', 'contrato'] },
          },
          required: ['subscriberId', 'tipo'],
        },
      }]),
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, VER_ABONADOS)) return PERMISSION_DENIED;
    // Segunda barrera de los documentos: declararlos solo a administración evita que
    // el modelo los ofrezca, pero no que los invoque si se inventa el nombre.
    if (HERRAMIENTAS_DOCUMENTOS.has(name) && !puedeDocumentos(ctx)) return DOCUMENTO_DENEGADO;

    switch (name) {
      case 'buscar_abonado':
        return safe(() => this.buscar(String(input.q ?? ''), ctx));
      case 'ficha_abonado':
        return safe(() => this.ficha(String(input.subscriberId ?? ''), ctx));
      case 'estado_cuenta_abonado':
        return safe(() => this.estadoCuenta(String(input.subscriberId ?? '')));
      case 'facturas_abonado':
        return safe(() => this.facturas(String(input.subscriberId ?? ''), Number(input.limite) || 5));
      case 'enviar_pdf_abonado':
        return safe(() => this.enviarPdf(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async buscar(q: string, ctx: ToolContext): Promise<string> {
    if (!q.trim()) return 'Indica un nombre, número de abonado, documento o teléfono para buscar.';
    const res = await this.subscribers.list({ search: q, pageSize: 5, withPlan: '1' }, authUserOf(ctx.user));
    if (!res.items.length) return `No encontré abonados que coincidan con "${q}".`;
    const lineas = res.items.map((s: any) =>
      `• ${s.name} — abonado ${s.abonado} · ${s.status ?? 'sin estado'}` +
      `${s.internet ? ` · Internet: ${s.internet}` : ''}` +
      `${s.debt ? ` · debe ${cop(s.debt)}` : ''}` +
      `\n  id: ${s.id}`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más; afina la búsqueda)` : '';
    return `${res.total} resultado(s):\n${lineas.join('\n')}${extra}`;
  }

  private async ficha(id: string, ctx: ToolContext): Promise<string> {
    const s: any = await this.subscribers.detail(id, authUserOf(ctx.user));
    const servicios = (s.services ?? [])
      .map((sv: any) => `${sv.kind}: ${sv.planName ?? '—'} (${sv.status ?? '—'}, ${cop(sv.price)})`)
      .join(' · ') || 'sin servicios';
    return [
      `${s.name} — abonado ${s.abonado} (${s.status ?? 'sin estado'})`,
      `Documento: ${s.docType ?? ''} ${s.docNumber ?? '—'}`,
      `Teléfono: ${s.phone1 ?? '—'}${s.phone2 ? ` / ${s.phone2}` : ''}`,
      `Correo: ${s.email ?? '—'}`,
      `Dirección: ${s.addressLine ?? '—'}${s.neighborhood ? `, ${s.neighborhood}` : ''} · Sede: ${s.branch ?? '—'}`,
      `Servicios: ${servicios}`,
      `Red: PPPoE ${s.network?.pppUsername ?? '—'} · perfil ${s.network?.pppProfile ?? '—'} · MAC ${s.network?.macEquipo ?? '—'}`,
      `Cartera: debe ${cop(s.receivable)}${s.balance ? ` · saldo a favor ${cop(s.balance)}` : ''}`,
      `id: ${s.id}`,
    ].join('\n');
  }

  private async estadoCuenta(id: string): Promise<string> {
    const d = await this.cobranzas.subscriberDebt(id);
    if (!d.invoices.length) {
      return `${d.name} (abonado ${d.abonado}) está al día.` +
        (d.balance ? ` Tiene saldo a favor de ${cop(d.balance)}.` : '');
    }
    const lineas = d.invoices.map(
      (i) => `• Factura ${i.tid} · vence ${fecha(i.dueDate)} · debe ${cop(i.balance)} de ${cop(i.total)} (${i.status})`,
    );
    return [
      `${d.name} (abonado ${d.abonado}) debe ${cop(d.totalDebt)} en ${d.invoices.length} factura(s):`,
      ...lineas,
      d.balance ? `Saldo a favor: ${cop(d.balance)}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Documentos del abonado en PDF, al chat de quien pregunta.
   *
   * El `AuthUser` del funcionario viaja hasta el servicio: un usuario de una sede no
   * puede sacar por WhatsApp el contrato de un abonado de otra, igual que no puede
   * abrirlo en la web.
   *
   * A diferencia del agente de clientes, aquí el paz y salvo SÍ se manda aunque haya
   * deuda: quien lo pide es un funcionario que necesita el soporte del estado real de
   * la cartera, no el certificado para un trámite.
   */
  private async enviarPdf(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const id = String(input.subscriberId ?? '').trim();
    const tipo = String(input.tipo ?? '').trim();
    if (!id) return 'Indica el id del abonado (búscalo primero con buscar_abonado).';
    const user = authUserOf(ctx.user);

    switch (tipo) {
      case 'estado_cuenta':
        return enviarDoc(ctx, await this.docs.estadoCuenta(id, user));
      case 'paz_y_salvo': {
        const doc = await this.docs.pazYSalvo(id, user);
        // Ni por dentro se saltan los requisitos: el certificado sólo sale con la
        // cuenta en cero, el equipo devuelto, la carta de retiro o suspensión
        // entregada y esa orden cerrada. Ver `SubscribersService.statement`.
        if (!doc.puedeEmitir) {
          return `No se puede expedir el paz y salvo de este abonado porque ${doc.motivosTexto}. `
            + 'Dilo tal cual y ofrece el estado de cuenta si lo que falta es plata.';
        }
        return enviarDoc(ctx, doc);
      }
      case 'contrato':
        return enviarDoc(ctx, await this.docs.contrato(id, user));
      default:
        return `No conozco el documento "${tipo}". Puedo generar: estado_cuenta, paz_y_salvo o contrato.`;
    }
  }

  private async facturas(id: string, limite: number): Promise<string> {
    const rows: any[] = await this.subscribers.invoices(id);
    if (!rows.length) return 'Ese abonado no tiene facturas.';
    const top = rows.slice(0, Math.min(Math.max(limite, 1), 10));
    const lineas = top.map(
      (i) => `• ${i.tid} · ${fecha(i.invoiceDate)} · ${cop(i.total)} · ${i.status}` +
        `${i.balance ? ` · debe ${cop(i.balance)}` : ''}\n  id: ${i.id}`,
    );
    return `Últimas ${top.length} de ${rows.length} facturas:\n${lineas.join('\n')}`;
  }
}
