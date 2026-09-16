import { esOrdenDeCampo, estaExento, normalizarTipo } from './geofence.policy';

/**
 * IP remota obligatoria para cerrar una visita (2026-09-10, del requerimiento del
 * usuario: «no dejarle cerrar órdenes si el cliente no tiene IP Remota activa, para
 * que sistemas pueda acceder remotamente»).
 *
 * Es el tercer requisito del cierre y vive aparte por lo mismo que la foto
 * (`foto-cierre.policy.ts`): se incumple solo. Se puede estar en la puerta del
 * cliente, con la foto subida, y dejar al abonado navegando por una dirección del
 * pool a la que nadie puede volver mañana.
 *
 * **Por qué importa tanto aquí**: la IP fija no es un lujo de sistemas. El corte de
 * esta casa NO deshabilita el secret — mete la dirección del cliente en la
 * address-list MOROSOS y el firewall la bloquea (ver `MikrotikService.cutOnApi` y
 * [[ip-automatica-mikrotik]]). Un abonado sin IP fija no se puede cortar, y encima
 * nadie puede entrar a su equipo a mirar nada. Así que el técnico que se va dejando
 * la instalación sin IP deja dos agujeros, no uno.
 *
 * Lo que se exige es que la FICHA traiga una dirección utilizable. No se va a
 * preguntar al router en cada cierre: son 8 equipos por API y un router lento o
 * caído dejaría al técnico sin poder cerrar por algo que no es suyo ni puede
 * arreglar. La ficha es además la que manda para el corte, y el botón que resuelve
 * el bloqueo —«Asignar IP remota»— es el que sí habla con el router y deja a los dos
 * de acuerdo (`MikrotikService.garantizarIpRemota`).
 *
 * A QUIÉN NO se le pide, y cada exclusión es por un motivo que se vio en los datos:
 *
 *  · **Órdenes que no son de campo** (el 85% del trabajo: cortes y reconexiones
 *    desde la oficina, muchos cerrados por el cron al entrar el pago). Misma lista
 *    configurable que la cerca y la foto.
 *  · **Procesos internos** sin usuario (cron, sync, chatbot, cascada de facturación).
 *  · **Gerencia, administración y superusuario**, exentos de los otros dos.
 *  · **Clientes sin internet**: 433 abonados activos son sólo televisión, sin secret
 *    PPPoE. En ellos no existe IP remota que activar, y 12 de las 78 «Revisión de
 *    televisión» de los últimos 90 días son exactamente eso. Pedírsela sería dejar
 *    órdenes abiertas para siempre.
 *  · **Retiro voluntario**: el servicio se está yendo. Exigir que el cliente al que
 *    se le da de baja quede con acceso remoto es pedir lo contrario de la orden.
 *  · **Órdenes sin cliente** (las solicitudes sueltas del call center).
 *
 * Medido sobre los 90 días previos: de 407 cierres de campo, habría frenado 20
 * (5%) — y los 20 son casos que sistemas quiere arreglados, no falsos positivos.
 */
export type EntradaIpRemota = {
  /** ¿Está encendido el requisito? (`TICKET_REQUIRE_REMOTE_IP=false` lo apaga.) */
  activo: boolean;
  tipoOrden: string | null;
  tiposCampo: string[];
  /** Permisos de quien cierra; `undefined` = proceso interno sin usuario. */
  permisosUsuario: string[] | undefined;
  /** ¿Hay alguien cerrando, o es un proceso? */
  hayUsuario: boolean;
  /** ¿La orden es de un abonado? Sin cliente no hay IP que exigir. */
  hayCliente: boolean;
  /** ¿El abonado tiene servicio de internet? (usuario PPPoE de verdad, no relleno.) */
  tieneInternet: boolean;
  /** Lo que trae la ficha en `Subscriber.ipRemote`. */
  ipRemota: string | null | undefined;
};

/** Lo que se le dice a quien intenta cerrar sin dejar el acceso remoto montado. */
export const SIN_IP_REMOTA =
  'Este cliente no tiene IP remota activa: sin ella sistemas no puede entrar a su equipo '
  + 'y el abonado tampoco se puede cortar. Pulsa “Asignar IP remota” en los requisitos de '
  + 'la orden (la reparte el sistema y la escribe en el router) y vuelve a cerrarla.';

/**
 * Tipos de orden de campo a los que NO se les pide, por el trabajo que son.
 * Se comparan normalizados, igual que la lista de campo.
 */
const TIPOS_SIN_IP = ['retiro voluntario'];

/**
 * ¿Esta dirección sirve para entrar al equipo del cliente y para cortarlo?
 *
 * Más estricta que la `esIpValida` de `mikrotik.service.ts` (que sólo mira la forma)
 * porque aquí se decide si un técnico puede cerrar: la ficha está llena de herencia
 * del legacy y hay 1.611 abonados con `ipRemote = "0"` y 9.509 en blanco. Un "0" o
 * un "0.0.0.0" pasan cualquier regex laxa y no son una dirección de nadie.
 */
export function esIpRemotaUtil(v: string | null | undefined): boolean {
  const s = (v ?? '').trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => n > 255)) return false;
  // Primer octeto 0 (0.x.x.x) y 127 (loopback) no son direcciones de cliente;
  // el último en 0 o 255 es red o broadcast del /24, que el repartidor nunca entrega.
  if (oct[0] === 0 || oct[0] === 127) return false;
  if (oct[3] === 0 || oct[3] === 255) return false;
  return s !== '255.255.255.255';
}

/** ¿Hay que frenar este cierre porque el cliente se queda sin acceso remoto? */
export function faltaLaIpRemota(e: EntradaIpRemota): boolean {
  if (!e.activo) return false;
  if (!e.hayUsuario) return false;
  if (!e.hayCliente) return false;
  if (!esOrdenDeCampo(e.tipoOrden, e.tiposCampo)) return false;
  if (TIPOS_SIN_IP.includes(normalizarTipo(e.tipoOrden))) return false;
  if (estaExento(e.permisosUsuario)) return false;
  if (!e.tieneInternet) return false;
  return !esIpRemotaUtil(e.ipRemota);
}
