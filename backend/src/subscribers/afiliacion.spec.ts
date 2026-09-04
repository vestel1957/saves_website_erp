import { nombreSugerido, resolverAfiliacion } from './afiliacion';
import { AltaClienteService } from './alta.service';

/**
 * Lo que se prueba aquí: al dar de alta a un cliente se le cobra la AFILIACIÓN, no la
 * mensualidad.
 *
 * El caso que lo destapó (2026-08-29, abonado 57439): el alta emitió una RECURRENTE de
 * 76.900 —100 MEGAS + Television, o sea el mes— cuando lo que la empresa cobra al entrar
 * son los 70.000 de «Afiliación Combo». La cajera recibió esos 70.000 contra la factura
 * de 76.900 y la clienta entró debiendo 6.900 el mismo día. Por eso el test mira dos
 * cosas concretas: que el renglón sea el producto de afiliación y que el `kind` sea FIJA.
 */

const CATALOGO = [
  { id: 'm1', name: 'Afiliación Combo', price: 70000, taxRate: 0, legacyId: 47 },
  { id: 'm2', name: 'Afiliación Internet solo', price: 70000, taxRate: 0, legacyId: 516 },
  { id: 'm3', name: 'Afiliación Television', price: 70000, taxRate: 0, legacyId: 46 },
  { id: 'm4', name: 'Afiliación Villavo', price: 50000, taxRate: 0, legacyId: 3419 },
];

const prismaConCatalogo = (filas = CATALOGO): any => ({
  material: { findMany: async () => filas },
});

describe('qué afiliación toca', () => {
  it('propone la del servicio contratado', () => {
    expect(nombreSugerido(['INTERNET', 'TV'])).toBe('Afiliación Combo');
    expect(nombreSugerido(['INTERNET'])).toBe('Afiliación Internet solo');
    expect(nombreSugerido(['TV'])).toBe('Afiliación Television');
  });

  it('no se inventa una afiliación cuando no hay plan del que deducirla', () => {
    expect(nombreSugerido([])).toBeNull();
    expect(nombreSugerido(['STREAMING'])).toBeNull();
  });

  it('resuelve por servicio y respeta la elegida a mano', async () => {
    const p = prismaConCatalogo();
    expect((await resolverAfiliacion(p, { servicios: ['INTERNET', 'TV'] }))?.name).toBe('Afiliación Combo');
    // Villavo no sale de ningún plan: se elige a mano y manda sobre la sugerida.
    expect((await resolverAfiliacion(p, { materialId: 'm4', servicios: ['INTERNET', 'TV'] }))?.price).toBe(50000);
  });

  it('deja pisar el precio (promoción) sin cambiar el concepto', async () => {
    const a = await resolverAfiliacion(prismaConCatalogo(), { servicios: ['INTERNET'], precio: 35000 });
    expect(a).toMatchObject({ name: 'Afiliación Internet solo', price: 35000 });
  });

  it('no cobra nada si el id elegido no está en el catálogo', async () => {
    expect(await resolverAfiliacion(prismaConCatalogo(), { materialId: 'noexiste', servicios: ['INTERNET'] })).toBeNull();
  });
});

/** Doble mínimo del alta: sólo interesa con qué se llama a `createInvoice`. */
function servicioDeAlta(catalogo = CATALOGO) {
  const emitidas: any[] = [];
  const facturas: any = {
    createInvoice: async (dto: any) => {
      emitidas.push(dto);
      return { id: 'inv1', tid: 500036, total: 70000 };
    },
  };
  const alta = new AltaClienteService(prismaConCatalogo(catalogo), {} as any, {} as any, facturas, {} as any);
  return { alta, emitidas };
}

/** `primeraFactura` es privado a propósito: el alta lo encadena, nadie lo llama suelto. */
const primeraFactura = (alta: AltaClienteService, dto: any, planes: any[]) =>
  (alta as any).primeraFactura('s1', dto, planes, { name: 'Cajera' });

const COMBO = [
  { name: '100 MEGAS', price: 65000, taxRate: 0, kind: 'INTERNET' },
  { name: 'Television', price: 10000, taxRate: 19, kind: 'TV' },
];

describe('la factura del alta', () => {
  it('cobra la afiliación y NO la mensualidad', async () => {
    const { alta, emitidas } = servicioDeAlta();
    const paso = await primeraFactura(alta, {}, COMBO);

    expect(paso.hecho).toBe(true);
    expect(emitidas).toHaveLength(1);
    // Cargo puntual, no mensualidad: de esto dependen el recibo de caja y el cierre.
    expect(emitidas[0].kind).toBe('FIJA');
    expect(emitidas[0].items).toEqual([
      { description: 'Afiliación Combo', productName: 'Afiliación Combo', qty: 1, price: 70000, taxRate: 0 },
    ]);
    // Los 76.900 del bug: ningún renglón puede ser el plan.
    expect(emitidas[0].items.some((i: any) => i.productName === '100 MEGAS')).toBe(false);
  });

  it('suma la instalación cuando se cobra aparte', async () => {
    const { alta, emitidas } = servicioDeAlta();
    await primeraFactura(alta, { installCharge: 30000 }, COMBO);
    expect(emitidas[0].items.map((i: any) => [i.productName, i.price])).toEqual([
      ['Afiliación Combo', 70000], ['Instalacion', 30000],
    ]);
  });

  it('no emite factura si la afiliación se regala: la orden se abre de una vez', async () => {
    const { alta, emitidas } = servicioDeAlta();
    const paso = await primeraFactura(alta, { affiliationPrice: 0 }, COMBO);
    expect(paso.hecho).toBe(false);
    expect(emitidas).toHaveLength(0);
  });

  it('avisa en vez de cobrar a ciegas cuando no hay plan ni elección', async () => {
    const { alta, emitidas } = servicioDeAlta();
    const paso = await primeraFactura(alta, {}, []);
    expect(paso.hecho).toBe(false);
    expect(paso.motivo).toMatch(/no se pudo deducir la afiliación/i);
    expect(emitidas).toHaveLength(0);
  });
});
