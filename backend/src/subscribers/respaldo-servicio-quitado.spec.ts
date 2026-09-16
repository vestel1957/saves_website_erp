import 'reflect-metadata';
import { SubscribersService } from './subscribers.service';

/**
 * UN SERVICIO QUITADO NO REVIVE DESDE UNA FACTURA VIEJA.
 *
 * El respaldo de la ficha baja por tres escalones (última factura → ítems facturados
 * del último año → perfil PPP) y los tres miran hacia atrás. Al abonado 56130 le
 * quitaron la televisión el 09-09-2026 y le seguía saliendo: su factura del mes no
 * nombra servicios (se emitió a mano en ventanilla, con la cabecera en blanco), así
 * que el primer escalón no daba nada y el segundo se la sacaba del renglón
 * 'Television' de noviembre del año anterior.
 *
 * La baja se declara con el `'no'` de la cabecera —lo mismo que lee el legacy— y ese
 * `'no'` tiene que tapar a los TRES escalones.
 */
function armar(baja: string[], primerEscalon: any[], items: any[], mensualidades: any[] = []) {
  const srv = Object.create(SubscribersService.prototype) as any;
  const conFuente = (arr: any[]) => arr.map((x) => ({ ...x, price: null, status: null, source: 'factura' }));
  srv.planDeMensualidades = async (ids: string[]) =>
    (mensualidades.length ? new Map([[ids[0], mensualidades.map((x) => ({ ...x, price: 30194, taxRate: 0 }))]]) : new Map());
  srv.serviciosDadosDeBaja = async (ids: string[]) =>
    (baja.length ? new Map([[ids[0], new Set(baja)]]) : new Map());
  srv.serviciosDeUltimaFactura = async (ids: string[]) =>
    (primerEscalon.length ? new Map([[ids[0], conFuente(primerEscalon)]]) : new Map());
  srv.serviciosDeItemsFacturados = async (ids: string[]) => new Map([[ids[0], conFuente(items)]]);
  return srv;
}

const FILA = { id: 'sub-1', pppProfile: '100Megas' };
const INTERNET = { kind: 'INTERNET', planName: '100 MEGAS --' };
const TV = { kind: 'TV', planName: 'Television' };

describe('respaldo: el servicio dado de baja no vuelve', () => {
  it('la TV quitada no se saca de los renglones viejos', async () => {
    const srv = armar(['TV'], [], [INTERNET, TV]);

    const r = (await srv.serviciosDeRespaldo([FILA])).get('sub-1');

    expect(r.map((x: any) => x.kind)).toEqual(['INTERNET']);
  });

  it('sin baja declarada no tapa nada: vacío es "no lo dice", no "no lo tiene"', async () => {
    const srv = armar([], [], [INTERNET, TV]);

    const r = (await srv.serviciosDeRespaldo([FILA])).get('sub-1');

    expect(r.map((x: any) => x.kind)).toEqual(['INTERNET', 'TV']);
  });

  it('tampoco vuelve por la cabecera de una FIJA posterior, que arrastra el snapshot viejo', async () => {
    // La baja se escribe en la última RECURRENTE; una fija emitida después (una
    // instalación, un traslado) sigue nombrando la televisión que ya no se contrata.
    const srv = armar(['TV'], [INTERNET, TV], []);

    const r = (await srv.serviciosDeRespaldo([FILA])).get('sub-1');

    expect(r.map((x: any) => x.kind)).toEqual(['INTERNET']);
  });

  it('la última factura nombra solo la TV: el internet sale de las mensualidades (abonado 51993)', async () => {
    const srv = armar([], [TV], [], [INTERNET, TV]);

    const r = (await srv.serviciosDeRespaldo([FILA])).get('sub-1');

    expect(r.map((x: any) => x.kind)).toEqual(['TV', 'INTERNET']);
    expect(r[1].price).toBe(30194);
  });

  it('pero el internet con baja declarada no se completa desde las mensualidades', async () => {
    const srv = armar(['INTERNET'], [TV], [], [INTERNET, TV]);

    const r = (await srv.serviciosDeRespaldo([FILA])).get('sub-1');

    expect(r.map((x: any) => x.kind)).toEqual(['TV']);
  });

  it('el internet dado de baja tampoco vuelve por el perfil del router', async () => {
    // Último escalón: `pppProfile` ('100Megas') alcanzaría para inventarle un plan de
    // internet a quien acaba de quedarse sin él.
    const srv = armar(['INTERNET'], [], []);

    const r = (await srv.serviciosDeRespaldo([FILA])).get('sub-1');

    expect(r).toBeUndefined();
  });
});
