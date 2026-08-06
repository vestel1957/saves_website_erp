import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { SubscriberContactsService } from '../subscriber-contacts.service';
import { ChatAccessService } from '../chat-access.service';
import { ChatbotSessionStore } from '../chatbot-session.store';
import { phoneOf } from '../chatbot.identity';
import { safe } from './toolset.util';

/**
 * Herramientas para números NO registrados (ni funcionario ni abonado): lo que hace
 * falta para saber QUIÉN es quien escribe (validarse, pedirle acceso al titular) o
 * para pasarlo con una persona.
 *
 * La información comercial —planes, sedes, datos de la empresa— vive en
 * `ComercialToolset` y se le da también al agente de clientes, que la necesita tanto
 * o más: aquí solo queda lo que es exclusivo de un número desconocido.
 *
 * No hay ninguna herramienta que reciba un identificador de cliente, así que este
 * agente no tiene forma de tocar datos de una cuenta ni aunque el modelo lo intente:
 * la barrera es que la capacidad no existe, no que el prompt lo prohíba.
 */
export class PublicoToolset implements Toolset {
  constructor(
    private readonly contactos: SubscriberContactsService,
    private readonly access: ChatAccessService,
    private readonly store: ChatbotSessionStore,
  ) {}

  definitions(_ctx: ToolContext): ToolDef[] {
    return [
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
}
