/**
 * Llena el CENTROIDE de cada barrio: el punto con el que se ordena el recorrido
 * de un técnico cuando el abonado no tiene GPS.
 *
 * El problema que resuelve, medido el 2026-09-03: de las 242 órdenes de campo
 * abiertas, sólo 61 (25%) tienen coordenada del abonado, pero 234 (97%) tienen
 * barrio. Una recomendación de recorrido que sólo mire el GPS deja fuera tres
 * cuartas partes del día del técnico — es decir, no sirve.
 *
 * Dos fuentes, en este orden:
 *
 *  1. **Los abonados que SÍ tienen GPS.** Si en el barrio Centro hay 40 fichas
 *     georreferenciadas, el centro del barrio Centro ya está en la base y no hay
 *     que preguntárselo a nadie. Se usa la MEDIANA, no la media: un solo punto
 *     mal escrito (los hay, el legacy no valida nada) arrastra la media a otro
 *     municipio y la mediana ni se entera.
 *  2. **Nominatim (OSM)**, sólo con `--osm` y sólo para los que quedan sin
 *     resolver. Es un servicio público y gratuito con una regla clara: máximo
 *     una petición por segundo y con User-Agent identificable. Se respeta. Con
 *     ~170 barrios son tres minutos, se corre una vez y no se vuelve.
 *
 * Es idempotente: se puede correr todos los días. Nunca pisa un centroide puesto
 * a mano (`geoSource='manual'`).
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/centroides-barrio.ts           # sólo abonados
 *   npx ts-node --transpile-only scripts/centroides-barrio.ts --osm     # + geocodificar el resto
 *   npx ts-node --transpile-only scripts/centroides-barrio.ts --dry     # sin escribir
 */
import { PrismaClient } from '@prisma/client';
import { parsePoint } from '../src/geo/geo.util';
import { metros } from '../src/support/recorrido.policy';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');
const OSM = process.argv.includes('--osm');

/** Menos de esto y el centroide es un rumor: se prefiere geocodificar. */
const MINIMO_PUNTOS = 3;
/** Un abonado a más de 8 km de la mediana de su barrio tiene la ficha mal. */
const RADIO_MAXIMO_M = 8000;

const mediana = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Geocodifica "barrio X, ciudad, Colombia" con Nominatim, o null. */
async function nominatim(consulta: string): Promise<{ lat: number; lng: number } | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&q=' +
    encodeURIComponent(consulta);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'saves-erp/1.0 (+soporte@vestel.com.co)' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { lat: string; lon: string }[];
    const r = body?.[0];
    if (!r) return null;
    // El validador de siempre: fuera de Colombia el dato está roto.
    return parsePoint(r.lat, r.lon);
  } catch {
    return null;
  }
}

async function main() {
  const [barrios, ciudades, departamentos, abonados] = await Promise.all([
    prisma.neighborhood.findMany({
      select: { id: true, legacyId: true, name: true, cityLegacy: true, departmentLegacy: true, geoSource: true },
    }),
    prisma.city.findMany({ select: { legacyId: true, name: true } }),
    prisma.department.findMany({ select: { legacyId: true, name: true } }),
    prisma.subscriber.findMany({
      where: { neighborhood: { not: null }, gpsLat: { not: null } },
      select: { neighborhood: true, cityRef: true, gpsLat: true, gpsLng: true },
    }),
  ]);

  const ciudadDe = new Map(ciudades.flatMap((c) => (c.legacyId != null ? [[c.legacyId, c.name]] : [])));
  const deptoDe = new Map(departamentos.flatMap((d) => (d.legacyId != null ? [[d.legacyId, d.name]] : [])));

  // Puntos usables agrupados por barrio (la clave del abonado es el id legacy en texto).
  const puntos = new Map<string, { lat: number; lng: number }[]>();
  /** Lo mismo pero por CIUDAD: es la vara con la que se descarta un
   *  geocodificado que se fue a otro municipio (ver `cordura`). */
  const porCiudad = new Map<string, { lat: number; lng: number }[]>();
  for (const a of abonados) {
    const p = parsePoint(a.gpsLat, a.gpsLng);
    if (!p) continue;
    const k = String(a.neighborhood ?? '').trim();
    if (k) (puntos.get(k) ?? puntos.set(k, []).get(k)!).push(p);
    const c = String(a.cityRef ?? '').trim();
    if (c) (porCiudad.get(c) ?? porCiudad.set(c, []).get(c)!).push(p);
  }

  /**
   * Centro conocido de una ciudad, sacado de sus propios abonados. Sirve de
   * control: Nominatim resuelve "El Centro" en cualquier municipio de Colombia,
   * y un barrio de Yopal que aterriza en Mocoa es peor que no tener el dato.
   */
  const centroCiudad = new Map<number, { lat: number; lng: number }>();
  for (const [c, ps] of porCiudad) {
    if (ps.length < MINIMO_PUNTOS) continue;
    centroCiudad.set(Number(c), { lat: mediana(ps.map((p) => p.lat)), lng: mediana(ps.map((p) => p.lng)) });
  }

  let porAbonados = 0, porOsm = 0, sinResolver = 0, respetados = 0, descartadosLejos = 0;
  const pendientes: typeof barrios = [];

  for (const b of barrios) {
    if (b.geoSource === 'manual') { respetados++; continue; }
    const ps = b.legacyId != null ? puntos.get(String(b.legacyId)) ?? [] : [];
    if (ps.length < MINIMO_PUNTOS) { pendientes.push(b); continue; }

    const lat0 = mediana(ps.map((p) => p.lat));
    const lng0 = mediana(ps.map((p) => p.lng));
    // Se descarta lo que esté absurdamente lejos de la mediana y se recalcula:
    // así un barrio con 40 fichas buenas y 2 malas queda bien centrado.
    const buenos = ps.filter((p) => metros(p, { lat: lat0, lng: lng0 }) <= RADIO_MAXIMO_M);
    if (buenos.length < MINIMO_PUNTOS) { pendientes.push(b); continue; }
    const lat = mediana(buenos.map((p) => p.lat));
    const lng = mediana(buenos.map((p) => p.lng));

    if (!DRY) {
      await prisma.neighborhood.update({
        where: { id: b.id },
        data: { lat, lng, geoSource: 'abonados', geoPoints: buenos.length, geoAt: new Date() },
      });
    }
    porAbonados++;
  }

  if (OSM) {
    for (const b of pendientes) {
      const ciudad = b.cityLegacy != null ? ciudadDe.get(b.cityLegacy) : null;
      // El departamento SALE DE LA FICHA, no se da por supuesto: hay sedes en
      // Casanare, en Putumayo (Mocoa) y en Meta (Villavicencio), y fijar uno a
      // mano mandaba los barrios de las otras dos al municipio equivocado.
      const depto = b.departmentLegacy != null ? deptoDe.get(b.departmentLegacy) : null;
      const consulta = [b.name, ciudad, depto, 'Colombia'].filter(Boolean).join(', ');
      const p = await nominatim(consulta);
      // Una por segundo. La política de uso de Nominatim no es una recomendación.
      await new Promise((r) => setTimeout(r, 1100));
      if (!p) { sinResolver++; continue; }

      // Cordura: si de esa ciudad ya se sabe dónde cae, el resultado tiene que
      // caer cerca. 25 km cubre el municipio más disperso sin dejar pasar un
      // barrio de otro departamento.
      const centro = b.cityLegacy != null ? centroCiudad.get(b.cityLegacy) : null;
      if (centro && metros(p, centro) > 25000) { descartadosLejos++; continue; }
      if (!DRY) {
        await prisma.neighborhood.update({
          where: { id: b.id },
          data: { ...p, geoSource: 'osm', geoPoints: null, geoAt: new Date() },
        });
      }
      porOsm++;
    }
  } else {
    sinResolver = pendientes.length;
  }

  console.log(`Barrios: ${barrios.length}`);
  console.log(`  centroide por abonados : ${porAbonados}`);
  console.log(`  geocodificados (OSM)   : ${porOsm}${OSM ? '' : ' (pasa --osm para intentarlo)'}`);
  console.log(`  descartados por lejos  : ${descartadosLejos}`);
  console.log(`  sin resolver           : ${sinResolver}`);
  console.log(`  puestos a mano, intactos: ${respetados}`);
  if (DRY) console.log('\n(--dry: no se escribió nada)');
}

main().finally(() => prisma.$disconnect());
