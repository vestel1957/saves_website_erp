import 'reflect-metadata';
import { SubscribersService } from './subscribers.service';

/**
 * EL RESPALDO COMPLETA, NO SUSTITUYE.
 *
 * `SubscriberService` no está completo —la migración sólo lo pobló para los ACTIVO
 * cuya factura casaba con el catálogo—, así que la ficha, el listado y la corrida
 * mensual rellenan lo que falta con lo que dicen las facturas del abonado.
 *
 * Esa regla estaba escrita como TODO O NADA: "si tiene alguna fila, se cree la ficha
 * entera". Y eso hace desaparecer servicios en cuanto un abonado queda a medio
 * registrar. Pasó el 07-09-2026 con la abonada 2169: tenía televisión (sin fila,
 * derivada de su factura) y pidió internet por una orden de 'AgregarInternet'; al
 * nacerle la fila de INTERNET el respaldo se apagó de golpe y su televisión
 * desapareció de la ficha — y de la corrida del mes siguiente.
 *
 * Se prueba `conRespaldo`, que es donde vive la regla, con la fuente de respaldo
 * doblada: lo que importa aquí es QUÉ SE MEZCLA, no de qué consulta sale.
 */
function armar(derivados: Array<{ kind: string; planName: string; price: number }>) {
  const srv = Object.create(SubscribersService.prototype) as any;
  const llamadas: number[] = [];
  srv.serviciosDeRespaldo = async (filas: any[]) => {
    llamadas.push(filas.length);
    return new Map([[filas[0].id, derivados.map((d) => ({ ...d, status: null, source: 'factura' }))]]);
  };
  return { srv, llamadas };
}

const FILA = { id: 'sub-1', pppProfile: '300Megas' };
const INTERNET = { kind: 'INTERNET', planName: '300 Megas --', price: 80000, status: 'ACTIVO', source: 'plan' };
const TV = { kind: 'TV', planName: 'SoloTelevision22', price: 25210, status: 'ACTIVO', source: 'plan' };

describe('servicios: lo registrado + lo que falte', () => {
  it('al que sólo tiene internet registrado le devuelve su televisión', async () => {
    const { srv } = armar([{ kind: 'TV', planName: 'SoloTelevision22', price: 20168 }]);

    const r = await srv.conRespaldo([INTERNET], FILA);

    expect(r.map((x: any) => x.kind)).toEqual(['INTERNET', 'TV']);
    expect(r[1]).toMatchObject({ kind: 'TV', planName: 'SoloTelevision22', source: 'factura' });
  });

  it('lo REGISTRADO manda: el respaldo no pisa un plan que ya tiene fila', async () => {
    // Si alguien le corrigió el plan en la ficha, una factura vieja no puede volver
    // a imponer el suyo.
    const { srv } = armar([
      { kind: 'INTERNET', planName: '100 Megas F-26 (viejo)', price: 50500 },
      { kind: 'TV', planName: 'SoloTelevision22', price: 20168 },
    ]);

    const r = await srv.conRespaldo([INTERNET], FILA);

    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ planName: '300 Megas --', source: 'plan' });
    expect(r.find((x: any) => x.kind === 'INTERNET' && x.source === 'factura')).toBeUndefined();
  });

  it('al que ya tiene los dos NO se le consulta el respaldo (son tres consultas)', async () => {
    const { srv, llamadas } = armar([{ kind: 'TV', planName: 'otra', price: 1 }]);

    const r = await srv.conRespaldo([INTERNET, TV], FILA);

    expect(llamadas).toHaveLength(0);
    expect(r).toEqual([INTERNET, TV]);
  });

  it('al que no tiene nada registrado le devuelve los dos', async () => {
    const { srv } = armar([
      { kind: 'INTERNET', planName: '100 MEGAS --', price: 65000 },
      { kind: 'TV', planName: 'Television', price: 10000 },
    ]);

    const r = await srv.conRespaldo([], FILA);

    expect(r.map((x: any) => x.kind)).toEqual(['INTERNET', 'TV']);
  });

  it('no revive PUNTOS desde una factura: no son un plan y salen de su propia fila', async () => {
    // A la abonada 2169 le apareció un 'Punto Adicional' de febrero de 2021, con
    // cantidad 0, en cuanto el respaldo empezó a correr para ella.
    const { srv } = armar([
      { kind: 'TV', planName: 'SoloTelevision22', price: 20168 },
      { kind: 'PUNTOS', planName: 'Punto Adicional', price: 5000 },
    ]);

    const r = await srv.conRespaldo([INTERNET], FILA);

    expect(r.map((x: any) => x.kind)).toEqual(['INTERNET', 'TV']);
  });

  it('un plan duplicado en el catálogo no se suma dos veces', async () => {
    // 'Plan' tiene filas que sólo se diferencian en la caja ('10MegasF' / '10megasF'):
    // sin dedupe, al abonado 1185 se le facturaba el internet dos veces.
    const { srv } = armar([
      { kind: 'INTERNET', planName: '10MegasF', price: 48000 },
      { kind: 'INTERNET', planName: '10megasF', price: 48000 },
    ]);

    const r = await srv.conRespaldo([TV], FILA);

    expect(r).toHaveLength(2);
    expect(r.filter((x: any) => x.kind === 'INTERNET')).toHaveLength(1);
  });
});
