import { ServiceUnavailableException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { assertPoint, distMeters } from './geo.util';

export type Ruta = {
  /** Puntos de la línea a dibujar, en orden. */
  geometry: { lat: number; lng: number }[];
  /** Metros por carretera (o en línea recta, si `aproximada`). */
  distanceM: number;
  /** Segundos estimados de conducción. `null` cuando es aproximada. */
  durationS: number | null;
  /**
   * `true` = no se pudo calcular la ruta real y esto es la línea recta.
   * La interfaz DEBE decirlo: enseñar una recta como si fuera el camino haría
   * que el técnico calcule mal el tiempo de llegada.
   */
  aproximada: boolean;
};

/**
 * Servidor público de OSRM. Es la demo del proyecto: gratis, sin cuenta y sin
 * tarjeta, pero sin ningún compromiso de disponibilidad.
 *
 * Se asume a conciencia. El volumen aquí es de unos pocos técnicos consultando
 * cómo llegar a una orden — nada que se parezca a un abuso — y a cambio no hay
 * que pedirle a nadie una cuenta con tarjeta. Lo que NO se hace es depender de
 * él: si tarda o falla, se devuelve la línea recta marcada como aproximada y la
 * pantalla sigue sirviendo. Si algún día se vuelve inestable, OSRM se puede
 * levantar en el propio servidor con el mapa de Colombia.
 */
const OSRM = 'https://router.project-osrm.org';
const TIMEOUT_MS = 6000;

/**
 * Tope de puntos por matriz.
 *
 * Empezó en 12 —la jornada de campo más cargada son 11 visitas— y se subió a 25 el
 * mismo día: una casilla de agenda trae TODO lo del día, cerradas incluidas, y la
 * primera prueba real tenía 17. Al pasarse del tope se devolvía `null` y el
 * recorrido salía en línea recta sin que se rompiera nada, que es justo el fallo
 * silencioso que hace pensar que la función "no sirve para nada".
 *
 * 25 sigue muy por debajo del límite del servidor público (100) y de lo que
 * cabe en un día de trabajo.
 */
const MAX_MATRIZ = 25;

export class RoutingService {
  private readonly log = new Logger(RoutingService.name);

  /**
   * Ruta en coche entre dos puntos.
   *
   * Nunca lanza por culpa de OSRM: un fallo del servicio externo degrada a línea
   * recta, no rompe la pantalla del técnico que está en la calle.
   */
  async route(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<Ruta> {
    const a = assertPoint(from.lat, from.lng);
    const b = assertPoint(to.lat, to.lng);
    const recta = (): Ruta => ({
      geometry: [a, b],
      distanceM: distMeters(a.lat, a.lng, b.lat, b.lng),
      durationS: null,
      aproximada: true,
    });

    // El propio OSRM se atraganta con coordenadas idénticas.
    if (a.lat === b.lat && a.lng === b.lng) {
      return { geometry: [a], distanceM: 0, durationS: 0, aproximada: false };
    }

    const url =
      `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}` +
      `?overview=full&geometries=geojson&alternatives=false&steps=false`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'saves-erp/1.0 (+soporte@vestel.com.co)' },
      });
      if (!res.ok) throw new Error(`OSRM respondió ${res.status}`);

      const body = (await res.json()) as {
        code?: string;
        routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
      };
      const r = body.routes?.[0];
      if (body.code !== 'Ok' || !r?.geometry?.coordinates?.length) {
        throw new Error(`OSRM sin ruta (code=${body.code})`);
      }

      return {
        // GeoJSON va [lng, lat]; Leaflet quiere [lat, lng]. Invertir esto es el
        // error clásico y deja la ruta en el océano Índico.
        geometry: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        distanceM: Math.round(r.distance),
        durationS: Math.round(r.duration),
        aproximada: false,
      };
    } catch (e) {
      this.log.warn(`Ruta no calculada, se devuelve línea recta: ${(e as Error).message}`);
      return recta();
    }
  }

  /**
   * Matriz de distancias por carretera entre N puntos, en metros.
   *
   * Es lo que convierte "ordenar por línea recta" en "ordenar por camino de
   * verdad": en una ciudad con un río, una vía férrea o sentidos únicos, dos
   * puntos a 300 m en recta pueden estar a 2 km de recorrido, y el orden
   * propuesto al técnico cambia.
   *
   * Devuelve `null` —no lanza— cuando OSRM no está: quien la usa se queda con la
   * línea recta, que ordena razonablemente bien y no depende de nadie. Un
   * servicio externo caído no puede dejar sin agendar a la cajera.
   *
   * Un solo viaje por propuesta, con 12 puntos como mucho: es una consulta
   * ocasional de unas pocas personas, no un uso que se parezca a un abuso del
   * servidor público.
   */
  async matriz(puntos: { lat: number; lng: number }[]): Promise<number[][] | null> {
    if (puntos.length < 2 || puntos.length > MAX_MATRIZ) return null;
    const coords = puntos.map((p) => {
      const v = assertPoint(p.lat, p.lng);
      return `${v.lng},${v.lat}`;
    }).join(';');

    try {
      const res = await fetch(`${OSRM}/table/v1/driving/${coords}?annotations=distance,duration`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'saves-erp/1.0 (+soporte@vestel.com.co)' },
      });
      if (!res.ok) throw new Error(`OSRM respondió ${res.status}`);
      const body = (await res.json()) as {
        code?: string;
        distances?: (number | null)[][];
        durations?: (number | null)[][];
      };
      if (body.code !== 'Ok') throw new Error(`OSRM sin matriz (code=${body.code})`);

      // `distances` es lo que se pide; algunos despliegues sólo devuelven
      // `durations`. Ordenar por segundos es igual de válido —de hecho es mejor
      // criterio para un recorrido— así que se acepta en vez de rendirse.
      const m = body.distances ?? body.durations;
      if (!m || m.length !== puntos.length) throw new Error('OSRM devolvió una matriz de otro tamaño');

      // Un hueco (`null`) es un punto que OSRM no supo enganchar a ninguna vía.
      // Se rellena con la línea recta en vez de tirar la matriz entera: se pierde
      // precisión en esa celda, no la mejora en todas las demás.
      return m.map((fila, i) =>
        fila.map((v, j) => (typeof v === 'number' ? Math.round(v) : distMeters(puntos[i].lat, puntos[i].lng, puntos[j].lat, puntos[j].lng))),
      );
    } catch (e) {
      this.log.warn(`Matriz no calculada, se ordenará por línea recta: ${(e as Error).message}`);
      return null;
    }
  }

  /** Comprobación del servicio externo, para diagnóstico desde configuración. */
  async health(): Promise<{ ok: boolean; detalle: string }> {
    try {
      const r = await this.route({ lat: 5.3378, lng: -72.3959 }, { lat: 5.3407, lng: -72.3694 });
      return r.aproximada
        ? { ok: false, detalle: 'OSRM no respondió; las rutas salen en línea recta.' }
        : { ok: true, detalle: 'OSRM responde con rutas por carretera.' };
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }
}
