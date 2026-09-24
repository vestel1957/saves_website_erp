import {
  centroActivo,
  centroDeAbonado,
  centroDeBodega,
  centroDeCaja,
  centroDeSede,
  centroDeTesoreria,
  centroGeneral,
  centroSinFallar,
  invalidarCacheCentros,
} from './centro-costo';

/**
 * Resolver único del centro de costo. Lo que se fija aquí: ante la duda, `null`
 * («Sin asignar», decisión D3) — nunca un centro inventado.
 */

type Fila = { legacyId: number; costCenter: { id: string; isActive: boolean } | null };

const SEDES: Fila[] = [
  { legacyId: 2, costCenter: { id: 'cc-yopal', isActive: true } },
  { legacyId: 3, costCenter: { id: 'cc-villanueva', isActive: true } },
  { legacyId: 8, costCenter: { id: 'cc-villavo', isActive: false } }, // desactivado
];

function prismaFalso(opts: {
  sedes?: Fila[];
  generales?: { id: string; code: string }[];
  abonado?: { branch: { legacyId: number } | null } | null;
  caja?: { branchLegacy: number | null } | null;
  bodegaMaterial?: { branchLegacy: number | null } | null;
  bodegaEquipos?: { branchLegacy: number | null } | null;
  centro?: { isActive: boolean } | null;
} = {}) {
  return {
    branch: { findMany: jest.fn().mockResolvedValue(opts.sedes ?? SEDES) },
    costCenter: {
      findMany: jest.fn().mockResolvedValue(opts.generales ?? [{ id: 'cc-admin', code: 'CC-ADMIN' }]),
      findUnique: jest.fn().mockResolvedValue(opts.centro ?? null),
    },
    subscriber: { findUnique: jest.fn().mockResolvedValue(opts.abonado ?? null) },
    cashAccount: { findUnique: jest.fn().mockResolvedValue(opts.caja ?? null) },
    materialWarehouse: { findUnique: jest.fn().mockResolvedValue(opts.bodegaMaterial ?? null) },
    equipmentWarehouse: { findUnique: jest.fn().mockResolvedValue(opts.bodegaEquipos ?? null) },
  } as any;
}

beforeEach(() => invalidarCacheCentros());

describe('centroDeSede', () => {
  it('sede con centro activo → su centro', async () => {
    expect(await centroDeSede(prismaFalso(), 2)).toBe('cc-yopal');
  });

  it('sede sin centro → null', async () => {
    expect(await centroDeSede(prismaFalso(), 5)).toBeNull();
  });

  it('sede cuyo centro está desactivado → null', async () => {
    expect(await centroDeSede(prismaFalso(), 8)).toBeNull();
  });

  it('0 (banco), null, negativos y no enteros → null sin consultar', async () => {
    const p = prismaFalso();
    for (const v of [0, null, undefined, -1, 2.5, NaN]) expect(await centroDeSede(p, v as any)).toBeNull();
    expect(p.branch.findMany).not.toHaveBeenCalled();
  });

  it('memoriza: varias preguntas (incluso a la vez) = una sola carga', async () => {
    const p = prismaFalso();
    await Promise.all([centroDeSede(p, 2), centroDeSede(p, 3), centroGeneral(p)]);
    await centroDeSede(p, 2);
    expect(p.branch.findMany).toHaveBeenCalledTimes(1);
  });

  it('invalidarCacheCentros obliga a recargar', async () => {
    const p = prismaFalso();
    await centroDeSede(p, 2);
    invalidarCacheCentros();
    p.branch.findMany.mockResolvedValue([{ legacyId: 2, costCenter: { id: 'cc-otro', isActive: true } }]);
    expect(await centroDeSede(p, 2)).toBe('cc-otro');
    expect(p.branch.findMany).toHaveBeenCalledTimes(2);
  });

  it('si la carga falla, lanza y NO deja la caché envenenada', async () => {
    const p = prismaFalso();
    p.branch.findMany.mockRejectedValueOnce(new Error('bd caída'));
    await expect(centroDeSede(p, 2)).rejects.toThrow('bd caída');
    expect(await centroDeSede(p, 2)).toBe('cc-yopal');
  });
});

describe('centroGeneral', () => {
  it('devuelve CC-ADMIN', async () => {
    expect(await centroGeneral(prismaFalso())).toBe('cc-admin');
  });

  it('con varios GENERAL activos manda CC-ADMIN', async () => {
    const p = prismaFalso({
      generales: [
        { id: 'cc-viejo', code: 'CC-OTRO' },
        { id: 'cc-admin', code: 'CC-ADMIN' },
      ],
    });
    expect(await centroGeneral(p)).toBe('cc-admin');
  });

  it('sin sembrar → null', async () => {
    expect(await centroGeneral(prismaFalso({ generales: [] }))).toBeNull();
  });
});

describe('centroDeAbonado', () => {
  it('abonado de Villanueva → centro de Villanueva', async () => {
    expect(await centroDeAbonado(prismaFalso({ abonado: { branch: { legacyId: 3 } } }), 's1')).toBe('cc-villanueva');
  });

  it('abonado SIN sede → null (no se inventa)', async () => {
    expect(await centroDeAbonado(prismaFalso({ abonado: { branch: null } }), 's1')).toBeNull();
  });

  it('abonado inexistente o id vacío → null', async () => {
    const p = prismaFalso({ abonado: null });
    expect(await centroDeAbonado(p, 'no-existe')).toBeNull();
    expect(await centroDeAbonado(p, '')).toBeNull();
    expect(await centroDeAbonado(p, null)).toBeNull();
  });
});

describe('centroDeCaja', () => {
  it('caja de sede → centro de la sede', async () => {
    const p = prismaFalso({ caja: { branchLegacy: 2 } });
    expect(await centroDeCaja(p, 11)).toBe('cc-yopal');
    expect(p.cashAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { legacyId: 11 } }));
  });

  it('caja de BANCO (branchLegacy 0) → null', async () => {
    expect(await centroDeCaja(prismaFalso({ caja: { branchLegacy: 0 } }), 1)).toBeNull();
  });

  it('caja sin sede, inexistente o sin id → null', async () => {
    expect(await centroDeCaja(prismaFalso({ caja: { branchLegacy: null } }), 1)).toBeNull();
    expect(await centroDeCaja(prismaFalso({ caja: null }), 999)).toBeNull();
    expect(await centroDeCaja(prismaFalso(), null)).toBeNull();
  });

  it('caja de una sede sin centro → null', async () => {
    expect(await centroDeCaja(prismaFalso({ caja: { branchLegacy: 5 } }), 1)).toBeNull();
  });
});

describe('centroDeTesoreria (ingreso/egreso sin centro elegido)', () => {
  it('caja de sede → el centro de la sede', async () => {
    expect(await centroDeTesoreria(prismaFalso({ caja: { branchLegacy: 3 } }), 12)).toBe('cc-villanueva');
  });

  it('caja de BANCO (branchLegacy 0) → Administración general', async () => {
    expect(await centroDeTesoreria(prismaFalso({ caja: { branchLegacy: 0 } }), 6)).toBe('cc-admin');
  });

  it('banco sin general sembrado/activo → null', async () => {
    expect(await centroDeTesoreria(prismaFalso({ caja: { branchLegacy: 0 }, generales: [] }), 6)).toBeNull();
  });

  it('caja sin sede (null ≠ banco), inexistente o sin caja → null', async () => {
    expect(await centroDeTesoreria(prismaFalso({ caja: { branchLegacy: null } }), 4)).toBeNull();
    expect(await centroDeTesoreria(prismaFalso({ caja: null }), 999)).toBeNull();
    const p = prismaFalso();
    expect(await centroDeTesoreria(p, null)).toBeNull();
    expect(await centroDeTesoreria(p, undefined)).toBeNull();
    expect(p.cashAccount.findUnique).not.toHaveBeenCalled();
  });

  it('caja de una sede cuyo centro está desactivado → null (no cae al general)', async () => {
    expect(await centroDeTesoreria(prismaFalso({ caja: { branchLegacy: 8 } }), 20)).toBeNull();
  });
});

describe('centroDeBodega', () => {
  it('bodega de material de una sede, por id → su centro', async () => {
    const p = prismaFalso({ bodegaMaterial: { branchLegacy: 3 } });
    expect(await centroDeBodega(p, { tipo: 'material', id: 'mw1' })).toBe('cc-villanueva');
    expect(p.materialWarehouse.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mw1' } }));
  });

  it('bodega de equipos, por legacyId → su centro', async () => {
    const p = prismaFalso({ bodegaEquipos: { branchLegacy: 2 } });
    expect(await centroDeBodega(p, { tipo: 'equipos', legacyId: 4 })).toBe('cc-yopal');
    expect(p.equipmentWarehouse.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { legacyId: 4 } }));
    expect(p.materialWarehouse.findUnique).not.toHaveBeenCalled();
  });

  it('bodega de TRÁNSITO (sin sede) → null', async () => {
    expect(await centroDeBodega(prismaFalso({ bodegaMaterial: { branchLegacy: null } }), { tipo: 'material', id: 'clientes' })).toBeNull();
    expect(await centroDeBodega(prismaFalso({ bodegaEquipos: { branchLegacy: null } }), { tipo: 'equipos', legacyId: 9 })).toBeNull();
  });

  it('bodega inexistente → null', async () => {
    expect(await centroDeBodega(prismaFalso(), { tipo: 'material', id: 'nada' })).toBeNull();
  });
});

describe('centroActivo', () => {
  it('existe y activo → true; inactivo, inexistente o vacío → false', async () => {
    expect(await centroActivo(prismaFalso({ centro: { isActive: true } }), 'cc')).toBe(true);
    expect(await centroActivo(prismaFalso({ centro: { isActive: false } }), 'cc')).toBe(false);
    expect(await centroActivo(prismaFalso({ centro: null }), 'cc')).toBe(false);
    expect(await centroActivo(prismaFalso(), null)).toBe(false);
  });
});

describe('centroSinFallar', () => {
  it('si el resolutor lanza, avisa y devuelve null (no tumba el asiento)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await centroSinFallar(() => Promise.reject(new Error('timeout')), 'pago p1');
    expect(r).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pago p1'), 'timeout');
    warn.mockRestore();
  });

  it('si no lanza, devuelve lo del resolutor', async () => {
    expect(await centroSinFallar(async () => 'cc-yopal', 'x')).toBe('cc-yopal');
  });
});
