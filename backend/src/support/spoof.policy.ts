import { distMeters } from '../geo/geo.util';

/**
 * Señales de que una ubicación reportada podría estar simulada.
 *
 * Por qué esto existe: la geo-cerca valida en el servidor, pero valida un dato
 * que manda el propio teléfono del técnico. En Android, activar una app de
 * "ubicación simulada" son dos toques, y el navegador entrega la coordenada
 * falsa sin distinguirla de una real. No hay ninguna API que permita saber si el
 * GPS es auténtico — ni en web ni, de forma fiable, en una app nativa.
 *
 * Lo que sí se puede es buscar lo que un GPS real nunca hace. Ninguna de estas
 * señales prueba nada por separado; sirven para que hacer trampa deje rastro y
 * salga en un informe que mira una persona. Por eso son ETIQUETAS y no un
 * booleano "hizo trampa": el sistema señala, no acusa.
 */

export type Senal =
  /** Precisión imposible: un GPS de teléfono no baja de ~3 m, y jamás da 0. */
  | 'precision-perfecta'
  /** Coordenada idéntica a otra anterior hasta el último decimal. */
  | 'punto-repetido'
  /** Velocidad implícita absurda respecto del punto anterior. */
  | 'salto-imposible'
  /** Cerró una visita a domicilio desde el wifi de la oficina. */
  | 'desde-la-oficina'
  /** La foto de evidencia de la misma orden se tomó en otro sitio. */
  | 'foto-en-otro-sitio';

export const EXPLICACION: Record<Senal, string> = {
  'precision-perfecta': 'La precisión reportada es demasiado buena para un GPS real.',
  'punto-repetido': 'Coordenada exactamente igual a una anterior, hasta el último decimal.',
  'salto-imposible': 'Habría tenido que moverse a una velocidad imposible desde su punto anterior.',
  'desde-la-oficina': 'Cerró desde el wifi de la oficina, no desde datos móviles.',
  'foto-en-otro-sitio': 'La foto de evidencia de esta orden se tomó lejos del punto de cierre.',
};

/**
 * Un GPS de teléfono no reporta mejor que unos 3 m, y nunca exactamente 0. Los
 * simuladores suelen inventar un valor redondo y perfecto.
 */
export function precisionSospechosa(accuracyM: number | null | undefined): boolean {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return false;
  return accuracyM <= 1;
}

/**
 * Dos lecturas reales de GPS jamás coinciden hasta el sexto decimal (≈10 cm):
 * el ruido del receptor lo impide aunque el teléfono esté quieto sobre una mesa.
 * Repetir el punto exacto es la firma de una coordenada escrita a mano.
 */
export function puntoRepetido(
  punto: { lat: number; lng: number },
  anteriores: { lat: number; lng: number }[],
): boolean {
  return anteriores.some(
    (p) => p.lat.toFixed(6) === punto.lat.toFixed(6) && p.lng.toFixed(6) === punto.lng.toFixed(6),
  );
}

/** Por encima de esto, o no fue en carro, o uno de los dos puntos es mentira. */
const VELOCIDAD_MAX_KMH = 130;
/** Bajo este tiempo, el GPS puede saltar solo por error de medición. */
const MARGEN_SEGUNDOS = 45;

/**
 * Velocidad implícita entre dos puntos consecutivos del mismo usuario.
 *
 * Es la señal más difícil de esquivar: quien falsea la ubicación suele fijar un
 * punto sin pensar en que el sistema recuerda dónde estaba veinte minutos antes.
 */
export function saltoImposible(
  actual: { lat: number; lng: number; en: Date },
  anterior: { lat: number; lng: number; en: Date } | null,
): boolean {
  if (!anterior) return false;
  const segundos = (actual.en.getTime() - anterior.en.getTime()) / 1000;
  if (segundos <= MARGEN_SEGUNDOS) return false;
  const metros = distMeters(anterior.lat, anterior.lng, actual.lat, actual.lng);
  const kmh = metros / 1000 / (segundos / 3600);
  return kmh > VELOCIDAD_MAX_KMH;
}

/**
 * ¿La petición salió del wifi de una oficina?
 *
 * Un técnico que de verdad está en el domicilio de un cliente sale por datos
 * móviles, no por la red interna de la empresa. Si cierra una visita a domicilio
 * conectado al wifi de la oficina, o no estaba allí, o alguien cerró por él. Es
 * la única señal que no depende de nada que el técnico controle desde el móvil:
 * la IP la ve el servidor, no la manda el teléfono.
 *
 * NO necesita coordenadas — antes las pedía y era config de más para nada: basta
 * con saber que la conexión es de oficina. Ojo con listar rangos enteros en una
 * empresa que ES el ISP: los clientes también salen por sus rangos, así que aquí
 * sólo valen IPs exactas.
 */
export function esIpDeOficina(
  ip: string | null | undefined,
  oficinas: string[],
): boolean {
  if (!ip || !oficinas.length) return false;
  return oficinas.includes(normalizarIp(ip));
}

/** Quita el prefijo IPv6-mapeado (`::ffff:`) que mete el proxy. */
export function normalizarIp(ip: string): string {
  return ip.replace(/^::ffff:/, '').trim();
}

/**
 * La evidencia fotográfica lleva su propia coordenada, tomada en otro momento.
 * Para que ambas mientan de forma coherente hay que hacerlo a propósito y dos
 * veces, que es justo lo que se quiere que cueste.
 */
export function fotoEnOtroSitio(
  cierre: { lat: number; lng: number },
  fotos: { lat: number; lng: number }[],
  toleranciaM = 400,
): boolean {
  if (!fotos.length) return false;
  // Basta con que UNA foto cuadre: el técnico se mueve por la vivienda y sus
  // alrededores, y exigir que todas coincidan generaría ruido constante.
  return !fotos.some((f) => distMeters(f.lat, f.lng, cierre.lat, cierre.lng) <= toleranciaM);
}

export type EntradaSenales = {
  punto: { lat: number; lng: number; accuracyM?: number | null; en: Date };
  anterior: { lat: number; lng: number; en: Date } | null;
  puntosPrevios: { lat: number; lng: number }[];
  ip?: string | null;
  /** IPs públicas exactas de las oficinas. */
  oficinas: string[];
  fotos: { lat: number; lng: number }[];
};

/** Reúne todas las señales que se disparan para una ubicación reportada. */
export function detectarSenales(e: EntradaSenales): Senal[] {
  const s: Senal[] = [];
  if (precisionSospechosa(e.punto.accuracyM)) s.push('precision-perfecta');
  if (puntoRepetido(e.punto, e.puntosPrevios)) s.push('punto-repetido');
  if (saltoImposible(e.punto, e.anterior)) s.push('salto-imposible');
  if (esIpDeOficina(e.ip, e.oficinas)) s.push('desde-la-oficina');
  if (fotoEnOtroSitio(e.punto, e.fotos)) s.push('foto-en-otro-sitio');
  return s;
}
