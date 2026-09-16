import { distMeters } from '../geo/geo.util';

/**
 * Reglas de la geo-cerca del cierre de órdenes, como funciones puras.
 *
 * Están aparte del servicio a propósito: es la lógica que decide si un técnico
 * puede o no cerrar su trabajo. Si se equivoca de más, la empresa se para; si se
 * equivoca de menos, no sirve para nada. Aquí se puede probar entera sin base de
 * datos ni HTTP, que es la única forma de tener confianza en ella.
 */

export type ModoCerca = 'off' | 'observar' | 'exigir';

/**
 * Tipos de orden en los que el técnico SÍ va al domicilio.
 *
 * Esta lista es el corazón del asunto. En los últimos 90 días, el 85% de las
 * órdenes cerradas fueron cortes y reconexiones, que se hacen desde la oficina
 * contra el Mikrotik — nadie viaja a una vivienda a cortar el internet. Aplicar
 * la cerca a todo bloquearía a casi toda la operación por no estar en un sitio
 * al que no tenía por qué ir.
 *
 * Se compara en minúsculas y sin tildes, porque el legacy escribe el mismo tipo
 * de varias maneras ("Revision de television", "Revisión de Televisión").
 */
export const TIPOS_DE_CAMPO_POR_DEFECTO = [
  'revision de internet',
  'revision de television',
  'revision tv e internet',
  'instalacion',
  'cambio de equipo',
  'migracion',
  'traslado',
  'retiro voluntario',
];

/** Normaliza un tipo de orden para compararlo (minúsculas, sin tildes ni dobles espacios). */
export function normalizarTipo(t: string | null | undefined): string {
  return (t ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function esOrdenDeCampo(tipo: string | null | undefined, tiposCampo: string[]): boolean {
  return tiposCampo.includes(normalizarTipo(tipo));
}

/** Áreas que pueden cerrar sin cumplir la cerca (decisión del cliente). */
const AREAS_EXENTAS = ['area.gerencia', 'area.administracion'];
const SUPERADMIN = 'system.admin';

export function estaExento(permisos: string[] | undefined): boolean {
  const p = permisos ?? [];
  return p.includes(SUPERADMIN) || AREAS_EXENTAS.some((a) => p.includes(a));
}

export type Veredicto =
  /** La cerca no aplica; se cierra sin más. */
  | {
      accion: 'permitir';
      motivo:
        | 'modo-off'
        | 'no-es-de-campo'
        | 'usuario-exento'
        // El cliente no tiene coordenada y el que cierra tampoco mandó la suya:
        // no hay nada que comparar ni que guardar.
        | 'sin-datos'
        // Fuera de rango pero el modo es observación: se anota, no se frena.
        | 'sin-ubicacion-observando';
    }
  /** El cliente no tiene coordenada: se cierra Y se le guarda la del técnico. */
  | { accion: 'permitir-y-georreferenciar' }
  /** Dentro del radio. */
  | { accion: 'permitir'; motivo: 'dentro-de-rango'; distanciaM: number }
  /** Fuera de rango: en modo observar se deja pasar, pero marcado. */
  | { accion: 'permitir-marcado'; distanciaM: number; radioM: number }
  /**
   * Fuera de rango en modo `exigir`: NO se cierra. Sin portillo (2026-09-10, por
   * decisión del usuario reafirmada: «no dejar que cierren las órdenes si no están en
   * la ubicación del cliente»). Antes se podía cerrar escribiendo un motivo de 10
   * caracteres, y eso convertía la cerca en un trámite: 47 de los 113 cierres de
   * campo del mes salieron fuera de rango y ninguno se quedó sin cerrar.
   *
   * La válvula ya no es del técnico, es de quien responde por él: gerencia,
   * administración y superusuario están exentos y pueden cerrarla. Y si la dirección
   * del cliente está mal guardada —la causa más común, mediana 1.197 m del punto del
   * legacy—, lo que hay que arreglar es esa coordenada, no el cierre.
   */
  | { accion: 'exigir-presencia'; distanciaM: number; radioM: number }
  /** Falta la ubicación del que cierra y la cerca la exige. */
  | { accion: 'exigir-ubicacion'; motivo: string };

export type EntradaCerca = {
  modo: ModoCerca;
  radioM: number;
  tiposCampo: string[];
  tipoOrden: string | null;
  permisosUsuario: string[] | undefined;
  /** Coordenada guardada del abonado, si tiene. */
  cliente: { lat: number; lng: number } | null;
  /** Posición reportada por quien cierra, si la mandó. */
  tecnico: { lat: number; lng: number; accuracyM?: number | null } | null;
};

/**
 * Margen que se le concede SIEMPRE al error del GPS.
 *
 * Un teléfono dentro de una vivienda de material reporta con frecuencia ±50 a
 * ±300 m. Si se compara la distancia cruda contra el radio, se bloquea a
 * técnicos que están literalmente en la puerta. Se descuenta la precisión que
 * el propio navegador declara, pero acotada: si no, bastaría con mandar
 * `accuracy: 999999` para desactivar la cerca desde el cliente.
 */
const MARGEN_MAX_M = 250;

/** Lo que se le dice a quien intenta cerrar una visita sin mandar dónde está. */
const SIN_UBICACION =
  'Para cerrar esta orden hay que compartir la ubicación. Activa el GPS y acepta el permiso del navegador.';

export function margenPorPrecision(accuracyM: number | null | undefined): number {
  if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM <= 0) return 0;
  return Math.min(accuracyM, MARGEN_MAX_M);
}

/** Decide qué hacer con un cierre. Sin efectos: solo mira los datos y opina. */
export function evaluarCierre(e: EntradaCerca): Veredicto {
  if (e.modo === 'off') return { accion: 'permitir', motivo: 'modo-off' };
  if (!esOrdenDeCampo(e.tipoOrden, e.tiposCampo)) {
    return { accion: 'permitir', motivo: 'no-es-de-campo' };
  }
  if (estaExento(e.permisosUsuario)) return { accion: 'permitir', motivo: 'usuario-exento' };

  // El cliente no está georreferenciado: no hay contra qué comparar. En vez de
  // bloquear (que enseñaría a NO capturar nunca el GPS, para no quedar atado),
  // el propio cierre lo georreferencia. La cerca se aprieta sola con el uso.
  if (!e.cliente) {
    if (e.tecnico) return { accion: 'permitir-y-georreferenciar' };
    // Lo que SÍ se exige siempre en modo `exigir` es la COORDENADA DEL QUE CIERRA
    // (2026-09-10, del requerimiento: «exigir el registro de las coordenadas de
    // ubicación»). Que el cliente no tenga punto guardado ya no es una puerta: sin
    // el del técnico no hay nada que comparar HOY ni nada que guardar para mañana,
    // y era el hueco por el que un cierre sin GPS pasaba entero — precisamente en
    // los abonados peor georreferenciados, que son el 75% del parque.
    return e.modo === 'exigir'
      ? { accion: 'exigir-ubicacion', motivo: SIN_UBICACION }
      : { accion: 'permitir', motivo: 'sin-datos' };
  }

  if (!e.tecnico) {
    if (e.modo === 'observar') return { accion: 'permitir', motivo: 'sin-ubicacion-observando' };
    return { accion: 'exigir-ubicacion', motivo: SIN_UBICACION };
  }

  const distancia = distMeters(e.tecnico.lat, e.tecnico.lng, e.cliente.lat, e.cliente.lng);
  const efectiva = Math.max(0, distancia - margenPorPrecision(e.tecnico.accuracyM));

  if (efectiva <= e.radioM) {
    return { accion: 'permitir', motivo: 'dentro-de-rango', distanciaM: distancia };
  }
  if (e.modo === 'observar') {
    return { accion: 'permitir-marcado', distanciaM: distancia, radioM: e.radioM };
  }
  // Y en `exigir`, fuera es fuera: no hay motivo que valga (ver `exigir-presencia`).
  return { accion: 'exigir-presencia', distanciaM: distancia, radioM: e.radioM };
}
