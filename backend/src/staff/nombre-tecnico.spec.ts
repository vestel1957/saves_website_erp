import { olvidarNombres, traductorDeTecnicos } from './nombre-tecnico';

/**
 * Muestra real de la base: los 115 valores distintos de `Ticket.assigned` son
 * nombres de usuario del legacy, ni uno solo es un nombre de persona. Aquí van
 * los de más volumen, más un ex-empleado y uno cuya ficha ya no existe.
 */
const FICHAS = [
  { username: 'NaimeSistemas', name: 'Nayme  Jimenez', banned: false },
  { username: 'OmarTec', name: 'Omar Jose Balcazar', banned: false },
  { username: 'Fabiantecnico', name: 'Luis Fabian Arevalo Lopez ', banned: true },
  { username: null, name: 'Nueva Contratada', banned: false },
];

const prisma = { staff: { findMany: async () => FICHAS } } as any;

beforeEach(() => olvidarNombres());

describe('traductorDeTecnicos', () => {
  it('traduce el username del legacy al nombre completo', async () => {
    const tr = await traductorDeTecnicos(prisma);
    expect(tr.nombre('NaimeSistemas')).toBe('Nayme  Jimenez');
    // Con la basura de captura que trae el legacy: mayúsculas y espacios.
    expect(tr.nombre(' omartec ')).toBe('Omar Jose Balcazar');
  });

  it('deja pasar el texto de quien no tiene ficha, en vez de borrarle el técnico a la orden', async () => {
    const tr = await traductorDeTecnicos(prisma);
    expect(tr.nombre('EverMauricioTEC')).toBe('EverMauricioTEC');
    expect(tr.nombre('')).toBeNull();
    expect(tr.nombre(null)).toBeNull();
  });

  it('filtrar por el nombre encuentra también las órdenes viejas escritas con el username', async () => {
    const tr = await traductorDeTecnicos(prisma);
    expect(tr.claves('Omar Jose Balcazar').sort()).toEqual(['Omar Jose Balcazar', 'OmarTec'].sort());
    // Quien nunca tuvo username solo puede estar escrito con su nombre.
    expect(tr.claves('Nueva Contratada')).toEqual(['Nueva Contratada']);
    // Sin ficha que case, el propio texto es la única llave que hay.
    expect(tr.claves('AlexisTecnico')).toEqual(['AlexisTecnico']);
  });

  it('buscar por el apellido trae las claves de esa persona', async () => {
    const tr = await traductorDeTecnicos(prisma);
    expect(tr.clavesPorTexto('balcazar').sort()).toEqual(['Omar Jose Balcazar', 'OmarTec'].sort());
    expect(tr.clavesPorTexto('nadie')).toEqual([]);
  });

  it('reconoce al inhabilitado por cualquiera de sus dos formas, y no acusa al desconocido', async () => {
    const tr = await traductorDeTecnicos(prisma);
    expect(tr.inhabilitado('Fabiantecnico')).toBe(true);
    expect(tr.inhabilitado('Luis Fabian Arevalo Lopez')).toBe(true);
    expect(tr.inhabilitado('OmarTec')).toBe(false);
    // Un texto sin ficha NO es un inhabilitado: es un desconocido, y se muestra.
    expect(tr.inhabilitado('EverMauricioTEC')).toBe(false);
  });
});
