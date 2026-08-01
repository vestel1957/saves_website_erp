import { Injectable, Logger } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { SubscribersService } from '../../subscribers/subscribers.service';
import { CobranzasService } from '../../treasury/cobranzas.service';
import { SupportWriteService } from '../../support/support-write.service';
import {
  BOT_ACTOR,
  CHAT_CLIENTE_PERMISSION,
  CHAT_PUBLICO_PERMISSION,
  identityOf,
  phoneOf,
  tieneAccesoPleno,
} from '../chatbot.identity';
import {
  APPS_POR_NIVEL,
  INFO_COMERCIAL,
  REGLA_DOS_MESES,
  TRAMITES,
  TRAMITES_SIN_ABONADO,
  TRAMITE_SLUGS,
  type TramiteDef,
} from '../tramites.catalogo';
import { cop, esSonda, safe } from './toolset.util';

/** Estados en los que una orden ya no cuenta como "abierta". */
const CERRADOS = new Set(['ANULADA', 'RESUELTO', 'CERRADA', 'SOLUCIONADA']);

/** Meses máximos que se guarda la línea en una suspensión temporal. */
const MAX_MESES_SUSPENSION = 3;

/**
 * Los trámites de SAM, portados al ERP.
 *
 * Es el equivalente de su única herramienta `registrar_caso`, y hereda de ella lo
 * mejor que tenía: **el servidor manda**. SAM ya había aprendido a las malas que
 * dejarle al modelo la parte verificable sale caro —se inventaba el número de
 * radicado copiándolo del ejemplo del prompt, y había que sustituirlo por regex antes
 * de mandárselo al cliente—, así que movió al servidor la validación y la generación
 * del número. Aquí se lleva ese principio hasta el final:
 *
 *  - el NÚMERO de la orden lo pone el ERP (`Ticket.code`), no el modelo. Es un
 *    consecutivo real, rastreable, el mismo que ve el equipo en /soporte — no el
 *    `VES-XXXX` aleatorio de SAM, que no existía en ningún sistema;
 *  - los CAMPOS obligatorios de cada trámite se comprueban aquí. Si falta la
 *    dirección nueva de un traslado, no hay orden: se le devuelve al modelo la
 *    pregunta que debe hacer;
 *  - las REGLAS de negocio se comprueban contra los datos reales (una suspensión
 *    exige estar al día: se mira la deuda, no se le pregunta al cliente);
 *  - no se abren DUPLICADOS: si ya hay una orden abierta del mismo tipo, se devuelve
 *    su número en vez de crear otra. Es la regla "post-radicado" de SAM, que en su
 *    versión era una instrucción del prompt y aquí es una consulta a la BD.
 *
 * Lo que NO se porta de SAM: identificar al cliente pidiéndole la cédula por chat.
 * Aquí quien escribe ya viene identificado por su número (ver ChatbotIdentityService)
 * o se valida con tres datos + código al titular (ver ChatAccessService). Una cédula
 * dictada por WhatsApp no prueba nada: está impresa en la factura que cualquiera ve.
 */
@Injectable()
export class TramitesToolset implements Toolset {
  private readonly logger = new Logger('TramitesToolset');

  constructor(
    private readonly subscribers: SubscribersService,
    private readonly cobranzas: CobranzasService,
    private readonly write: SupportWriteService,
  ) {}

  /**
   * Qué trámites se ofrecen. A un abonado, todos; a un número desconocido, solo los
   * que no exigen cuenta (afiliación, cobertura, PQR). Igual que en el resto del
   * chatbot, la barrera es que la capacidad no se declara —y además se re-comprueba
   * en `execute`, porque el modelo puede inventarse el nombre de una herramienta.
   */
  definitions(ctx: ToolContext): ToolDef[] {
    const sonda = esSonda(ctx);
    const esCliente = sonda || identityOf(ctx.user).kind === 'cliente';
    const pleno = sonda || tieneAccesoPleno(ctx.user);
    const tipos = (esCliente ? TRAMITE_SLUGS : TRAMITES_SIN_ABONADO).filter(
      (s) => pleno || !TRAMITES[s].exigeAccesoPleno,
    );

    return [
      {
        name: 'condiciones_de_tramite',
        description:
          'Costo, tiempos, condiciones y qué datos hay que pedir para un trámite. Consúltala ANTES de prometer ' +
          'cualquier cosa sobre un traslado, una suspensión, un cambio de plan, un cambio de titular, un equipo ' +
          'dañado o una afiliación: los costos y las reglas están aquí, no te los inventes ni los recuerdes de memoria.',
        input_schema: {
          type: 'object',
          properties: { tipo: { type: 'string', enum: tipos, description: 'Trámite que te están pidiendo' } },
          required: ['tipo'],
        },
      },
      {
        name: 'info_comercial',
        description:
          'Información comercial de la empresa que no está en los planes: costo y requisitos de la afiliación, ' +
          'descuento por pronto pago, horarios de atención, cómo pagar y entrar al portal, qué pasa con la mora ' +
          'y la reconexión, si hay cuotas, y cómo se cancela el servicio. Úsala en vez de responder de memoria.',
        input_schema: {
          type: 'object',
          properties: {
            tema: { type: 'string', enum: Object.keys(INFO_COMERCIAL), description: 'Tema que preguntan' },
          },
          required: ['tema'],
        },
      },
      {
        name: 'apps_incluidas',
        description:
          'Apps de entretenimiento que incluye cada nivel de plan (Standard, Premium, Premium Plus, Diamante) y ' +
          'la regla de los 2 meses de la app gratis. Úsala cuando pregunten "qué apps trae", "viene Disney", ' +
          '"qué pasa cuando se acaban los 2 meses".',
        input_schema: {
          type: 'object',
          properties: {
            nivel: {
              type: 'string',
              enum: Object.keys(APPS_POR_NIVEL),
              description: 'Nivel concreto. Sin nivel, devuelve todos.',
            },
          },
        },
      },
      {
        name: 'registrar_solicitud',
        description:
          'Registra en el sistema la solicitud del cliente y abre la orden de servicio que corresponda. Úsala para ' +
          'fallas de internet o televisión, cambio de nombre/clave del WiFi, cambio de plan, suspensión temporal, ' +
          'traslado, equipo dañado, cambio de titular, afiliación de un cliente nuevo, consulta de cobertura y PQR. ' +
          'Llámala SOLO cuando ya tengas los datos que pide condiciones_de_tramite: si falta alguno, el sistema te ' +
          'dirá cuál y no creará nada. El número de orden lo asigna el sistema y te lo devuelve esta herramienta: ' +
          'usa ESE número con el cliente y NUNCA te inventes uno. Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: tipos, description: 'Tipo de trámite' },
            descripcion: {
              type: 'string',
              description: 'Resumen de lo que pide el cliente, en sus palabras',
            },
            datos: {
              type: 'object',
              description:
                'Datos capturados, con las mismas claves que devuelve condiciones_de_tramite ' +
                '(ej. bombillo_rojo, wifi_clave, direccion_nueva, fecha_inicio, plan_interes)',
              additionalProperties: true,
            },
          },
          required: ['tipo', 'descripcion'],
        },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'condiciones_de_tramite':
        return safe(() => this.condiciones(input, ctx));
      case 'info_comercial':
        return safe(() => this.info(input));
      case 'apps_incluidas':
        return safe(() => this.apps(input));
      case 'registrar_solicitud':
        return safe(() => this.registrar(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  // ── Conocimiento ───────────────────────────────────────────────────────────

  private async condiciones(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const slug = this.slug(input.tipo);
    const def = TRAMITES[slug];
    if (!def) return this.tiposValidos(ctx);

    const permitido = this.permitido(slug, ctx);
    return [
      `${def.label}:`,
      def.costo ? `• Costo: ${def.costo}` : '',
      def.tiempo ? `• Tiempo: ${def.tiempo}` : '',
      `• ${def.guion}`,
      def.campos.length
        ? 'Datos que necesitas capturar (pregúntaselos DE A UNO, no todos de golpe):\n' +
          def.campos
            .map((c) => `  - ${c.nombre}${c.obligatorio ? ' (obligatorio)' : ' (opcional)'}: «${c.pregunta}»`)
            .join('\n')
        : '',
      permitido
        ? 'Cuando los tengas, regístralo con registrar_solicitud.'
        : 'OJO: este trámite necesita que la cuenta esté identificada. No se lo prometas todavía.',
    ].filter(Boolean).join('\n');
  }

  private async info(input: Record<string, unknown>): Promise<string> {
    const tema = String(input.tema ?? '').trim().toLowerCase();
    const t = INFO_COMERCIAL[tema];
    if (!t) return `No tengo ese tema. Los que tengo: ${Object.keys(INFO_COMERCIAL).join(', ')}.`;
    return `${t.titulo}: ${t.texto}`;
  }

  private async apps(input: Record<string, unknown>): Promise<string> {
    const nivel = input.nivel ? String(input.nivel).trim().toLowerCase() : '';
    const niveles = nivel && APPS_POR_NIVEL[nivel] ? [nivel] : Object.keys(APPS_POR_NIVEL);

    const bloques = niveles.map((n) => {
      const a = APPS_POR_NIVEL[n];
      return [
        `${a.label}:`,
        ...a.apps.map((app) => `  • ${app}`),
        a.permanente
          ? '  ✅ Todas incluidas de forma PERMANENTE, sin costo extra.'
          : '  🎁 El cliente elige UNA de estas apps gratis por 2 meses.',
      ].join('\n');
    });

    return [...bloques, REGLA_DOS_MESES].join('\n\n');
  }

  // ── Registro de la solicitud ───────────────────────────────────────────────

  /**
   * El corazón del port. Valida, aplica las reglas de negocio y abre la orden real.
   *
   * Pasa por confirmación como toda escritura del chatbot: lo que el cliente confirma
   * es el resumen literal con los datos capturados, así que un dato mal entendido por
   * el modelo ("me lo cambia a la Calle 15" → "Calle 50") se caza ANTES de crear la
   * orden y no cuando llega el técnico a la dirección equivocada.
   */
  private async registrar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const slug = this.slug(input.tipo);
    const def = TRAMITES[slug];
    if (!def) return this.tiposValidos(ctx);

    const id = identityOf(ctx.user);
    const esCliente = id.kind === 'cliente';

    // Barrera real (no solo "no se lo declaro"): un trámite sobre una cuenta no se
    // ejecuta para quien no tiene cuenta identificada, aunque el modelo invente el
    // nombre de la herramienta o el enum.
    if (!this.permitido(slug, ctx)) {
      // Dos motivos distintos, y se dicen distinto: confundirlos manda al cliente a
      // hacer un trámite que no le sirve.
      if (esCliente && def.exigeAccesoPleno) {
        return `«${def.label}» modifica el servicio, y eso no te lo puedo tramitar con la validación que hiciste. ` +
          'Explícale que por seguridad necesita el código que se le manda al WhatsApp del titular y ofrécele ' +
          'mandarlo con pedir_codigo_al_titular.';
      }
      return `No puedo registrar «${def.label}» desde un número que no reconocemos: ese trámite es sobre una ` +
        'cuenta. Ofrécele validarse con validar_mi_identidad (documento, nombre y celular del titular) o, si el ' +
        'servicio está a nombre de un familiar, pedir_acceso_a_una_cuenta.';
    }

    const descripcion = String(input.descripcion ?? '').trim();
    const datos = this.datos(input.datos);

    // ¿Están todos los datos que el trámite exige? Se devuelve la PREGUNTA que hay
    // que hacer, no un código de error: así el modelo la formula tal cual y no
    // improvisa una versión rara.
    const falta = def.campos.find((c) => c.obligatorio && !String(datos[c.nombre] ?? '').trim());
    if (falta) {
      return `Todavía no puedo registrarlo: falta «${falta.nombre}». Pregúntale exactamente esto y nada más: ` +
        `«${falta.pregunta}»`;
    }
    if (!descripcion) {
      return 'Necesito un resumen de lo que pide el cliente para poder registrarlo.';
    }
    // El cambio de WiFi es el único con todos los campos opcionales: sin nombre ni
    // clave la orden no dice nada y el técnico no sabe qué configurar.
    if (slug === 'cambio_wifi' && !datos.wifi_nombre && !datos.wifi_clave) {
      return 'Para el cambio de WiFi necesito al menos el nombre nuevo de la red o la contraseña nueva. ' +
        'Pregúntale cuál de las dos quiere cambiar.';
    }

    return esCliente
      ? this.registrarDeAbonado(def, slug, descripcion, datos, id.subscriberId, ctx)
      : this.registrarDeInteresado(def, slug, descripcion, datos, ctx);
  }

  /** Trámite de un abonado identificado: orden de servicio colgada de su cuenta. */
  private async registrarDeAbonado(
    def: TramiteDef,
    slug: string,
    descripcion: string,
    datos: Record<string, string>,
    subscriberId: string,
    ctx: ToolContext,
  ): Promise<string> {
    const detalle: any = await this.subscribers.detail(subscriberId);
    const tipo = this.tipoDeOrden(def, detalle);

    // Reglas de negocio contra datos reales, no contra lo que diga el cliente.
    const veto = await this.reglas(slug, datos, subscriberId, detalle);
    if (veto) return veto;

    // Anti-duplicado (la regla "post-radicado" de SAM). Va antes de la confirmación y
    // también en el commit, porque entre una y otra el cliente puede haber llamado.
    const abierta = this.ordenAbierta(detalle, tipo);
    if (abierta) {
      return `Ya tiene una orden abierta de «${tipo}»: la #${abierta.code} (${abierta.status}). ` +
        'Dile ese número, cuéntale que el área encargada la está revisando y NO abras otra.';
    }

    if (ctx.committing) {
      const r = await this.write.createTicket(
        {
          subscriberId,
          subject: `${def.label} (WhatsApp)`,
          type: tipo,
          problem: descripcion,
          section: this.seccion(def, descripcion, datos, ctx),
          priority: def.prioridad,
        } as any,
        BOT_ACTOR,
      );
      await ctx.audit({
        userId: ctx.user.id,
        action: 'support.ticket.create',
        summary: `Solicitud por WhatsApp: ${def.label} (orden #${r.code})`,
        detail: { ticketId: r.id, subscriberId, tramite: slug, tipo },
      });
      this.logger.log(`Solicitud ${slug} del abonado ${subscriberId} → orden #${r.code} (${tipo})`);
      return `Listo: quedó registrada la orden #${r.code}. Dile ese número al cliente. ${def.guion}`;
    }

    return ctx.preparePending({
      summary: `${def.label}: ${this.resumen(datos, descripcion)}. ` +
        `Se abre una orden de servicio a tu nombre${def.costo ? ` · costo: ${def.costo}` : ''}` +
        `${def.tiempo ? ` · ${def.tiempo}` : ''}.`,
      permission: CHAT_CLIENTE_PERMISSION,
      commitInput: { tipo: slug, descripcion, datos },
    });
  }

  /**
   * Trámite de alguien que todavía NO es cliente (afiliación, cobertura, PQR).
   *
   * Antes esto moría en `hablar_con_humano`: el interesado caía en la bandeja de
   * WhatsApp como un chat más, sin ningún registro estructurado. Si nadie lo leía ese
   * día, se perdía la venta y no quedaba rastro. Ahora queda una orden sin abonado,
   * con los datos capturados, y le llega al cargo que corresponde.
   */
  private async registrarDeInteresado(
    def: TramiteDef,
    slug: string,
    descripcion: string,
    datos: Record<string, string>,
    ctx: ToolContext,
  ): Promise<string> {
    const telefono = datos.telefono || phoneOf(ctx.user, ctx.convKey);

    if (ctx.committing) {
      const r = await this.write.createLeadTicket({
        subject: `${def.label} (WhatsApp)`,
        type: def.ticketType,
        problem: descripcion,
        section: this.seccion(def, descripcion, { ...datos, telefono }, ctx),
        priority: def.prioridad,
        post: def.cargo,
        actor: BOT_ACTOR,
      });
      await ctx.audit({
        userId: ctx.user.id,
        action: 'support.ticket.create',
        summary: `${def.label} de un número no registrado (orden #${r.code})`,
        detail: { ticketId: r.id, tramite: slug, telefono },
      });
      this.logger.log(`${def.label} de ${telefono} → orden #${r.code}`);
      return `Listo: quedó registrada con el número #${r.code}. Dáselo al cliente. ${def.guion}`;
    }

    return ctx.preparePending({
      summary: `${def.label}: ${this.resumen(datos, descripcion)}. ` +
        `Queda registrada para que un asesor lo contacte${def.costo ? ` · costo: ${def.costo}` : ''}.`,
      permission: CHAT_PUBLICO_PERMISSION,
      commitInput: { tipo: slug, descripcion, datos },
    });
  }

  // ── Reglas de negocio ──────────────────────────────────────────────────────

  /**
   * Las condiciones que SAM le contaba al cliente y nadie comprobaba. Devuelve el
   * texto del veto, o null si el trámite puede seguir.
   */
  private async reglas(
    slug: string,
    datos: Record<string, string>,
    subscriberId: string,
    detalle: any,
  ): Promise<string | null> {
    if (slug !== 'suspension') return null;

    // "Puede suspender el servicio si está al día con sus pagos": se mira la deuda
    // real. Prometerlo y que luego el área lo rechace es peor que decirlo de una.
    const deuda = await this.cobranzas.subscriberDebt(subscriberId);
    if (deuda.totalDebt > 0) {
      return `No se puede suspender: la cuenta tiene ${cop(deuda.totalDebt)} pendiente(s) y la suspensión ` +
        'temporal exige estar al día. Explícaselo con tacto y ofrécele el detalle de sus facturas.';
    }

    const inicio = this.fecha(datos.fecha_inicio);
    const fin = this.fecha(datos.fecha_fin);
    if (!inicio || !fin) {
      return 'No entendí las fechas de la suspensión. Pídeselas de nuevo con día, mes y año.';
    }
    if (fin <= inicio) {
      return 'La fecha de fin tiene que ser posterior a la de inicio. Confírmale las dos fechas.';
    }
    const tope = new Date(inicio);
    tope.setMonth(tope.getMonth() + MAX_MESES_SUSPENSION);
    if (fin > tope) {
      return `La línea se guarda por un máximo de ${MAX_MESES_SUSPENSION} meses. Con inicio el ` +
        `${inicio.toLocaleDateString('es-CO')}, la fecha de fin no puede pasar del ` +
        `${tope.toLocaleDateString('es-CO')}. Pídele otra fecha de fin.`;
    }

    // Suspender algo que ya está suspendido o cortado no tiene sentido.
    const estado = String(detalle?.status ?? '').toUpperCase();
    if (['SUSPENDIDO', 'CORTADO', 'RETIRADO'].includes(estado)) {
      return `El servicio ya figura ${estado}: no hay nada que suspender. Cuéntaselo y pregúntale qué necesita.`;
    }
    return null;
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────

  /**
   * El tipo de orden con el que nace la solicitud. Para la suspensión depende de qué
   * tenga contratado, porque el ERP tiene una por servicio y al cerrarla corta lo
   * suyo (ver `applyCloseCascade`): suspender el combo de quien solo tiene internet
   * cortaría una televisión que no existe.
   */
  private tipoDeOrden(def: TramiteDef, detalle: any): string {
    if (!def.ticketTypePorServicio) return def.ticketType;
    const kinds = new Set(
      ((detalle?.services ?? []) as Array<{ kind?: string }>).map((s) => String(s.kind ?? '').toUpperCase()),
    );
    const internet = kinds.has('INTERNET');
    const tv = kinds.has('TV');
    if (internet && tv) return def.ticketTypePorServicio.combo;
    if (tv) return def.ticketTypePorServicio.tv;
    return def.ticketTypePorServicio.internet;
  }

  /**
   * ¿Ya hay una orden abierta del mismo tipo?
   *
   * OJO con el nombre del campo: `SubscribersService.detail()` devuelve las órdenes en
   * `workOrders`, no en `tickets`.
   */
  private ordenAbierta(detalle: any, tipo: string): { code: number; status: string } | null {
    const ordenes = (detalle?.workOrders ?? []) as Array<{ code: number; type: string; status: string }>;
    const abierta = ordenes.find(
      (t) => String(t.type ?? '').toLowerCase() === tipo.toLowerCase() && !CERRADOS.has(String(t.status).toUpperCase()),
    );
    return abierta ? { code: abierta.code, status: abierta.status } : null;
  }

  /** Detalle largo de la orden: lo que verá quien la atienda en /soporte. */
  private seccion(
    def: TramiteDef,
    descripcion: string,
    datos: Record<string, string>,
    ctx: ToolContext,
  ): string {
    const capturados = Object.entries(datos)
      .filter(([, v]) => String(v ?? '').trim())
      .map(([k, v]) => `${k}: ${v}`);
    return [
      `[Bot WhatsApp] ${def.label} · ${phoneOf(ctx.user, ctx.convKey)}`,
      descripcion,
      capturados.length ? capturados.join(' | ') : '',
    ].filter(Boolean).join('\n').slice(0, 1500);
  }

  /** Resumen de los datos capturados para que el cliente confirme lo que entendió el bot. */
  private resumen(datos: Record<string, string>, descripcion: string): string {
    const partes = Object.entries(datos)
      .filter(([, v]) => String(v ?? '').trim())
      .map(([k, v]) => `${k.replace(/_/g, ' ')} «${v}»`);
    return partes.length ? partes.join(', ') : descripcion;
  }

  /** ¿Puede este interlocutor pedir este trámite? */
  private permitido(slug: string, ctx: ToolContext): boolean {
    const def = TRAMITES[slug];
    if (!def) return false;
    if (def.exigeAccesoPleno && !tieneAccesoPleno(ctx.user)) return false;
    if (!def.requiereAbonado) return true;
    return identityOf(ctx.user).kind === 'cliente';
  }

  private tiposValidos(ctx: ToolContext): string {
    const tipos = (identityOf(ctx.user).kind === 'cliente' ? TRAMITE_SLUGS : TRAMITES_SIN_ABONADO).filter(
      (s) => tieneAccesoPleno(ctx.user) || !TRAMITES[s].exigeAccesoPleno,
    );
    return `No conozco ese trámite. Los que puedo registrar aquí: ${tipos.join(', ')}.`;
  }

  private slug(v: unknown): string {
    return String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  /** `datos` llega del modelo: puede ser objeto, JSON en texto, o nada. */
  private datos(v: unknown): Record<string, string> {
    let obj: unknown = v;
    if (typeof v === 'string') {
      try { obj = JSON.parse(v); } catch { obj = {}; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, val]) => [k, String(val ?? '').trim()]),
    );
  }

  /**
   * Fecha dictada por chat. El modelo suele mandar YYYY-MM-DD, pero un cliente dice
   * "el 15 de agosto" y puede llegar 15/08/2026: se aceptan las dos formas y se
   * construye la fecha a mano para no depender de cómo interprete `Date` un
   * DD/MM/YYYY (lo lee como MM/DD y "el 15/08" se vuelve inválido).
   */
  private fecha(v: string | undefined): Date | null {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (iso) return this.armar(+iso[1], +iso[2], +iso[3]);
    const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
    if (dmy) return this.armar(+dmy[3], +dmy[2], +dmy[1]);
    return null;
  }

  private armar(anio: number, mes: number, dia: number): Date | null {
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    // Descarta un 31 de febrero, que `Date` desplazaría al 3 de marzo sin avisar.
    return d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? d : null;
  }
}
