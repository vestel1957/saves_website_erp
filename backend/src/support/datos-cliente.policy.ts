import { esOrdenDeCampo, estaExento } from './geofence.policy';

/**
 * Los datos del cliente que hay que tener ANTES de empezar la visita (2026-09-18,
 * del requerimiento del usuario: «si el cliente no tiene la ubicación aún, y la
 * foto de la vivienda, a la hora de abrir la orden debe sí o sí obligarlo a subir
 * primero estos datos y ahí sí hacer lo que tiene que hacer»).
 *
 * **Por qué al EMPEZAR y no al cerrar**, que es donde viven los otros cuatro
 * candados: porque estos dos datos sólo se pueden tomar estando en la puerta, y al
 * cerrar ya es tarde para el que se fue. Y porque la ubicación del cliente es
 * justamente contra lo que mide la geo-cerca al cerrar: capturada al llegar, el
 * cierre cuadra solo; descubierta al final, el técnico se encuentra bloqueado por
 * un punto que nadie tomó nunca (era el caso de la orden #506045).
 *
 * **El tamaño de esto, medido antes de encenderlo (2026-09-18):** de 6.805 abonados
 * vivos sólo 2.088 tienen coordenada (31%) y **101 tienen foto de la vivienda**. O
 * sea: al principio lo va a pedir en casi todas las visitas. Es el efecto buscado
 * —es la única forma de que el parque se georreferencie y se fotografíe—, pero hay
 * que saberlo: NO es un candado que salte de vez en cuando, es trabajo nuevo en cada
 * puerta hasta que el parque esté al día.
 *
 * Comparte con la cerca y con la foto de la visita dos de las preguntas de siempre:
 * - **sólo órdenes DE CAMPO** (misma lista configurable `tickets.geofence.fieldTypes`):
 *   el 85% del trabajo son cortes y reconexiones que nadie va a fotografiar;
 * - **sólo personas**: el cron, el sync y la reconexión automática mueven órdenes a
 *   REALIZANDO sin usuario y no se les puede pedir una foto.
 *
 * **Y una que NO comparte: aquí sólo se le pide al TÉCNICO DE CAMPO** (2026-09-18,
 * corrección del usuario: «solo se le pida esto a los técnicos que son los únicos que
 * deben estar en la vivienda, ya que sistemas y administración no están en campo»).
 * Los otros candados listan exentos —gerencia, administración, superusuario— y frenan
 * a todos los demás; éste hace lo contrario, porque es lo único coherente con lo que
 * pide: tomar una foto de la casa y capturar su GPS sólo lo puede hacer quien está
 * delante de la casa. Sistemas, caja o contabilidad mueven órdenes desde la oficina y
 * pedirles la foto sería dejarles la orden trabada sin forma de destrabarla.
 * `esTecnicoDeCampo` es la MISMA función que decide "sólo lo suyo" en el resto del
 * sistema (`common/tecnico-scope.ts`), y ya deja fuera a superusuario, gerencia,
 * administración, contabilidad y jefe de bodega aunque tengan también el área técnica.
 *
 * Se apaga entero con `TICKET_REQUIRE_CLIENT_DATA=false`, como los otros tres.
 */
export type EntradaDatosCliente = {
  /** ¿Está encendido el requisito? (`TICKET_REQUIRE_CLIENT_DATA=false` lo apaga.) */
  activo: boolean;
  tipoOrden: string | null;
  tiposCampo: string[];
  /** Permisos de quien empieza; `undefined` = proceso interno sin usuario. */
  permisosUsuario: string[] | undefined;
  /** ¿Hay alguien empezándola, o es un proceso? */
  hayUsuario: boolean;
  /** ¿Es un técnico de campo? Al resto del personal NO se le pide (ver arriba). */
  esTecnicoDeCampo: boolean;
  hayCliente: boolean;
  /** ¿El abonado ya tiene coordenada guardada en la ficha? */
  tieneUbicacion: boolean;
  /** ¿Tiene ya alguna foto de la vivienda (`SubscriberFile.kind = VIVIENDA`)? */
  tieneFotoVivienda: boolean;
};

/** Qué falta, por separado: se incumplen de forma independiente. */
export type DatosQueFaltan = { ubicacion: boolean; foto: boolean };

const NADA: DatosQueFaltan = { ubicacion: false, foto: false };

/** ¿Esta orden exige tener los datos del cliente antes de empezarla? */
export function aplicaDatosDelCliente(e: EntradaDatosCliente): boolean {
  if (!e.activo) return false;
  if (!e.hayUsuario) return false;
  if (!e.hayCliente) return false;
  if (!e.esTecnicoDeCampo) return false;
  if (!esOrdenDeCampo(e.tipoOrden, e.tiposCampo)) return false;
  // Redundante con la línea de arriba —`esTecnicoDeCampo` ya devuelve false para los
  // tres—, y se queda: si mañana alguien amplía a quién se le pide, los exentos de la
  // cerca tienen que seguir siéndolo de esto.
  if (estaExento(e.permisosUsuario)) return false;
  return true;
}

/**
 * Qué datos del cliente faltan para poder empezar. Devuelve los dos en `false`
 * cuando el requisito no aplica, para que la pantalla pueda pintar lo que falta con
 * la MISMA función que usa el candado y no con una lista de tipos repetida.
 */
export function datosQueFaltan(e: EntradaDatosCliente): DatosQueFaltan {
  if (!aplicaDatosDelCliente(e)) return NADA;
  return { ubicacion: !e.tieneUbicacion, foto: !e.tieneFotoVivienda };
}

/** ¿Hay que frenar el arranque de esta orden? */
export function faltanDatosDelCliente(e: EntradaDatosCliente): boolean {
  const f = datosQueFaltan(e);
  return f.ubicacion || f.foto;
}

/**
 * Lo que se le dice al técnico. Nombra SÓLO lo que falta —pedirle la foto cuando ya
 * la subió es lo que hace que los avisos dejen de leerse— y dice dónde está cada
 * cosa, que es lo único que le sirve con el cliente delante.
 */
export function mensajeDatosCliente(f: DatosQueFaltan): string {
  const que =
    f.ubicacion && f.foto
      ? 'la ubicación del cliente y la foto de la vivienda'
      : f.ubicacion
        ? 'la ubicación del cliente'
        : 'la foto de la vivienda';
  const como =
    f.ubicacion && f.foto
      ? 'Estando en la puerta, pulsa «Capturar GPS aquí» y toma la foto de la casa; luego empieza la orden.'
      : f.ubicacion
        ? 'Estando en la puerta, pulsa «Capturar GPS aquí» y luego empieza la orden.'
        : 'Toma la foto de la casa desde la orden y luego empiézala.';
  return `Antes de empezar esta visita hay que dejar ${que}. ${como}`;
}
