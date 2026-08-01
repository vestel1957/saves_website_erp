import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PlansService } from '../../plans/plans.service';
import { ConfigDataService } from '../../config/config.service';
import { ChatbotGateService } from '../chatbot-gate.service';
import { SubscriberContactsService } from '../subscriber-contacts.service';
import { ChatAccessService } from '../chat-access.service';
import { ChatbotSessionStore } from '../chatbot-session.store';
import { phoneOf } from '../chatbot.identity';
import { PLANES_COMERCIALES } from '../tramites.catalogo';
import { cop, safe } from './toolset.util';

/**
 * Herramientas para números NO registrados (ni funcionario ni abonado).
 *
 * Solo información comercial pública: planes, sedes y datos de la empresa. No hay
 * ninguna herramienta que reciba un identificador de cliente, así que este agente
 * no tiene forma de tocar datos de una cuenta ni aunque el modelo lo intente: la
 * barrera es que la capacidad no existe, no que el prompt lo prohíba.
 */
@Injectable()
export class PublicoToolset implements Toolset {
  constructor(
    private readonly plans: PlansService,
    private readonly config: ConfigDataService,
    private readonly gate: ChatbotGateService,
    private readonly contactos: SubscriberContactsService,
    private readonly access: ChatAccessService,
    private readonly store: ChatbotSessionStore,
  ) {}

  definitions(_ctx: ToolContext): ToolDef[] {
    return [
      {
        name: 'planes_disponibles',
        description: 'Planes que la empresa ofrece hoy, con su velocidad y precio mensual.',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', description: 'Filtrar por tipo de servicio (ej. INTERNET, TV). Opcional.' },
          },
        },
      },
      {
        name: 'sedes',
        description: 'Sedes/oficinas de la empresa con su dirección, para atención presencial.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'datos_empresa',
        description: 'Datos de contacto de la empresa: nombre, dirección, teléfono y correo.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'validar_mi_identidad',
        description:
          'Valida a quien escribe contra los datos de la cuenta para poder atenderlo. Pide los TRES: número ' +
          'de documento del TITULAR, su nombre completo y el celular que tiene registrado con nosotros. ' +
          'Úsala cuando alguien escriba desde un número que no reconocemos y necesite algo de una cuenta ' +
          '(saber si está cortado, cuánto debe, reportar una falla o pedir una visita). ' +
          'Si acierta, queda habilitado para eso; el PDF de facturas y los cambios exigen después un código.',
        input_schema: {
          type: 'object',
          properties: {
            documento: { type: 'string', description: 'Número de documento del titular, sin puntos' },
            nombre: { type: 'string', description: 'Nombre completo del titular' },
            telefono_titular: { type: 'string', description: 'Celular que el titular tiene registrado' },
          },
          required: ['documento', 'nombre', 'telefono_titular'],
        },
      },
      {
        name: 'pedir_acceso_a_una_cuenta',
        description:
          'Pide permiso para gestionar la cuenta de un cliente desde ESTE número. Úsala cuando quien escribe ' +
          'dice que el servicio es de un familiar (su papá, su mamá, su esposo) o que él paga pero la cuenta ' +
          'está a nombre de otro. NO entrega ningún dato: le manda la solicitud al titular para que la ' +
          'autorice desde su propio WhatsApp. Necesita el número de abonado, que está en la factura.',
        input_schema: {
          type: 'object',
          properties: {
            abonado: { type: 'number', description: 'Número de abonado que aparece en la factura' },
            nombre: { type: 'string', description: 'Cómo se llama quien pide' },
            relacion: { type: 'string', description: 'Qué es del titular: hijo, esposa, arrendatario…' },
          },
          required: ['abonado'],
        },
      },
      {
        name: 'hablar_con_humano',
        description:
          'Pasa la conversación a una persona del equipo. Úsala cuando quien escribe lo pida, cuando se ' +
          'moleste, o cuando necesite algo que tú no puedes resolver: contratar un servicio, una queja, un ' +
          'trámite, o cualquier pregunta que no cubran tus otras herramientas. A partir de ese momento dejas ' +
          'de responder en este chat: contesta una persona. No la uses para lo que sí puedes resolver ' +
          '(planes, precios, sedes y datos de la empresa).',
        input_schema: {
          type: 'object',
          properties: {
            motivo: {
              type: 'string',
              description: 'Qué necesita, en pocas palabras, para que quien lo atienda no empiece de cero',
            },
          },
          required: ['motivo'],
        },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'planes_disponibles':
        return safe(() => this.planes(input));
      case 'sedes':
        return safe(() => this.sedes());
      case 'datos_empresa':
        return safe(() => this.empresa());
      case 'validar_mi_identidad':
        return safe(() => this.validar(input, ctx));
      case 'pedir_acceso_a_una_cuenta':
        return safe(() => this.pedirAcceso(input, ctx));
      case 'hablar_con_humano':
        return safe(() => this.escalar(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  /**
   * Pasa la conversación a una persona. El agente público es el único que atiende a
   * quien todavía no es cliente —el que quiere contratar, el que llama por un
   * familiar— y hasta ahora no tenía a dónde mandarlo: si el bot no sabía, la
   * conversación moría ahí. Ahora cae en la bandeja como cualquier otra.
   *
   * Sí, cualquier número puede dispararla y eso puede meter ruido en la cola. Se
   * asume a propósito: el costo de un chat de más en la bandeja (un clic para
   * devolverlo al bot) es menor que el de perder a alguien que quería comprar.
   */
  private async escalar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const motivo = String(input.motivo ?? '').trim() || 'Escribió alguien que no es cliente y el bot no pudo resolverlo';
    await this.store.setHandoff(ctx.convKey, motivo);
    await ctx.audit({
      userId: ctx.user.id,
      action: 'chatbot.handoff',
      summary: `Número no registrado pasado a una persona — ${motivo}`,
      detail: { convKey: ctx.convKey, motivo },
    });
    return 'Listo: le avisé al equipo y una persona le va a escribir por este mismo chat. '
      + 'Despídete y NO sigas respondiendo consultas en este chat.';
  }

  /**
   * Los planes que se le ofrecen a quien pregunta por WhatsApp.
   *
   * Dos fuentes, en este orden:
   *
   *  1. Los planes que se hayan elegido en Configuración → Agente de WhatsApp. Es la
   *     vía preferida: el precio que se cotiza sale de la misma tabla que factura.
   *  2. Si no se ha elegido ninguno, el catálogo comercial 2026 (`PLANES_COMERCIALES`).
   *
   * La tabla `Plan` tiene 72 planes activos heredados del sistema viejo —tarifas
   * repetidas, de otras ciudades y cosas como "1 Mega por $20.000"—, y ninguno
   * corresponde a la oferta que la empresa publica hoy. Por eso el respaldo NO puede
   * ser "los primeros de la lista": eso es exactamente lo que hacía antes, y el bot
   * estuvo cotizándole tarifas muertas a cada interesado que escribió.
   */
  private async planes(input: Record<string, unknown>): Promise<string> {
    const kind = input.tipo ? String(input.tipo).toUpperCase() : undefined;

    // 1) Si en Configuración se eligieron planes de la BD, mandan esos: es la vía
    //    preferida, porque el precio que se cotiza sale del mismo sitio que factura.
    const elegidos = await this.gate.planesPublicos();
    if (elegidos.length) {
      const rows = await this.plans.list({ activeOnly: true, kind: kind as any });
      const curado = rows.filter((p) => elegidos.includes(p.id));
      // La lista puede quedar vacía si preguntan por un tipo que no se publicó
      // (p. ej. TV cuando solo se eligieron planes de internet).
      if (!curado.length) {
        return 'No tengo planes publicados de ese tipo. Ofrece los de internet o remite a una sede.';
      }
      return curado
        .map((p) => `• ${p.name} (${p.kind})${p.megas ? ` — ${p.megas} megas` : ''}: ${cop(p.price)}/mes`)
        .join('\n');
    }

    // 2) Sin elección, el catálogo comercial 2026 (ver PLANES_COMERCIALES).
    //
    //    Aquí estaba el peor fallo que ha tenido este bot: caía a "los primeros 12
    //    planes activos por orden alfabético" y le ofrecía a gente que quería comprar
    //    tarifas muertas del legacy — literalmente "1 Mega por $20.000" como primera
    //    opción. Se cotizaba mal a cada interesado que escribía.
    const listar = (segmento: 'residencial' | 'comercial') =>
      PLANES_COMERCIALES.filter((p) => p.segmento === segmento)
        .map((p) => `• ${p.nombre}: ${cop(p.precio)}/mes — ${p.incluye}`)
        .join('\n');

    return [
      'PLANES PARA EL HOGAR (fibra óptica, velocidad simétrica):',
      listar('residencial'),
      '',
      'PLANES PARA NEGOCIOS:',
      listar('comercial'),
      '',
      'Preséntale SOLO lo que le sirve —hogar o negocio—, NO le leas la lista entera. ' +
      'La afiliación se cobra aparte y depende de la permanencia: consúltala con info_comercial. ' +
      'Si lo que necesita es un enlace dedicado punto a punto para una empresa, eso no se cotiza por ' +
      'chat: mira info_comercial (tema dedicado) y pásalo a un asesor.',
    ].join('\n');
  }

  /**
   * "El internet es de mi papá": pide que el titular autorice este número.
   *
   * NO entrega ni un dato de la cuenta, y la respuesta es la MISMA exista o no ese
   * abonado. Si dijera "ese abonado no existe", el bot sería un comprobador gratuito
   * de números de cuenta ajenos, y con eso se puede ir tanteando hasta dar con uno
   * bueno. Quien decide es siempre el titular, desde el celular que está en su ficha.
   */
  private async pedirAcceso(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const abonado = Number(input.abonado);
    if (!Number.isFinite(abonado) || abonado <= 0) {
      return 'Necesito el número de abonado que aparece en la factura para poder mandarle la solicitud al titular.';
    }
    const telefono = phoneOf(ctx.user, ctx.convKey);
    if (!telefono) return 'No pude leer tu número para tramitar la solicitud.';

    await this.contactos.solicitar(abonado, telefono, {
      nombre: input.nombre ? String(input.nombre) : undefined,
      relacion: input.relacion ? String(input.relacion) : undefined,
    });

    return 'Solicitud enviada. Si ese número de abonado corresponde a una cuenta nuestra, le avisamos al titular por ' +
      'su WhatsApp registrado para que autorice este número. En cuanto lo haga, podrás consultar y gestionar la ' +
      'cuenta desde aquí. Explícale al cliente que mientras tanto no puedes darle ningún dato de esa cuenta.';
  }

  /**
   * Valida los tres datos y, si aciertan, deja el número habilitado con acceso
   * básico: a partir del SIGUIENTE mensaje lo atiende el agente de clientes, porque
   * la identidad se resuelve de nuevo en cada mensaje y ya encontrará la
   * verificación. Por eso aquí se le dice explícitamente que ya puede pedir lo suyo.
   */
  private async validar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const telefono = phoneOf(ctx.user, ctx.convKey);
    if (!telefono) return 'No pude leer tu número para validarte.';

    const r = await this.access.validarDatos(telefono, {
      documento: String(input.documento ?? ''),
      nombre: String(input.nombre ?? ''),
      telefonoTitular: String(input.telefono_titular ?? ''),
    });
    if (!r.ok) return r.error;

    return 'Datos correctos: ya puedo atenderte sobre esa cuenta. Puedo decirte si el servicio está suspendido y ' +
      'por qué, cuánto se debe en total, y reportar una falla o pedir una visita. ' +
      'Para el PDF de las facturas, los pagos o cualquier cambio necesito además un código que le llega al ' +
      'WhatsApp del titular. Dile eso y pregúntale qué necesita.';
  }

  private async sedes(): Promise<string> {
    const rows = await this.config.branches();
    if (!rows.length) return 'No tengo sedes registradas.';
    return rows.map((b) => `• ${b.name}${b.dir ? ` — ${b.dir}` : ''}`).join('\n');
  }

  private async empresa(): Promise<string> {
    const c = await this.config.company();
    if (!c) return 'No tengo los datos de contacto de la empresa a la mano.';
    return [
      c.name,
      c.address ? `Dirección: ${c.address}${c.city ? `, ${c.city}` : ''}` : '',
      c.phone ? `Teléfono: ${c.phone}` : '',
      c.email ? `Correo: ${c.email}` : '',
    ].filter(Boolean).join('\n');
  }
}
