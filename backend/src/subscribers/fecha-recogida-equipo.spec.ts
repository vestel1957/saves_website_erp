import { SubscribersService } from './subscribers.service';

/**
 * La fecha de recogida de una devolución de equipo.
 *
 * Lo que se prueba aquí no es que guarde una fecha, sino los tres filtros que la
 * separan de un dato inventado: el futuro (el equipo aún no se ha recogido), el día
 * que no existe —`new Date('2026-02-31')` no falla, rueda al 3 de marzo— y el año mal
 * tecleado, que es el error que nadie detecta después porque parece una fecha buena.
 *
 * Se llama al método directamente: no hace falta base de datos para probar un
 * calendario, y un doble de Prisma aquí sólo probaría el doble.
 */
const servicio = new SubscribersService(null as any, null as any, null as any, null as any);
const dia = (texto?: string): Date => (servicio as any).diaDeRecogida(texto);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Hoy en Colombia, que es contra lo que compara el servicio (no contra el reloj del servidor). */
const hoyCO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

describe('fecha de recogida del equipo devuelto', () => {
  it('sin fecha = hoy en Colombia', () => {
    expect(iso(dia())).toBe(hoyCO);
    expect(iso(dia('   '))).toBe(hoyCO);
  });

  it('guarda el día que se pidió, a medianoche UTC (columna `date`)', () => {
    const d = dia('2026-08-20');
    expect(iso(d)).toBe('2026-08-20');
    // Medianoche UTC exacta: es lo que hace que la ficha lo pinte como 20/08 en Bogotá
    // en vez de correrlo al día anterior. Ver `fmtDate` del frontend.
    expect(d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds()).toBe(0);
  });

  it('acepta una fecha con hora (ISO completo) quedándose con el día', () => {
    expect(iso(dia('2026-08-20T15:30:00.000Z'))).toBe('2026-08-20');
  });

  it('rechaza el futuro', () => {
    const manana = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(() => dia(manana)).toThrow(/futura/i);
  });

  it('rechaza un día que no existe en el calendario', () => {
    expect(() => dia('2026-02-31')).toThrow(/no existe/i);
  });

  it('rechaza el año mal tecleado (más de un año atrás)', () => {
    expect(() => dia('2015-08-20')).toThrow(/un año/i);
  });

  it('rechaza lo que no es una fecha', () => {
    expect(() => dia('ayer')).toThrow(/válida/i);
  });
});
