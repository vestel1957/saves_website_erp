import {
  DETALLES_POR_CLASE,
  esOrdenDeServicio,
  servicioNombradoEnOrden,
} from './order-types';
import { ORDEN_DE_SERVICIO, whereDeServicios } from './servicio-orden.filtro';
import { mixPorAbonado, olvidarMixDeTodos } from '../common/servicios-del-abonado';

/**
 * EL CARTEL DE SERVICIO DE UNA ORDEN (Solo TV / Solo internet / Combo).
 *
 * Nació el 2026-09-10 de una queja concreta: en la lista de órdenes no se veía si
 * una reconexión era sólo de televisión, y había que abrirlas una por una para
 * averiguarlo. La primera versión leía el NOMBRE de la orden y contestaba otra
 * pregunta —marcaba "TV" las 38 'Reconexion Television2' abiertas, y 33 de esos
 * clientes tienen también internet—, así que el cartel pasó a decir QUÉ TIENE
 * CONTRATADO EL CLIENTE y el nombre de la orden se quedó de puerta: sólo llevan
 * cartel las órdenes que van de un servicio.
 *
 * Lo que se comprueba aquí es lo único que puede romperse en silencio:
 *   - la PUERTA, que está escrita dos veces —en memoria y en SQL— sobre los mismos
 *     fragmentos, y se compara sobre el catálogo entero y sobre los detalles que de
 *     verdad hay en la base;
 *   - de dónde sale lo CONTRATADO, que es el candado del `'no'` de la factura;
 *   - que el filtro enseñe exactamente las filas que llevan el cartel marcado.
 */

/** Los `Ticket.type` que existen hoy en la base y nombran algún servicio (2026-09-10). */
const DETALLES_EN_LA_BASE = [
  'Corte Internet', 'Reconexion Internet', 'Corte Television', 'Revision de Internet',
  'Reconexion Television', 'Revision de television', 'Revision tv e internet',
  'Reconexion Internet2', 'Reconexion Television2', 'Reconexion Combo', 'Corte Combo',
  'Suspension Television', 'AgregarInternet', 'Suspension Combo', 'Reconexion Combo2',
  'Suspension Internet', 'AgregarTelevision', 'Suspencion Combo', 'Reinstalacion Internet',
  'Suspencion Television', 'Suspencion Internet', 'Reinstalacion Television',
  'Revision_de_television', 'Reconexion television2',
];

const TODOS = [...new Set([...Object.values(DETALLES_POR_CLASE).flat(), ...DETALLES_EN_LA_BASE])];

/**
 * Un evaluador del `WHERE` de Prisma, con lo justo que usa el filtro: `contains`
 * insensible, `AND`, `OR` y `NOT`. Correr el filtro contra Postgres exigiría base
 * de datos; lo que hay que amarrar es la REGLA, y la regla es esto.
 */
function pasa(where: any, type: string): boolean {
  if (!where) return true;
  if (Array.isArray(where.AND) && !where.AND.every((w: any) => pasa(w, type))) return false;
  if (Array.isArray(where.OR) && !where.OR.some((w: any) => pasa(w, type))) return false;
  if (where.NOT && pasa(where.NOT, type)) return false;
  if (where.type?.contains != null) {
    const [a, b] = where.type.mode === 'insensitive'
      ? [type.toLowerCase(), String(where.type.contains).toLowerCase()]
      : [type, String(where.type.contains)];
    if (!a.includes(b)) return false;
  }
  return true;
}

/**
 * Una base fingida: las facturas que decide el caso y los servicios registrados.
 * `$queryRaw` es la última recurrente de cada abonado (`ultimaRecurrente`).
 */
function baseCon(facturas: { subscriberId: string; serviceTv?: string | null; serviceCombo?: string | null }[], registrados: { subscriberId: string; kind: string }[] = []) {
  olvidarMixDeTodos();
  return {
    $queryRaw: jest.fn().mockResolvedValue(
      facturas.map((f) => ({ subscriberId: f.subscriberId, serviceTv: f.serviceTv ?? null, serviceCombo: f.serviceCombo ?? null })),
    ),
    subscriberService: { findMany: jest.fn().mockResolvedValue(registrados) },
  } as any;
}

describe('la puerta del cartel: ¿esta orden va de un servicio?', () => {
  it('lee el servicio del nombre del detalle', () => {
    expect(servicioNombradoEnOrden('Reconexion Television2')).toBe('TV');
    expect(servicioNombradoEnOrden('Revision_de_television')).toBe('TV');
    expect(servicioNombradoEnOrden('AgregarTelevision')).toBe('TV');
    expect(servicioNombradoEnOrden('Reconexion Internet')).toBe('INTERNET');
    expect(servicioNombradoEnOrden('AgregarInternet')).toBe('INTERNET');
    expect(servicioNombradoEnOrden('Corte Combo')).toBe('COMBO');
    // Nombra los dos servicios sin decir 'combo': para quien mira la lista es lo mismo.
    expect(servicioNombradoEnOrden('Revision tv e internet')).toBe('COMBO');
  });

  it('CALLA cuando el nombre no dice de qué servicio es', () => {
    // Un cartel colgado de todas las filas no distingue nada. `serviciosDeOrden`
    // sí contesta para éstas —la cascada de cierre necesita una respuesta—, y ésa
    // es justo la diferencia entre las dos.
    for (const t of ['Instalacion', 'Migracion', 'Traslado', 'Cambio de equipo', 'Subir megas', 'Retiro voluntario', 'Veeduria', '']) {
      expect(esOrdenDeServicio(t)).toBe(false);
    }
  });

  it("no confunde 'interno' con 'internet'", () => {
    // 'Traslado interno De Equipos Red en cliente final': mover el equipo dentro de
    // la misma casa no es una orden de internet.
    expect(esOrdenDeServicio('Traslado interno De Equipos Red en cliente final')).toBe(false);
  });

  it('el SQL de la puerta atrapa exactamente los mismos detalles que la regla de memoria', () => {
    const enSql = TODOS.filter((t) => pasa(ORDEN_DE_SERVICIO, t)).sort();
    const enMemoria = TODOS.filter((t) => esOrdenDeServicio(t)).sort();
    expect(enSql).toEqual(enMemoria);
    expect(enMemoria.length).toBeGreaterThan(0);
  });
});

describe('lo que dice el cartel: qué tiene contratado el cliente', () => {
  it('lee el plan de la última factura recurrente, con el candado del "no"', async () => {
    const prisma = baseCon([
      { subscriberId: 'combo', serviceTv: 'TV Digital', serviceCombo: '5MegasV' },
      // Solo televisión: el legacy escribe 'no' en el internet que no se tiene.
      { subscriberId: 'solo-tv', serviceTv: 'TV Digital', serviceCombo: 'no' },
      // Y a veces lo deja vacío o en '-', que es lo mismo.
      { subscriberId: 'solo-tv-2', serviceTv: 'TV Digital', serviceCombo: '' },
      { subscriberId: 'solo-tv-3', serviceTv: 'TV Digital', serviceCombo: '-' },
      { subscriberId: 'solo-internet', serviceTv: 'no', serviceCombo: '100Megas' },
      // Ni una cosa ni la otra: no consta, y no consta NO es "no tiene".
      { subscriberId: 'nada', serviceTv: 'no', serviceCombo: 'no' },
    ]);
    const mix = await mixPorAbonado(prisma, ['combo', 'solo-tv', 'solo-tv-2', 'solo-tv-3', 'solo-internet', 'nada']);
    expect(mix.get('combo')).toBe('COMBO');
    expect(mix.get('solo-tv')).toBe('TV');
    expect(mix.get('solo-tv-2')).toBe('TV');
    expect(mix.get('solo-tv-3')).toBe('TV');
    expect(mix.get('solo-internet')).toBe('INTERNET');
    expect(mix.has('nada')).toBe(false);
  });

  it('cae en los servicios registrados sólo para quien no tiene factura', async () => {
    const prisma = baseCon(
      // El de la factura tiene internet aunque su `SubscriberService` diga otra cosa:
      // manda lo que se le está cobrando (`SubscriberService` está incompleto).
      [{ subscriberId: 'con-factura', serviceTv: 'TV Digital', serviceCombo: '5MegasV' }],
      [
        { subscriberId: 'con-factura', kind: 'TV' },
        { subscriberId: 'recien-dado-de-alta', kind: 'TV' },
        { subscriberId: 'recien-dado-de-alta', kind: 'PUNTOS' },
      ],
    );
    const mix = await mixPorAbonado(prisma, ['con-factura', 'recien-dado-de-alta']);
    expect(mix.get('con-factura')).toBe('COMBO');
    // 'PUNTOS' son puntos de TV: no son un segundo servicio.
    expect(mix.get('recien-dado-de-alta')).toBe('TV');
  });
});

describe('el filtro', () => {
  const BASE = [
    { subscriberId: 'combo', serviceTv: 'TV Digital', serviceCombo: '5MegasV' },
    { subscriberId: 'solo-tv', serviceTv: 'TV Digital', serviceCombo: 'no' },
    { subscriberId: 'solo-internet', serviceTv: 'no', serviceCombo: '100Megas' },
  ];

  it('enseña las órdenes de servicio de los clientes marcados, y sólo ésas', async () => {
    const where: any = await whereDeServicios(baseCon(BASE), ['TV']);
    // Las dos condiciones del cartel: que la orden vaya de un servicio…
    expect(pasa(where, 'Reconexion Television')).toBe(true);
    expect(pasa(where, 'Instalacion')).toBe(false);
    // …y que el cliente sea de los elegidos.
    expect(where.AND[1]).toEqual({ subscriberId: { in: ['solo-tv'] } });
  });

  it('varios marcados suman, y lo que no se reconoce se ignora', async () => {
    const where: any = await whereDeServicios(baseCon(BASE), ['tv', 'combo']);
    expect(where.AND[1].subscriberId.in.sort()).toEqual(['combo', 'solo-tv']);
    // Un valor raro por la URL no puede dejar la lista vacía: se ignora el filtro.
    expect(await whereDeServicios(baseCon(BASE), ['telefonia'])).toBeNull();
    expect(await whereDeServicios(baseCon(BASE), [])).toBeNull();
  });
});
