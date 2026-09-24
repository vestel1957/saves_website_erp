import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { esCambioTitular, DETALLES_POR_CLASE } from './order-types';

/**
 * La orden de CAMBIO DE TITULAR: el servicio pasa a nombre de otra persona.
 *
 * Al abrirla tienen que pasar tres cosas: que la orden guarde quién queda y quién
 * era, que la ficha quede con los datos nuevos y marcada con `editedAt` (sin eso el
 * sync de ida devuelve el titular viejo a los 15 minutos) y que la observación —lo
 * que viaja al legacy— lo diga.
 */
const FICHA = {
  id: 'sub-1',
  nomenclature: null, addressLine: null, neighborhood: null,
  customerType: 'Natural', firstName: 'Marta', secondName: null, lastName1: 'Ruiz', lastName2: null,
  companyName: null, fullName: 'Marta Ruiz', docType: 'CC', docNumber: '63552114',
  phone1: '3100000000', phone2: '3200000000', email: 'marta@correo.com',
  branch: null,
};

function armar(ticket: any = null) {
  const creados: any[] = [];
  const fichas: any[] = [];
  const ordenes: any[] = [];
  const prisma = {
    subscriber: {
      findUnique: jest.fn().mockResolvedValue(FICHA),
      update: jest.fn((args: any) => { fichas.push(args.data); return Promise.resolve({}); }),
    },
    ticket: {
      findUnique: jest.fn().mockResolvedValue(ticket),
      update: jest.fn((args: any) => { ordenes.push(args.data); return Promise.resolve({}); }),
    },
    ticketThread: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-1', code: 500123 }); }) },
        subscriber: { update: jest.fn((args: any) => { fichas.push(args.data); return Promise.resolve({}); }) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500123n }]),
      }),
    ),
  };
  const porCargo = { notifyPost: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emit: jest.fn() };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, porCargo as any, eventos as any, {} as any, {} as any,
    undefined, undefined, { cobrar: jest.fn() } as any,
  );
  return { srv, creados, fichas, ordenes };
}

const USUARIO = { id: 'u-1', name: 'Cajera', email: 'caja@vestel.com.co', areas: ['caja'] } as any;

const NUEVO = {
  firstName: ' Pedro ', lastName1: 'Gómez', lastName2: 'Díaz',
  docType: 'cc', docNumber: '1.118.541.234', phone1: '3115550000',
};

describe('orden de cambio de titular', () => {
  it('es un detalle de servicio del catálogo', () => {
    expect(esCambioTitular(' cambio de titular ')).toBe(true);
    expect(esCambioTitular('Cambio de equipo')).toBe(false);
    expect(DETALLES_POR_CLASE.servicio).toContain('Cambio de titular');
  });

  it('guarda quién queda y quién era, y reescribe la persona en la ficha', async () => {
    const { srv, creados, fichas } = armar();
    const r: any = await srv.createTicket(
      { subscriberId: 'sub-1', subject: 'servicio', type: 'Cambio de titular', newHolder: NUEVO } as any,
      USUARIO,
    );

    expect(creados[0]).toMatchObject({
      type: 'Cambio de titular',
      holderToText: 'Pedro Gómez Díaz · CC 1118541234',
      holderFromText: 'Marta Ruiz · CC 63552114',
    });
    expect(creados[0].holderFrom).toMatchObject({ docNumber: '63552114', email: 'marta@correo.com' });
    expect(creados[0].section).toContain('Cambio de titular: de Marta Ruiz · CC 63552114 a Pedro Gómez Díaz · CC 1118541234.');

    // La ficha queda con la persona nueva ENTERA: el celular 2 y el correo de la
    // anterior no se quedan colgando.
    expect(fichas[0]).toMatchObject({
      firstName: 'Pedro', lastName1: 'Gómez', lastName2: 'Díaz', fullName: 'Pedro Gómez Díaz',
      docType: 'CC', docNumber: '1118541234', phone1: '3115550000', phone2: null, email: null,
    });
    expect(fichas[0].editedAt).toBeInstanceOf(Date);
    expect(r.cambioTitular).toEqual({ desde: 'Marta Ruiz · CC 63552114', hasta: 'Pedro Gómez Díaz · CC 1118541234' });
  });

  it('no se abre sin los datos del nuevo titular (salvo por chat)', async () => {
    const { srv } = armar();
    await expect(
      srv.createTicket({ subscriberId: 'sub-1', type: 'Cambio de titular' } as any, USUARIO),
    ).rejects.toThrow(/datos del nuevo titular/);

    const { srv: bot, creados, fichas } = armar();
    await bot.createTicket({ subscriberId: 'sub-1', type: 'Cambio de titular' } as any, USUARIO, { titularOpcional: true });
    expect(creados[0].holderToText).toBeUndefined();
    expect(fichas).toHaveLength(0);
  });

  it('exige nombre, documento y celular', async () => {
    const { srv } = armar();
    const crear = (h: any) => srv.createTicket({ subscriberId: 'sub-1', type: 'Cambio de titular', newHolder: h } as any, USUARIO);
    await expect(crear({ ...NUEVO, lastName1: '' })).rejects.toThrow(/primer apellido/);
    await expect(crear({ ...NUEVO, docNumber: ' ' })).rejects.toThrow(/documento/);
    await expect(crear({ ...NUEVO, phone1: '' })).rejects.toThrow(/celular/);
    await expect(crear({ ...NUEVO, customerType: 'Juridico', companyName: '' })).rejects.toThrow(/razón social/);
  });

  it('la empresa queda con la razón social como nombre', async () => {
    const { srv, fichas } = armar();
    await srv.createTicket(
      { subscriberId: 'sub-1', type: 'Cambio de titular', newHolder: { customerType: 'Juridico', companyName: 'Agro SAS', docType: 'NIT', docNumber: '900123', phone1: '3001112233' } } as any,
      USUARIO,
    );
    expect(fichas[0]).toMatchObject({ customerType: 'Juridico', companyName: 'Agro SAS', fullName: 'Agro SAS', firstName: null });
  });

  it('una orden del chatbot se completa al corregirla, y la ficha cambia', async () => {
    const orden = {
      id: 't-1', code: 500123, type: 'Cambio de titular', subject: 'servicio', subscriberId: 'sub-1',
      section: 'El cliente pide pasar el servicio a Pedro', problem: null, created: new Date('2026-09-17'),
      holderTo: null, holderToText: null, holderFromText: null, holderAppliedAt: null, graceDays: null,
    };
    const { srv, fichas, ordenes } = armar(orden);
    const r = await srv.updateTicket('t-1', { newHolder: NUEVO } as any, USUARIO);

    expect(ordenes[0]).toMatchObject({
      holderToText: 'Pedro Gómez Díaz · CC 1118541234',
      holderFromText: 'Marta Ruiz · CC 63552114',
    });
    expect(ordenes[0].section).toBe(
      'El cliente pide pasar el servicio a Pedro\nCambio de titular: de Marta Ruiz · CC 63552114 a Pedro Gómez Díaz · CC 1118541234.',
    );
    expect(fichas[0]).toMatchObject({ docNumber: '1118541234' });
    expect(r.cambios.join(' | ')).toMatch(/quedó a nombre de Pedro/);
  });

  it('corregir un titular ya registrado conserva quién era el anterior', async () => {
    const orden = {
      id: 't-1', code: 500123, type: 'Cambio de titular', subject: 'servicio', subscriberId: 'sub-1',
      section: 'Cambio de titular: de Marta Ruiz · CC 63552114 a Pedro Gomes · CC 1118541234.',
      problem: null, created: new Date('2026-09-17'), graceDays: null,
      holderTo: { firstName: 'Pedro', lastName1: 'Gomes' }, holderToText: 'Pedro Gomes · CC 1118541234',
      holderFromText: 'Marta Ruiz · CC 63552114', holderAppliedAt: new Date('2026-09-17'),
    };
    // La ficha ya tiene al nuevo (lo puso la misma orden): no puede pasar a ser "el anterior".
    const { srv, ordenes } = armar(orden);
    await srv.updateTicket('t-1', { newHolder: NUEVO } as any, USUARIO);
    expect(ordenes[0].holderFromText).toBeUndefined();
    expect(ordenes[0].section).toBe('Cambio de titular: de Marta Ruiz · CC 63552114 a Pedro Gómez Díaz · CC 1118541234.');
  });
});
