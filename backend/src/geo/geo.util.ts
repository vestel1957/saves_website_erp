/**
 * Las coordenadas del legacy son `String?` (`coor1`/`coor2` de `customers`), sin
 * ninguna validación: hay celdas con `""`, `"0"`, `"NULL"`, comas decimales,
 * pares pegados en un solo campo y valores fuera de rango. Mandar eso al mapa
 * no produce un error visible — produce pines en mitad del Atlántico (0,0) o en
 * otro continente, que es peor porque parece un dato real.
 *
 * Por eso todo lo que sale hacia el mapa pasa por aquí.
 */

/** Recuadro de Colombia, con holgura. Fuera de esto el dato está corrupto. */
const CO = { latMin: -4.3, latMax: 13.6, lngMin: -82.0, lngMax: -66.8 };

/** Convierte el texto legacy a número, o null si no es una coordenada usable. */
export function parseCoord(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = String(raw).trim().replace(',', '.');
  if (!t || t.toUpperCase() === 'NULL') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/**
 * Par lat/lng validado, o null. Rechaza el (0,0) y cualquier punto fuera de
 * Colombia: si un abonado de Yopal aparece en Asia, el dato está roto y es mejor
 * no pintarlo que pintarlo mal.
 */
export function parsePoint(
  lat: string | null | undefined,
  lng: string | null | undefined,
): { lat: number; lng: number } | null {
  const la = parseCoord(lat);
  const ln = parseCoord(lng);
  if (la === null || ln === null) return null;
  if (la < CO.latMin || la > CO.latMax || ln < CO.lngMin || ln > CO.lngMax) return null;
  return { lat: la, lng: ln };
}

/** Valida una coordenada que ENTRA (captura desde el navegador). */
export function assertPoint(lat: number, lng: number): { lat: number; lng: number } {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Coordenadas inválidas');
  if (lat < CO.latMin || lat > CO.latMax || lng < CO.lngMin || lng > CO.lngMax) {
    throw new Error('La ubicación está fuera del área de cobertura');
  }
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

/** Distancia en metros entre dos puntos (haversine). */
export function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}
