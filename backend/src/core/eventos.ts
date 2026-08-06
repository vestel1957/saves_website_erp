/**
 * Bus de eventos interno (sustituye a `@nestjs/event-emitter` y a `@OnEvent`).
 *
 * Lo usan 9 listeners y ~16 emisores: ticket resuelto/asignado, pago aplicado,
 * entrada/salida/estado de WhatsApp y alertas internas. La API de emisión se
 * mantiene idéntica —`events.emit(NOMBRE, payload)`— para no tocar los emisores.
 * Lo que cambia es el registro: en vez de un `@OnEvent` que Nest descubre por
 * reflexión, los listeners se suscriben en el arranque, donde se ven todos juntos.
 *
 * UNA DIFERENCIA DELIBERADA CON NEST: aquí los errores de un listener se capturan y
 * se registran. Con EventEmitter2, un listener `async` que rechaza produce una
 * promesa no capturada, y Node ≥18 **tumba el proceso** por defecto. Esos listeners
 * son accesorios (registrar el mensaje, avisar por WhatsApp): que un fallo al
 * notificar mate la API entera mientras se cobra una factura no es aceptable. El
 * fallo se ve en el log, no en el uptime.
 */
import { EventEmitter } from 'node:events';
import { Logger } from './logger';

const log = new Logger('Eventos');

export type Listener<T = any> = (payload: T) => void | Promise<void>;

export class BusDeEventos {
  private readonly emisor = new EventEmitter();

  constructor() {
    // Estos eventos tienen varios suscriptores (WHATSAPP_INBOUND_EVENT tiene dos).
    // El aviso de "posible fuga de memoria" a los 10 es ruido aquí: el número de
    // listeners es fijo y se conoce en el arranque.
    this.emisor.setMaxListeners(50);
  }

  /** Emite un evento. No espera a los listeners (igual que EventEmitter2). */
  emit<T>(evento: string, payload?: T): void {
    this.emisor.emit(evento, payload);
  }

  /** Suscribe un listener. El nombre del suscriptor sólo sirve para el log. */
  on<T>(evento: string, listener: Listener<T>, suscriptor = 'anónimo'): void {
    this.emisor.on(evento, (payload: T) => {
      try {
        const r = listener(payload);
        if (r instanceof Promise) {
          r.catch((e: unknown) => {
            log.error(`Listener ${suscriptor} falló en "${evento}": ${(e as Error)?.message}`, (e as Error)?.stack);
          });
        }
      } catch (e) {
        log.error(`Listener ${suscriptor} falló en "${evento}": ${(e as Error)?.message}`, (e as Error)?.stack);
      }
    });
  }
}

/**
 * Instancia única. Se exporta como valor —y no se inyecta— porque es
 * infraestructura sin estado de negocio, igual que el logger: obligar a pasarla por
 * constructor a través de 122 servicios sólo añadiría ruido.
 */
export const eventos = new BusDeEventos();

/**
 * Tipo mínimo compatible con el `EventEmitter2` que los servicios reciben hoy por
 * constructor. Permite migrarlos sin tocar sus llamadas a `.emit(...)`.
 */
export type EmisorDeEventos = Pick<BusDeEventos, 'emit'>;
