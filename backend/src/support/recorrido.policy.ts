/**
 * En qué ORDEN conviene hacer las visitas de un técnico en un día.
 *
 * Nace de una pregunta del usuario (2026-09-03): "¿puede la IA recomendar las
 * órdenes más cercanas entre sí, para que el recorrido sea algo controlado?".
 * La respuesta es que sí, pero **no con un modelo de lenguaje**: esto es un
 * problema de geometría con solución exacta, barata y determinista. Pedírselo a
 * un LLM sería más lento, más caro y distinto cada vez que se pulsa el botón —
 * y aquí lo que se propone acaba siendo el orden que el técnico está OBLIGADO a
 * seguir (ver `turno.ts`), así que tiene que salir siempre igual.
 *
 * Este fichero es **puro a propósito**: no toca Prisma, no llama a nadie por
 * red y no sabe qué es un Ticket. Recibe puntos y devuelve un orden. Así se
 * puede probar el caso que de verdad importa —"¿ahorra camino o no?"— sin
 * montar media aplicación.
 *
 * ## Lo que NO hace
 *
 * No promete el óptimo. El viajante es NP-duro y con 4-11 paradas (la media
 * real es 4,1 por técnico y día) la diferencia entre una buena heurística y el
 * óptimo es de metros. Se hace vecino más cercano + 2-opt, que con estos
 * tamaños converge en microsegundos y deja una ruta sin cruces.
 */

/** Un punto del mapa. Mismo par que usa `geo.util.ts`. */
export type Punto = { lat: number; lng: number };

export type Parada = {
  id: string;
  /**
   * Dónde está. `null` = no se pudo ubicar (ni el abonado tiene GPS ni su barrio
   * tiene centroide): esas no se pueden ordenar y van al final, dichas.
   */
  punto: Punto | null;
  /**
   * `false` = el punto es el CENTROIDE DEL BARRIO, no la casa. Ordena bien a
   * escala de ciudad (que es la decisión que se está tomando) pero la pantalla
   * tiene que decirlo: enseñar un punto de barrio como si fuera la puerta haría
   * que alguien discuta el orden con un dato que no existe.
   */
  exacto: boolean;
  /**
   * No se mueve de donde está. Son las que ya están EN MARCHA o cerradas: el
   * técnico ya salió hacia ellas, reordenarlas sería reescribir un recorrido que
   * ya ocurrió. Se quedan al principio, en su orden, y el resto se optimiza
   * partiendo de la última de ellas.
   */
  fija?: boolean;
};

export type Recorrido = {
  /** Los ids en el orden propuesto. Contiene TODAS las paradas que entraron. */
  orden: string[];
  /** Metros del recorrido tal y como está hoy. */
  metrosAntes: number;
  /** Metros del recorrido propuesto. */
  metrosDespues: number;
  /** Ids que no se pudieron ubicar y quedaron al final. */
  sinUbicar: string[];
  /** `true` si alguna parada usó centroide de barrio en vez de GPS del abonado. */
  aproximado: boolean;
};

/** Distancia en metros entre dos puntos (haversine). Copia deliberada de
 *  `geo.util.distMeters` para que este fichero no dependa de nada. */
export function metros(a: Punto, b: Punto): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

/**
 * Función de distancia. Se inyecta para poder cambiar la línea recta por los
 * metros REALES por carretera (matriz de OSRM) sin tocar la heurística: en una
 * ciudad con un río o con sentidos únicos, dos puntos a 300 m en línea recta
 * pueden estar a 2 km de camino, y el orden cambia.
 */
export type Distancia = (a: Punto, b: Punto) => number;

/** Largo total de una secuencia, incluyendo el tramo desde el punto de partida. */
export function largo(inicio: Punto | null, puntos: Punto[], dist: Distancia = metros): number {
  let total = 0;
  let previo = inicio;
  for (const p of puntos) {
    if (previo) total += dist(previo, p);
    previo = p;
  }
  return total;
}

/** Vecino más cercano: se empieza en `inicio` y se salta siempre al más próximo. */
function vecinoMasCercano(inicio: Punto | null, puntos: Punto[], dist: Distancia): number[] {
  const pendientes = puntos.map((_, i) => i);
  const ruta: number[] = [];
  let actual = inicio;
  while (pendientes.length) {
    let mejor = 0;
    if (actual) {
      let mejorD = Infinity;
      for (let k = 0; k < pendientes.length; k++) {
        const d = dist(actual, puntos[pendientes[k]]);
        if (d < mejorD) { mejorD = d; mejor = k; }
      }
    }
    const [i] = pendientes.splice(mejor, 1);
    ruta.push(i);
    actual = puntos[i];
  }
  return ruta;
}

/**
 * 2-opt: mientras haya dos tramos que se cruzan, se les da la vuelta al trozo
 * de en medio. Es lo que quita el zigzag que deja el vecino más cercano cuando
 * al final tiene que volver a por la que se dejó atrás.
 *
 * El tope de vueltas es una red de seguridad, no un límite real: con 11 paradas
 * converge en dos o tres pasadas.
 */
function dosOpt(inicio: Punto | null, puntos: Punto[], ruta: number[], dist: Distancia): number[] {
  const largoDe = (r: number[]) => largo(inicio, r.map((i) => puntos[i]), dist);
  let mejor = [...ruta];
  let mejorLargo = largoDe(mejor);
  for (let vuelta = 0; vuelta < 40; vuelta++) {
    let mejoro = false;
    for (let i = 0; i < mejor.length - 1; i++) {
      for (let j = i + 1; j < mejor.length; j++) {
        const candidata = [...mejor.slice(0, i), ...mejor.slice(i, j + 1).reverse(), ...mejor.slice(j + 1)];
        const l = largoDe(candidata);
        if (l < mejorLargo - 1) { mejor = candidata; mejorLargo = l; mejoro = true; }
      }
    }
    if (!mejoro) break;
  }
  return mejor;
}

/**
 * Vecino más cercano + 2-opt, con una vuelta de tuerca para cuando NO se sabe de
 * dónde sale el técnico.
 *
 * Sin punto de partida, el vecino más cercano tiene que empezar por alguna y
 * elegía la primera de la lista — o sea, el orden en que la cajera las agendó,
 * que es justo lo que se está tratando de mejorar. Con 11 paradas como mucho,
 * probar las 11 salidas posibles y quedarse con la mejor cuesta microsegundos y
 * quita esa arbitrariedad.
 */
function optimizar(inicio: Punto | null, puntos: Punto[], dist: Distancia): number[] {
  const desde = (p: Punto | null) => dosOpt(p, puntos, vecinoMasCercano(p, puntos, dist), dist);
  if (inicio) return desde(inicio);

  let mejor: number[] | null = null;
  let mejorLargo = Infinity;
  for (const p of puntos) {
    const r = desde(p);
    const l = largo(null, r.map((i) => puntos[i]), dist);
    if (l < mejorLargo) { mejorLargo = l; mejor = r; }
  }
  return mejor ?? puntos.map((_, i) => i);
}

/**
 * Propone el orden de las visitas de una jornada.
 *
 * `inicio` es de dónde sale el técnico: su sede, o el último punto donde se le
 * vio. Sin él la ruta se ordena igual, pero la primera parada la elige el azar
 * de cuál quedó primera en la lista — por eso conviene pasarlo siempre que se
 * pueda.
 */
export function proponerRecorrido(
  inicio: Punto | null,
  paradas: Parada[],
  dist: Distancia = metros,
): Recorrido {
  const fijas = paradas.filter((p) => p.fija);
  const movibles = paradas.filter((p) => !p.fija);
  const ubicables = movibles.filter((p) => p.punto) as (Parada & { punto: Punto })[];
  const sinUbicar = movibles.filter((p) => !p.punto);

  // Se sale de la última parada fija que tenga punto: si el técnico ya está en
  // una visita, la siguiente se elige desde ALLÍ y no desde la sede.
  const desde = [...fijas].reverse().find((p) => p.punto)?.punto ?? inicio;

  const puntos = ubicables.map((p) => p.punto);
  // Con DOS paradas ya hay decisión que tomar —cuál de las dos queda de camino—,
  // así que el umbral es 2 y no 3: saltarse el vecino más cercano aquí dejaba el
  // orden de la lista tal cual y mandaba al técnico al otro extremo primero.
  const ruta = puntos.length >= 2 ? optimizar(desde, puntos, dist) : puntos.map((_, i) => i);

  const antes = largo(desde, puntos, dist);
  const despues = largo(desde, ruta.map((i) => puntos[i]), dist);

  return {
    orden: [
      ...fijas.map((p) => p.id),
      ...ruta.map((i) => ubicables[i].id),
      ...sinUbicar.map((p) => p.id),
    ],
    metrosAntes: antes,
    metrosDespues: despues,
    sinUbicar: sinUbicar.map((p) => p.id),
    aproximado: ubicables.some((p) => !p.exacto),
  };
}
