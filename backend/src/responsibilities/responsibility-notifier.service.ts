import { Logger } from '../core/logger';
import type { EmisorDeEventos } from '../core/eventos';
import { NotificationsService } from '../common/notifications/notifications.service';
import { INTERNAL_ALERT_EVENT, type InternalAlert } from '../common/whatsapp/whatsapp.types';
import { ResponsibilitiesService } from './responsibilities.service';
import { postDef } from './responsibilities.catalog';
import { alcanzanSede } from '../common/sede-scope';
import { PrismaService } from '../prisma/prisma.service';

/** Lo mismo que pide la campanita, más el cargo al que va dirigido. */
export interface NotifyPostInput {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  groupKey?: string | null;
  /**
   * Sede del asunto (`Branch.legacyId`). Con ella el aviso sale sólo a quien
   * responde por ESA sede; sin ella (null) sale a todos los del cargo, como siempre.
   *
   * Existe porque el respaldo por permiso es una lista larga y plana: los 24 que
   * pueden abrir el tablero de agenda no reparten las mismas órdenes, reparten las
   * de su sede. Ver `alcanzanSede`, que es quien decide y respeta que "sin sedes
   * marcadas" signifique "todas".
   */
  sede?: number | null;
}

/** Base pública del ERP, para que el enlace del WhatsApp se pueda pulsar. */
const BASE_URL = (process.env.APP_PUBLIC_URL ?? 'http://89.117.146.226:3060').replace(/\/+$/, '');

/**
 * Ventana en la que un mismo asunto no vuelve a sonar en el celular del encargado.
 *
 * La campanita ya colapsa los repetidos con `groupKey`, pero WhatsApp no: seis
 * mensajes de un cliente serían seis vibraciones por lo mismo, y a la tercera el
 * encargado silencia el número del sistema. Ahí se pierde el canal entero, no un aviso.
 */
const SILENCIO_MS = 15 * 60 * 1000;

export class ResponsibilityNotifierService {
  private readonly logger = new Logger('AvisoPorCargo');
  /** Último WhatsApp por asunto. En memoria a propósito: se reinicia con el proceso. */
  private readonly ultimoWhatsapp = new Map<string, number>();

  constructor(
    private readonly responsibilities: ResponsibilitiesService,
    private readonly notifications: NotificationsService,
    private readonly events: EmisorDeEventos,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Avisa al encargado de un cargo (y a sus suplentes).
   *
   * Nunca lanza: el aviso es un efecto secundario de la operación que lo produjo
   * —crear una orden, recibir un mensaje— y no puede tumbarla.
   *
   * El WhatsApp sale sólo para quien lo pidió explícitamente en su casilla. Es una
   * decisión de coste, no de estilo: cada mensaje fuera de la ventana de 24 h abre
   * una conversación facturable y consume del tope diario del canal, así que se manda
   * a quien tiene que enterarse en el celular, no a todo el que está en la lista.
   */
  async notifyPost(post: string, input: NotifyPostInput): Promise<void> {
    try {
      const { holders, fromFallback } = await this.responsibilities.resolve(post);
      if (!holders.length) {
        this.logger.warn(
          `Nadie recibió "${input.title}": el cargo ${postDef(post)?.label ?? post} está sin encargado y sin respaldo.`,
        );
        return;
      }

      // El aviso de una sede es de quien responde por esa sede. Se acota DESPUÉS de
      // resolver el cargo —no antes— para que un titular nombrado a dedo siga
      // recibiendo lo suyo aunque su cuenta no tenga sedes marcadas.
      const dirigidos = await alcanzanSede(this.prisma, holders.map((h) => h.userId), input.sede);
      if (!dirigidos.length) {
        this.logger.warn(
          `Nadie recibió "${input.title}": ninguno de los ${holders.length} del cargo ` +
            `${postDef(post)?.label ?? post} llega a la sede ${input.sede}.`,
        );
        return;
      }
      await this.notifications.notify(dirigidos, input);

      if (fromFallback) return; // el respaldo nunca sale por WhatsApp (ver `resolve`)

      const puede = new Set(dirigidos);
      const phones = [
        ...new Set(
          holders
            .filter((h) => puede.has(h.userId) && h.notifyWhatsapp && h.whatsappPhone)
            .map((h) => h.whatsappPhone!),
        ),
      ];
      if (!phones.length) return;
      if (this.silenciado(post, input)) return;

      const alerta: InternalAlert = { phones, text: this.redactar(input) };
      this.events.emit(INTERNAL_ALERT_EVENT, alerta);
    } catch (e) {
      this.logger.warn(`No se pudo avisar al cargo "${post}" (${input.kind}): ${(e as Error).message}`);
    }
  }

  /**
   * ¿Este asunto ya sonó hace poco en el celular? El asunto es el `groupKey` cuando
   * lo hay (un chat, una orden concreta) y si no el par cargo+tipo de aviso.
   *
   * Sólo frena WhatsApp. La campanita recibe siempre: entrar a la pantalla y ver seis
   * cosas nuevas no molesta a nadie, y ahí sí conviene el detalle completo.
   */
  private silenciado(post: string, input: NotifyPostInput): boolean {
    const asunto = input.groupKey ? `${post}|${input.groupKey}` : `${post}|${input.kind}`;
    const ahora = Date.now();
    const previo = this.ultimoWhatsapp.get(asunto) ?? 0;
    if (ahora - previo < SILENCIO_MS) {
      this.logger.log(`"${input.title}" no se repite por WhatsApp: ya salió hace menos de 15 min.`);
      return true;
    }
    this.ultimoWhatsapp.set(asunto, ahora);
    // El mapa no crece sin control: los asuntos ya vencidos no vuelven a consultarse.
    if (this.ultimoWhatsapp.size > 500) {
      for (const [k, t] of this.ultimoWhatsapp) if (ahora - t > SILENCIO_MS) this.ultimoWhatsapp.delete(k);
    }
    return false;
  }

  /**
   * El texto del WhatsApp. Va en una sola línea y con el enlace completo: el
   * funcionario lo lee en el celular y lo que necesita es saber qué pasó y poder
   * abrirlo de un toque.
   */
  private redactar(input: NotifyPostInput): string {
    const partes = [`*${input.title}*`];
    if (input.body) partes.push(input.body);
    if (input.link) partes.push(`${BASE_URL}${input.link.startsWith('/') ? '' : '/'}${input.link}`);
    return partes.join('\n');
  }
}
