import { Injectable, Logger } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { SubscribersService } from '../../subscribers/subscribers.service';
import { CobranzasService } from '../../treasury/cobranzas.service';
import { MikrotikService } from '../../network/mikrotik.service';
import { SubscriberContactsService } from '../subscriber-contacts.service';
import { ChatAccessService } from '../chat-access.service';
import { ChatbotDocsService, enviarDoc } from '../chatbot-docs.service';
import { CHAT_CLIENTE_PERMISSION, subscriberIdOf, tieneAccesoPleno } from '../chatbot.identity';
import { ChatbotSessionStore } from '../chatbot-session.store';
import { cop, esSonda, fecha, safe } from './toolset.util';

/**
 * Herramientas que exponen la cuenta y por tanto exigen acceso PLENO: ser el titular,
 * estar autorizado por él, o haber confirmado el código que se le manda a su celular.
 *
 * No basta con no declarárselas a quien tiene acceso básico (eso solo evita que el
 * modelo las vea): si el modelo se inventa el nombre, el motor igual encuentra la
 * herramienta en su enrutador y la ejecuta. Esta lista es la barrera de verdad.
 */
const EXIGEN_ACCESO_PLENO = new Set([
  'mis_facturas', 'enviar_mi_factura', 'mi_plan', 'mis_pagos',
  'numeros_autorizados', 'autorizar_numero', 'quitar_numero_autorizado',
  // Los tres documentos llevan impresos la dirección, el documento y el movimiento
  // completo de la cuenta: son justo lo que no se le da a quien solo acertó los datos
  // que están en la factura.
  'enviar_mi_estado_de_cuenta', 'enviar_mi_paz_y_salvo', 'enviar_mi_contrato',
]);

/**
 * Herramientas del abonado. TODAS operan sobre el `subscriberId` que resolvió el
 * IdentityResolver a partir del teléfono que escribe — nunca sobre un id que venga
 * del modelo o del mensaje. Es la garantía de que un cliente no puede leer la
 * cuenta de otro pidiéndolo por chat, aunque el modelo se deje convencer.
 */
@Injectable()
export class ClienteToolset implements Toolset {
  private readonly logger = new Logger('ClienteToolset');

  constructor(
    private readonly subscribers: SubscribersService,
    private readonly cobranzas: CobranzasService,
    private readonly store: ChatbotSessionStore,
    private readonly mikrotik: MikrotikService,
    private readonly contactos: SubscriberContactsService,
    private readonly access: ChatAccessService,
    private readonly docs: ChatbotDocsService,
  ) {}

  /**
   * Qué se le ofrece a quien escribe.
   *
   * A un titular (o a quien él autorizó) se le ofrece todo. A quien entró con la
   * validación por DATOS —documento, nombre y teléfono, que están impresos en la
   * factura— se le ofrece solo lo que no expone la cuenta si resultó ser otra
   * persona: nada de PDF con la dirección, historial de pagos ni repartir accesos.
   * Lo que no se declara, el modelo ni lo ve.
   */
  definitions(ctx: ToolContext): ToolDef[] {
    // Ante la sonda con la que el motor arma su enrutador se declara TODO (si no,
    // las herramientas que falten no se podrán ejecutar nunca); ante una persona
    // real manda su nivel de acceso. Mismo criterio que en `combineToolsets`.
    const sonda = esSonda(ctx);
    const pleno = sonda || tieneAccesoPleno(ctx.user);
    const basico = sonda || !pleno;
    return [
      {
        name: 'mi_estado_de_cuenta',
        description:
          'Saldo y facturas pendientes del cliente que escribe: cuánto debe, de qué facturas y cuándo vencen.',
        input_schema: { type: 'object', properties: {} },
      },
      ...(pleno ? [{
        name: 'mis_facturas',
        description: 'Últimas facturas del cliente que escribe, con su número, fecha, total y estado.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'enviar_mi_factura',
        description:
          'Envía por este chat el PDF de una factura del cliente. Sin número de factura, envía la más reciente.',
        input_schema: {
          type: 'object',
          properties: {
            numero: { type: 'string', description: 'Número (tid) de la factura. Opcional: por defecto la última.' },
          },
        },
      },
      {
        name: 'mi_plan',
        description: 'Plan(es) y servicios contratados por el cliente que escribe, con su valor mensual y estado.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'mis_pagos',
        description: 'Últimos pagos registrados del cliente que escribe.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'enviar_mi_estado_de_cuenta',
        description:
          'Envía por este chat el PDF del estado de cuenta del cliente: cargos, abonos y saldo corrido. ' +
          'Úsala cuando pida "el estado de cuenta", "el movimiento de mi cuenta", "todo lo que he pagado" ' +
          'o cuando discuta un saldo y necesite ver el detalle.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'enviar_mi_paz_y_salvo',
        description:
          'Envía el certificado de paz y salvo del cliente. Se lo piden para trámites (arriendos, subsidios, ' +
          'cambio de operador). Solo sale si está al día: si debe, la herramienta te lo dice y NO manda nada.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'enviar_mi_contrato',
        description:
          'Envía el PDF del contrato de prestación de servicios del cliente. Úsala cuando pida "mi contrato", ' +
          '"el contrato que firmé" o los términos de su servicio.',
        input_schema: { type: 'object', properties: {} },
      }] : []),
      {
        name: 'estado_de_mi_servicio',
        description:
          'Diagnostica por qué el cliente no tiene servicio: si está cortado por mora (y cuánto debe), ' +
          'si su conexión está activa en la red, y si ya tiene un reporte de soporte abierto. ' +
          'Úsala SIEMPRE que el cliente diga que no le funciona el internet, que está lento, que se le cayó ' +
          'o que le cortaron, ANTES de ofrecerle abrir un reporte.',
        input_schema: { type: 'object', properties: {} },
      },
      ...(pleno ? [{
        name: 'numeros_autorizados',
        description:
          'Números de WhatsApp que el cliente autorizó a gestionar su cuenta (familiares), y las ' +
          'solicitudes que están esperando su respuesta. Úsala si pregunta "quién puede ver mi cuenta" ' +
          'o si hay que resolver una solicitud pendiente.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'autorizar_numero',
        description:
          'Autoriza a otro número de WhatsApp (un hijo, la esposa, quien paga el arriendo) a consultar y ' +
          'gestionar ESTA cuenta. Úsala cuando el cliente diga "autoriza el 300…", "que mi hija pueda ' +
          'preguntar por la factura". Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            telefono: { type: 'string', description: 'Celular a autorizar, ej. 3001234567' },
            nombre: { type: 'string', description: 'Nombre de la persona' },
            relacion: { type: 'string', description: 'Parentesco: hijo, esposa, arrendatario…' },
          },
          required: ['telefono'],
        },
      },
      {
        name: 'quitar_numero_autorizado',
        description: 'Le quita a un número el permiso de gestionar esta cuenta. Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: { telefono: { type: 'string', description: 'Celular a revocar' } },
          required: ['telefono'],
        },
      }] : []),
      ...(basico ? [{
        name: 'pedir_codigo_al_titular',
        description:
          'Manda un código de 6 dígitos al WhatsApp que el titular tiene registrado. Úsalo cuando quien ' +
          'escribe pida algo que no puedes darle con la validación básica (el PDF de una factura, sus ' +
          'pagos, autorizar números): con ese código queda con acceso completo.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'confirmar_codigo_del_titular',
        description: 'Comprueba el código de 6 dígitos que le llegó al titular y da acceso completo.',
        input_schema: {
          type: 'object',
          properties: { codigo: { type: 'string', description: 'Los 6 dígitos' } },
          required: ['codigo'],
        },
      }] : []),
      // Las fallas y los demás trámites los abre `registrar_solicitud` (ver
      // TramitesToolset), que nace con el TIPO de orden real del ERP —"Revision de
      // Internet", "Revision de television"— en vez del genérico "Soporte" que ponía
      // la herramienta que había aquí, y que no aparece en ningún filtro ni reporte
      // del equipo. Se retiró en vez de dejar las dos: con dos herramientas para lo
      // mismo, el modelo elige a medias y la mitad de las averías se pierden en un
      // tipo que nadie mira. No se había usado nunca en producción (0 órdenes).
      {
        name: 'mis_tickets_soporte',
        description: 'Estado de los reportes/tickets de soporte abiertos del cliente que escribe.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'hablar_con_humano',
        description:
          'Pasa la conversación a una persona del equipo. Úsala cuando el cliente lo pida, cuando se queje ' +
          'de la atención, cuando esté molesto, o cuando necesite algo que no puedes resolver con tus otras ' +
          'herramientas (negociar un acuerdo de pago, reclamar un cobro, cancelar el servicio). ' +
          'A partir de ese momento dejas de responder en este chat: contesta una persona. No la uses para ' +
          'preguntas que sí puedes resolver.',
        input_schema: {
          type: 'object',
          properties: {
            motivo: {
              type: 'string',
              description: 'Qué necesita el cliente, en pocas palabras, para que quien lo atienda no empiece de cero',
            },
          },
          required: ['motivo'],
        },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    // Cinturón y tirantes: este toolset solo lo monta el agente de clientes, pero si
    // algún día se cablea mal, el permiso sintético lo detiene igual.
    if (!ctx.can(CHAT_CLIENTE_PERMISSION)) return PERMISSION_DENIED;

    // Segunda barrera del acceso por niveles: lo que expone la cuenta no se ejecuta
    // para quien solo acertó los datos de la factura, se lo hayan ofrecido o no.
    if (EXIGEN_ACCESO_PLENO.has(name) && !tieneAccesoPleno(ctx.user)) {
      return 'Eso no te lo puedo dar con la validación que hiciste: expone datos de la cuenta. ' +
        'Manda el código al WhatsApp del titular con pedir_codigo_al_titular y, cuando lo confirmes, te lo doy.';
    }

    const id = subscriberIdOf(ctx.user);

    switch (name) {
      case 'mi_estado_de_cuenta':
        return safe(() => this.estadoCuenta(id, tieneAccesoPleno(ctx.user)));
      case 'mis_facturas':
        return safe(() => this.facturas(id));
      case 'enviar_mi_factura':
        return safe(() => this.enviarFactura(id, input, ctx));
      case 'enviar_mi_estado_de_cuenta':
        return safe(async () => enviarDoc(ctx, await this.docs.estadoCuenta(id)));
      case 'enviar_mi_paz_y_salvo':
        return safe(() => this.enviarPazYSalvo(id, ctx));
      case 'enviar_mi_contrato':
        return safe(async () => enviarDoc(ctx, await this.docs.contrato(id)));
      case 'mi_plan':
        return safe(() => this.plan(id));
      case 'mis_pagos':
        return safe(() => this.pagos(id));
      case 'estado_de_mi_servicio':
        return safe(() => this.diagnostico(id));
      case 'pedir_codigo_al_titular':
        return safe(() => this.pedirCodigo(ctx));
      case 'confirmar_codigo_del_titular':
        return safe(() => this.confirmarCodigo(input, ctx));
      case 'numeros_autorizados':
        return safe(() => this.autorizados(id));
      case 'autorizar_numero':
        return safe(() => this.autorizar(id, input, ctx));
      case 'quitar_numero_autorizado':
        return safe(() => this.revocar(id, input, ctx));
      case 'mis_tickets_soporte':
        return safe(() => this.tickets(id));
      case 'hablar_con_humano':
        return safe(() => this.escalar(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  /**
   * Con acceso básico se dice CUÁNTO se debe y nada más.
   *
   * El desglose factura por factura (números, fechas de vencimiento, saldos) es el
   * mapa de la cuenta: le sirve a quien quiera hacerse pasar por el cliente en otro
   * canal. El total, en cambio, es justo lo que necesita el hijo que llama a
   * preguntar por qué le cortaron a su papá.
   */
  private async estadoCuenta(id: string, pleno = true): Promise<string> {
    const d = await this.cobranzas.subscriberDebt(id);
    if (!pleno) {
      return d.totalDebt > 0
        ? `La cuenta tiene ${cop(d.totalDebt)} pendiente(s) en ${d.invoices.length} factura(s). ` +
          'Para ver el detalle o el PDF de cada factura hace falta el código que se le manda al titular.'
        : 'La cuenta está al día: no tiene facturas pendientes.';
    }
    if (!d.invoices.length) {
      return `Estás al día, no tienes facturas pendientes.` +
        (d.balance ? ` Además tienes un saldo a favor de ${cop(d.balance)}.` : '');
    }
    const lineas = d.invoices.map(
      (i) => `• Factura ${i.tid}: debes ${cop(i.balance)} de ${cop(i.total)} · vence ${fecha(i.dueDate)}`,
    );
    return [
      `Tienes ${cop(d.totalDebt)} pendiente(s) en ${d.invoices.length} factura(s):`,
      ...lineas,
      d.balance ? `Saldo a favor: ${cop(d.balance)}` : '',
    ].filter(Boolean).join('\n');
  }

  private async facturas(id: string): Promise<string> {
    const rows: any[] = await this.subscribers.invoices(id);
    if (!rows.length) return 'No tienes facturas registradas.';
    return rows.slice(0, 5)
      .map((i) => `• Factura ${i.tid} · ${fecha(i.invoiceDate)} · ${cop(i.total)} · ${i.status}` +
        `${i.balance ? ` · pendiente ${cop(i.balance)}` : ' · pagada'}`)
      .join('\n');
  }

  private async enviarFactura(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const rows: any[] = await this.subscribers.invoices(id);
    if (!rows.length) return 'No tienes facturas registradas.';

    const pedido = input.numero ? String(input.numero).replace(/\D/g, '') : '';
    // Se busca SOLO entre las facturas de este abonado: un número de otro cliente
    // simplemente no aparece aquí.
    const inv = pedido ? rows.find((i) => String(i.tid) === pedido) : rows[0];
    if (!inv) return `No encontré la factura ${pedido} entre tus facturas.`;

    return enviarDoc(ctx, await this.docs.factura(inv.id));
  }

  /**
   * El paz y salvo solo se manda si de verdad está al día.
   *
   * El generador sabe redactarlo en negativo ("NO se encuentra a paz y salvo"), y
   * mandarle ESE papel a alguien que pidió un certificado para un trámite es peor que
   * no mandarle nada: se lo lleva a donde lo pidieron sin leerlo. Si debe, se le dice
   * cuánto y se le ofrece el estado de cuenta, que es el documento que sí le sirve.
   */
  private async enviarPazYSalvo(id: string, ctx: ToolContext): Promise<string> {
    const doc = await this.docs.pazYSalvo(id);
    if (!doc.alDia) {
      return `No se puede expedir el paz y salvo: la cuenta tiene ${cop(doc.saldo)} pendiente(s). ` +
        'Explícaselo con tacto, dile el monto exacto y ofrécele el estado de cuenta o el PDF de la factura ' +
        'para que vea el detalle. NO le mandes el certificado.';
    }
    return enviarDoc(ctx, doc);
  }

  private async plan(id: string): Promise<string> {
    const s: any = await this.subscribers.detail(id);
    const servicios: any[] = s.services ?? [];
    if (!servicios.length) return 'No tienes servicios activos registrados.';
    const lineas = servicios.map(
      (sv) => `• ${sv.kind}: ${sv.planName ?? '—'} — ${cop(sv.price)}/mes (${sv.status ?? '—'})`,
    );
    return `Tu(s) servicio(s):\n${lineas.join('\n')}`;
  }

  private async pagos(id: string): Promise<string> {
    const st: any = await this.subscribers.statement(id);
    const abonos = (st.movements ?? []).filter((m: any) => (m.type ?? m.kind) === 'ABONO' || m.credit > 0);
    if (!abonos.length) return 'No tengo pagos registrados en tu cuenta.';
    return abonos.slice(0, 5)
      .map((m: any) => `• ${fecha(m.date)} · ${cop(m.credit ?? m.amount)}${m.note ? ` — ${m.note}` : ''}`)
      .join('\n');
  }

  /**
   * "No tengo internet": la pregunta más frecuente del canal, y la que hoy consume
   * una llamada. Junta en un solo texto las tres causas que explican casi todos los
   * casos, en el orden en que hay que descartarlas:
   *
   *  1. **Corte por mora** — es la respuesta la mayoría de las veces y la única que
   *     el cliente puede resolver solo. Va primero: mandar a reiniciar el router a
   *     quien tiene el servicio cortado es hacerle perder el tiempo a los dos.
   *  2. **Estado de la conexión en el router** — distingue "el problema es de la
   *     casa" (sesión caída: router apagado, cable suelto) de "el problema es
   *     nuestro" (sesión activa y aun así no navega).
   *  3. **Reporte ya abierto** — si un técnico ya está en camino, decírselo evita el
   *     ticket duplicado y la llamada de "¿en qué va lo mío?".
   *
   * El módulo de red puede estar en dry-run o el router no responder: en ese caso se
   * omite ese punto en vez de fallar. Un diagnóstico incompleto sigue sirviendo; una
   * herramienta que se cae deja al cliente sin respuesta.
   */
  private async diagnostico(id: string): Promise<string> {
    const [s, deuda] = await Promise.all([
      this.subscribers.detail(id) as Promise<any>,
      this.cobranzas.subscriberDebt(id),
    ]);

    const partes: string[] = [];
    const estado = String(s.status ?? '').toUpperCase();
    const cortadoPorMora = ['CORTADO', 'CARTERA', 'SUSPENDIDO'].includes(estado);

    if (cortadoPorMora) {
      partes.push(
        `El servicio está SUSPENDIDO por falta de pago (estado ${estado}).` +
        (deuda.totalDebt > 0 ? ` Saldo pendiente: ${cop(deuda.totalDebt)}.` : '') +
        ' Se reactiva cuando se registre el pago. Dile esto con tacto y ofrécele el detalle de sus facturas o el PDF.',
      );
    } else {
      partes.push(`El servicio figura ${estado || 'activo'} y al día para navegar.`);
      if (deuda.totalDebt > 0) {
        partes.push(`(Tiene ${cop(deuda.totalDebt)} pendiente, pero eso NO es lo que le impide navegar hoy.)`);
      }
    }

    // Solo se consulta el router cuando el corte por mora no explica ya la falla.
    if (!cortadoPorMora) {
      try {
        const r = await this.mikrotik.liveStatus(id);
        if (r.dryRun) {
          partes.push('(No se pudo revisar la conexión en la red: el módulo está en modo simulación.)');
        } else if (r.live?.sessionActive) {
          partes.push(
            'Su conexión SÍ está activa en nuestra red ahora mismo. Entonces la falla está entre el router y sus ' +
            'equipos: pídele que revise los cables, que reinicie el router (desconectarlo 30 segundos) y que pruebe ' +
            'con un solo equipo. Si sigue igual, ofrécele reportar la falla.',
          );
        } else if (r.live?.secretDisabled) {
          partes.push('Su usuario está deshabilitado en el router (corte administrativo). Ofrécele hablar con una persona.');
        } else {
          partes.push(
            'Su conexión NO aparece activa en nuestra red: el router de la casa está apagado, sin luz o desconectado ' +
            'de la fibra. Pídele que verifique que el equipo tenga corriente y las luces encendidas, y que lo reinicie. ' +
            'Si todo está encendido y sigue sin aparecer, ofrécele reportar la falla.',
          );
        }
      } catch (e) {
        // El router puede estar caído o el abonado sin PPPoE configurado: ni se
        // inventa un diagnóstico ni se rompe la conversación.
        this.logger.warn(`No se pudo leer el estado de red del abonado ${id}: ${(e as Error).message}`);
        partes.push('(No se pudo verificar la conexión en la red en este momento.)');
      }
    }

    // OJO con el nombre: `detail()` devuelve las órdenes en `workOrders`. Esto leía
    // `s.tickets`, que NO existe en su respuesta, así que el aviso de "ya tiene un
    // reporte abierto" nunca salía y el bot abría un ticket duplicado por cada vez
    // que el cliente volvía a escribir.
    const abiertos = (s.workOrders ?? []).filter((t: any) => !['ANULADA', 'RESUELTO', 'CERRADA', 'SOLUCIONADA'].includes(String(t.status).toUpperCase()));
    if (abiertos.length) {
      const t = abiertos[0];
      partes.push(`YA tiene un reporte abierto: #${t.code} (${t.status}) del ${fecha(t.created)}. Menciónaselo y NO abras otro.`);
    }

    return partes.join('\n');
  }

  /**
   * Pasa la conversación a una persona: marca el handoff y el bot deja de responder
   * aquí (lo corta el gate en el transporte, antes del motor). El mensaje entrante se
   * sigue registrando, así que el equipo lo atiende desde el visor de conversaciones,
   * igual que antes de que el bot existiera.
   *
   * NO pide confirmación, a diferencia de las escrituras: lo pidió el cliente, y
   * repreguntarle "¿seguro que quieres un humano?" a alguien que ya está molesto es
   * exactamente lo que no hay que hacer. Además falla del lado bueno — si el modelo la
   * invoca de más, el resultado es que atiende una persona; se devuelve al bot desde
   * Configuración con un clic.
   */
  private async escalar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const motivo = String(input.motivo ?? '').trim() || 'El cliente pidió hablar con una persona';
    await this.store.setHandoff(ctx.convKey, motivo);
    await ctx.audit({
      userId: ctx.user.id,
      action: 'chatbot.handoff',
      summary: `El cliente pidió hablar con una persona — ${motivo}`,
      detail: { convKey: ctx.convKey, motivo },
    });
    this.logger.log(`Handoff pedido en ${ctx.convKey}: ${motivo}`);
    return 'Listo: le avisé al equipo y una persona le va a escribir por este mismo chat. '
      + 'Despídete y NO sigas respondiendo consultas en este chat.';
  }

  /**
   * Pide el código que sube de acceso básico a completo. El código NO llega a quien
   * lo pide: llega al WhatsApp que el titular tiene registrado, que es lo único que
   * de verdad prueba algo.
   */
  private async pedirCodigo(ctx: ToolContext): Promise<string> {
    const phone = ctx.convKey.split(':')[1] ?? '';
    const r = await this.access.pedirCodigo(phone);
    if (!r.ok) return r.error;
    return `Le mandé un código de 6 dígitos al WhatsApp del titular (${r.destino}). ` +
      'Pídeselo y escríbemelo aquí. Vence en 10 minutos.';
  }

  private async confirmarCodigo(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const phone = ctx.convKey.split(':')[1] ?? '';
    const r = await this.access.confirmarCodigo(phone, String(input.codigo ?? ''));
    if (!r.ok) return r.error;
    await ctx.audit({
      userId: ctx.user.id, action: 'chatbot.acceso.verificado',
      summary: `El número ${phone} confirmó el código del titular (acceso completo)`,
      detail: { subscriberId: subscriberIdOf(ctx.user), phone },
    });
    return 'Código correcto. Ya tienes acceso completo a la cuenta por 12 horas: dile qué necesitaba y resuélveselo.';
  }

  /**
   * Quién más puede gestionar la cuenta, y qué solicitudes esperan respuesta.
   *
   * Las pendientes van PRIMERO y con el número completo: es lo único accionable de la
   * lista, y el titular necesita ver el número entero para reconocerlo antes de decir
   * que sí.
   */
  private async autorizados(id: string): Promise<string> {
    const rows = await this.contactos.list(id);
    if (!rows.length) return 'Nadie más está autorizado a gestionar tu cuenta, y no hay solicitudes pendientes.';

    const pendientes = rows.filter((r) => r.status === 'PENDIENTE');
    const activos = rows.filter((r) => r.status === 'ACTIVO');
    return [
      pendientes.length
        ? 'ESPERANDO TU RESPUESTA:\n' + pendientes.map(
            (r) => `• ${r.phone}${r.name ? ` — ${r.name}` : ''}${r.relation ? ` (${r.relation})` : ''}`,
          ).join('\n') + '\nDile al cliente que puede autorizarlos o ignorarlos.'
        : '',
      activos.length
        ? 'AUTORIZADOS:\n' + activos.map(
            (r) => `• ${r.phone}${r.name ? ` — ${r.name}` : ''}${r.relation ? ` (${r.relation})` : ''}`,
          ).join('\n')
        : 'No hay ningún número autorizado todavía.',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Autoriza a un familiar. Pasa por confirmación como cualquier escritura: dar
   * acceso a la propia cuenta —saldo, facturas, reportes— no puede depender de que
   * el modelo haya entendido bien un número dictado por chat.
   */
  private async autorizar(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const telefono = String(input.telefono ?? '').trim();
    const nombre = input.nombre ? String(input.nombre).trim() : undefined;
    const relacion = input.relacion ? String(input.relacion).trim() : undefined;

    if (ctx.committing) {
      const r = await this.contactos.autorizar(id, telefono, {
        nombre, relacion,
        // Queda registrado quién autorizó: es la conversación del titular.
        aprobadoPor: `titular (${ctx.convKey})`,
      });
      if (!r.ok) return r.error;
      await ctx.audit({
        userId: ctx.user.id, action: 'chatbot.contacto.autorizar',
        summary: `Autorizó el número ${telefono} en su cuenta`, detail: { subscriberId: id, telefono },
      });
      return `Listo: ${telefono} ya puede consultar y gestionar tu cuenta por WhatsApp. Le avisamos.`;
    }

    if (!telefono) return 'Dime el número de celular que quieres autorizar.';
    return ctx.preparePending({
      summary: `Autorizar al número ${telefono}${nombre ? ` (${nombre}${relacion ? `, ${relacion}` : ''})` : ''} ` +
        'para consultar y gestionar tu cuenta por WhatsApp: verá tus facturas, tu saldo y podrá reportar fallas.',
      permission: CHAT_CLIENTE_PERMISSION,
      commitInput: { telefono, nombre, relacion },
    });
  }

  private async revocar(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const telefono = String(input.telefono ?? '').trim();
    if (ctx.committing) {
      const r = await this.contactos.revocar(id, telefono);
      if (!r.ok) return r.error;
      await ctx.audit({
        userId: ctx.user.id, action: 'chatbot.contacto.revocar',
        summary: `Quitó el acceso al número ${telefono}`, detail: { subscriberId: id, telefono },
      });
      return `Listo: ${telefono} ya no puede gestionar tu cuenta.`;
    }
    if (!telefono) return 'Dime el número al que quieres quitarle el acceso.';
    return ctx.preparePending({
      summary: `Quitarle al número ${telefono} el permiso de gestionar tu cuenta.`,
      permission: CHAT_CLIENTE_PERMISSION,
      commitInput: { telefono },
    });
  }

  /** Los tickets salen de la ficha del propio abonado, no del listado global. */
  private async tickets(id: string): Promise<string> {
    const s: any = await this.subscribers.detail(id);
    // `workOrders`, no `tickets`: ver la nota en `diagnostico()`. Leyendo la clave
    // equivocada esta herramienta contestaba "no tienes reportes registrados" a
    // clientes que sí los tenían.
    const abiertos = (s.workOrders ?? []).filter((t: any) => t.status !== 'ANULADA');
    if (!abiertos.length) return 'No tienes reportes de soporte registrados.';
    return abiertos.slice(0, 5)
      .map((t: any) => `• Reporte #${t.code}: ${t.subject} — ${t.status} (${fecha(t.created)})`)
      .join('\n');
  }
}
