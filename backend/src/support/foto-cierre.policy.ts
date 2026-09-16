import { esOrdenDeCampo, estaExento } from './geofence.policy';

/**
 * Registro fotográfico obligatorio para cerrar una visita (2026-09-10, del
 * requerimiento del usuario: «exigir registro fotográfico como requisito obligatorio
 * para cerrar la orden»).
 *
 * Vive aparte de la geo-cerca aunque comparta con ella las dos preguntas que
 * importan —¿es de campo? ¿está exento?—, porque son dos requisitos distintos y se
 * incumplen por separado: se puede estar en la puerta del cliente sin haber subido
 * una foto, y al revés. Compartir el corte de "orden de campo" sí es deliberado: la
 * lista es la misma (`tickets.geofence.fieldTypes`) y tener dos listas que decir qué
 * es una visita a domicilio acabaría con las dos diciendo cosas distintas.
 *
 * **Sólo a las órdenes DE CAMPO**, y esto no es negociable: el 85% de los cierres son
 * cortes y reconexiones que se hacen desde la oficina contra el Mikrotik, y muchos ni
 * siquiera los cierra una persona —los cierra el cron al entrar el pago—. Exigir foto
 * en todo pararía la caja, la facturación y la reconexión automática el primer día.
 *
 * **Y sólo a las personas**: los procesos internos (cron, sync, chatbot, la cascada de
 * la facturación) cierran sin usuario y pasan de largo, igual que en el turno y en la
 * cerca. Los exentos de la cerca —gerencia, administración, superusuario— lo son
 * también de la foto: cierran desde la oficina el trabajo que otro hizo, y pedirles
 * una foto que no pueden tomar sería dejarles órdenes abiertas para siempre.
 */
export type EntradaFoto = {
  /** ¿Está encendido el requisito? (`TICKET_REQUIRE_PHOTO=false` lo apaga.) */
  activo: boolean;
  tipoOrden: string | null;
  tiposCampo: string[];
  /** Permisos de quien cierra; `undefined` = proceso interno sin usuario. */
  permisosUsuario: string[] | undefined;
  /** ¿Hay alguien cerrando, o es un proceso? */
  hayUsuario: boolean;
  /** Cuántas fotos de evidencia lleva ya la orden en su hilo. */
  fotos: number;
};

/** Lo que se le dice a quien intenta cerrar una visita sin evidencia. */
export const SIN_FOTO =
  'Para cerrar esta orden hay que subir al menos una foto de la visita. Adjúntala en el seguimiento (“Tomar foto”) y vuelve a cerrarla.';

/** ¿Hay que frenar este cierre por falta de registro fotográfico? */
export function faltaLaFoto(e: EntradaFoto): boolean {
  if (!e.activo) return false;
  if (!e.hayUsuario) return false;
  if (!esOrdenDeCampo(e.tipoOrden, e.tiposCampo)) return false;
  if (estaExento(e.permisosUsuario)) return false;
  return e.fotos < 1;
}
