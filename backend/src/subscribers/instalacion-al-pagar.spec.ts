import { AltaClienteService } from './alta.service';

/**
 * La regla que se prueba aquí: la orden de instalación nace CUANDO SE PAGA la factura
 * de afiliación, una sola vez.
 *
 * Lo caro de este flujo no es abrir la orden: es abrirla DOS veces. Al mismo pago lo
 * pueden ver dos caminos —el evento del recaudo y el barrido de los 5 minutos— y el
 * técnico acabaría con dos visitas para la misma casa. El candado es el `updateMany`
 * condicionado a `fulfilledAt: null`; eso es lo que se comprueba.
 *
 * El SEGUNDO duplicado, el que de verdad se vio en producción (2026-09-02, abonado
 * 57443), no lo abría nexus dos veces: lo abría el sistema anterior por su cuenta al
 * cobrarse la afiliación por el PORTAL —PSE paga allá— y nexus abría la suya cinco
 * minutos después. Por eso aquí también se prueba que una orden que YA EXISTE se adopta
 * en vez de crear otra.
 *
 * El alta completa no se prueba con un doble de Prisma: sería probar que el mock hace
 * lo que el mock hace.
 */

type Fila = {
  id: string; subscriberId: string; context: string | null; assigned: string | null;
  scheduledFor: Date | null; fulfilledAt: Date | null; ticketId: string | null;
  ticketCode: number | null; lastError: string | null; invoiceStatus: string;
  createdAt: Date; invoiceTid: number | null;
};

/** Una orden de instalación que ya está en la base (traída del sistema anterior). */
type OrdenYaExistente = {
  id: string; code: number; subscriberId: string; section: string | null;
  problem: string | null; invoiceLegacy: number | null; status?: string;
};

function servicioDePrueba(
  filas: Fila[],
  opts?: { fallaCrearOrden?: boolean; yaExisten?: OrdenYaExistente[] },
) {
  const ordenes: { subscriberId: string; section?: string; assigned?: string }[] = [];
  const existentes = opts?.yaExisten ?? [];
  const editadas: { id: string; data: any }[] = [];
  const prisma: any = {
    ticket: {
      // Reproduce el `findFirst` de `buscarOrdenInstalacion`: por factura o por ser
      // posterior al alta, y nunca una anulada.
      findFirst: async ({ where }: any) => {
        const desde = where.OR.find((o: any) => o.createdAt)?.createdAt?.gte;
        const tid = where.OR.find((o: any) => o.invoiceLegacy)?.invoiceLegacy;
        return existentes.find((o) =>
          o.subscriberId === where.subscriberId &&
          (o.status ?? 'PENDIENTE') !== 'ANULADA' &&
          ((tid != null && o.invoiceLegacy === tid) || desde !== undefined)) ?? null;
      },
      update: async ({ where, data }: any) => { editadas.push({ id: where.id, data }); return { id: where.id }; },
    },
    pendingInstall: {
      findMany: async ({ where }: any) =>
        filas
          .filter((f) =>
            f.fulfilledAt === null &&
            f.invoiceStatus === where.invoice.status &&
            (where.subscriberId === undefined || f.subscriberId === where.subscriberId))
          .map((f) => ({ ...f, invoice: { tid: f.invoiceTid } })),
      // El `updateMany` condicionado es el candado: sólo cuenta 1 la primera vez.
      updateMany: async ({ where, data }: any) => {
        const f = filas.find((x) => x.id === where.id && x.fulfilledAt === null);
        if (!f) return { count: 0 };
        Object.assign(f, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        const f = filas.find((x) => x.id === where.id)!;
        Object.assign(f, data);
        return f;
      },
    },
  };
  const soporte: any = {
    createTicket: async (dto: any) => {
      if (opts?.fallaCrearOrden) throw new Error('soporte caído');
      ordenes.push(dto);
      return { id: `t${ordenes.length}`, code: 900 + ordenes.length };
    },
  };
  const alta = new AltaClienteService(prisma, {} as any, {} as any, {} as any, soporte);
  return { alta, ordenes, filas, editadas };
}

const pendiente = (over: Partial<Fila> = {}): Fila => ({
  id: 'p1', subscriberId: 's1', context: 'Dirección: CL 1 · Tecnología: FTTH',
  assigned: null, scheduledFor: null, fulfilledAt: null, ticketId: null,
  ticketCode: null, lastError: null, invoiceStatus: 'PAID',
  createdAt: new Date('2026-09-02T10:00:00Z'), invoiceTid: null, ...over,
});

describe('La orden de instalación nace al pagarse la afiliación', () => {
  // El chequeo contra el MySQL del sistema anterior se apaga aquí a propósito: lo que
  // se prueba es la lógica, no la conexión. Sin `LEGACY_DB_*` la consulta responde
  // «no pude preguntar» y el flujo sigue por el camino de siempre.
  const legacyEnv = { ...process.env };
  beforeEach(() => { delete process.env.LEGACY_DB_HOST; });
  afterAll(() => { process.env = legacyEnv; });

  it('abre la orden cuando la factura de afiliación quedó PAGADA', async () => {
    const { alta, ordenes, filas } = servicioDePrueba([pendiente()]);

    expect(await alta.alPagarAfiliacion('s1')).toEqual({ creadas: 1, adoptadas: 0 });
    expect(ordenes).toHaveLength(1);
    // Clase/detalle exactos: son los que reconoce la cascada de cierre.
    expect(ordenes[0]).toMatchObject({ subscriberId: 's1', subject: 'servicio', type: 'Instalacion' });
    // El contexto de la visita se guardó en el alta y viaja a la orden semanas después.
    expect(ordenes[0].section).toContain('Dirección: CL 1');
    expect(filas[0].ticketCode).toBe(901);
  });

  it('NO abre nada mientras la factura siga sin pagarse', async () => {
    const { alta, ordenes } = servicioDePrueba([pendiente({ invoiceStatus: 'DUE' })]);
    expect(await alta.alPagarAfiliacion('s1')).toEqual({ creadas: 0, adoptadas: 0 });
    expect(ordenes).toHaveLength(0);
  });

  it('no duplica la orden si el evento y el barrido ven el mismo pago', async () => {
    const { alta, ordenes } = servicioDePrueba([pendiente()]);
    await alta.alPagarAfiliacion('s1');
    await alta.barrerInstalacionesPagadas();
    expect(ordenes).toHaveLength(1);
  });

  it('si la creación falla, la instalación vuelve a la cola con el motivo', async () => {
    const { alta, filas } = servicioDePrueba([pendiente()], { fallaCrearOrden: true });
    expect(await alta.barrerInstalacionesPagadas()).toEqual({ creadas: 0, adoptadas: 0 });
    expect(filas[0].fulfilledAt).toBeNull(); // se soltó el sello: se reintenta
    expect(filas[0].lastError).toBe('soporte caído');
  });

  it('el barrido recoge a quien pagó en el legacy (sin evento de por medio)', async () => {
    const { alta, ordenes } = servicioDePrueba([
      pendiente({ id: 'p1', subscriberId: 's1' }),
      pendiente({ id: 'p2', subscriberId: 's2' }),
      pendiente({ id: 'p3', subscriberId: 's3', invoiceStatus: 'PARTIAL' }),
    ]);
    expect(await alta.barrerInstalacionesPagadas()).toEqual({ creadas: 2, adoptadas: 0 });
    expect(ordenes.map((o) => o.subscriberId)).toEqual(['s1', 's2']);
  });
  // ── El duplicado de verdad: la orden que abre el sistema anterior ──────────
  // Pagar por el PORTAL (PSE) aplica el pago ALLÁ, y allá `validacion_generar_orden_instalacion`
  // abre la orden sola. Nexus la ve entrar por el sync y no debe abrir una segunda.

  it('adopta la orden que ya abrió el sistema anterior en vez de abrir otra', async () => {
    const { alta, ordenes, filas, editadas } = servicioDePrueba([pendiente({ invoiceTid: 504967 })], {
      yaExisten: [{
        id: 'tLegacy', code: 505246, subscriberId: 's1',
        // Lo que escribe el legacy: los servicios contratados y nada más.
        section: 'TV + 100 MEGAS', problem: null, invoiceLegacy: 504967,
      }],
    });

    expect(await alta.barrerInstalacionesPagadas()).toEqual({ creadas: 0, adoptadas: 1 });
    expect(ordenes).toHaveLength(0);                 // no se abrió ninguna nueva
    expect(filas[0].ticketCode).toBe(505246);        // la instalación apunta a LA SUYA
    expect(filas[0].fulfilledAt).not.toBeNull();     // y queda cerrada: no se reintenta
  });

  it('a la orden adoptada le añade el contexto de la visita sin pisar lo del legacy', async () => {
    const { alta, editadas } = servicioDePrueba([pendiente({ invoiceTid: 504967 })], {
      yaExisten: [{
        id: 'tLegacy', code: 505246, subscriberId: 's1',
        section: 'TV + 100 MEGAS', problem: null, invoiceLegacy: 504967,
      }],
    });
    await alta.barrerInstalacionesPagadas();

    expect(editadas).toHaveLength(1);
    expect(editadas[0].data.section).toBe('TV + 100 MEGAS\nDirección: CL 1 · Tecnología: FTTH');
    expect(editadas[0].data.problem).toBe('Instalación de servicio nuevo');
    // Sin `editedAt` la ida le devolvería el `section` del legacy en la pasada siguiente
    // y el añadido no viajaría de vuelta allá.
    expect(editadas[0].data.editedAt).toBeInstanceOf(Date);
  });

  it('la orden que abre nexus queda atada a la factura de afiliación', async () => {
    // `tickets.id_invoice` es la marca con la que el legacy comprueba que la
    // instalación ya tiene orden: sin ella abriría la suya al primer pago que le entre.
    const { alta, editadas } = servicioDePrueba([pendiente({ invoiceTid: 504967 })]);
    await alta.barrerInstalacionesPagadas();
    expect(editadas).toEqual([{ id: 't1', data: { invoiceLegacy: 504967 } }]);
  });

  it('una orden ANULADA no cuenta: la instalación se vuelve a abrir', async () => {
    const { alta, ordenes } = servicioDePrueba([pendiente({ invoiceTid: 504967 })], {
      yaExisten: [{
        id: 'tAnulada', code: 505246, subscriberId: 's1', status: 'ANULADA',
        section: null, problem: null, invoiceLegacy: 504967,
      }],
    });
    expect(await alta.barrerInstalacionesPagadas()).toEqual({ creadas: 1, adoptadas: 0 });
    expect(ordenes).toHaveLength(1);
  });
});
