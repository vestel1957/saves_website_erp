import type { AgentUser, ToolContext } from '@s4gk/wa-agent';
import { ComercialToolset } from './comercial.toolset';
import { CHAT_CLIENTE_PERMISSION, type ChatIdentity } from '../chatbot.identity';
import { OFICINAS, PLANES_COMERCIALES } from '../tramites.catalogo';

/**
 * Lo que se prueba aquí es lo que el bot le puede DECIR a alguien que pregunta por
 * plata: cuánto vale un plan y dónde queda la oficina. Son las dos respuestas que más
 * caro salen mal —una tarifa equivocada se convierte en una promesa, y una dirección
 * equivocada en un viaje perdido—, así que se fijan sus dos garantías:
 *
 *  - los precios salen del catálogo comercial 2026 y NUNCA de los 72 planes muertos
 *    de la tabla `Plan` (el fallo que llegó a cotizar "1 Mega por $20.000");
 *  - una sede sin dirección en la BD igual sale con dirección, la del documento
 *    oficial, en vez de dejar al cliente a medias.
 */

function armar(over: { elegidos?: string[]; planes?: any[]; sedes?: any[]; empresa?: any } = {}) {
  const plans = { list: jest.fn(async () => over.planes ?? []) };
  const config = {
    branches: jest.fn(async () => over.sedes ?? []),
    company: jest.fn(async () => over.empresa ?? null),
  };
  const gate = { planesPublicos: jest.fn(async () => over.elegidos ?? []) };
  return new ComercialToolset(plans as any, config as any, gate as any);
}

const IDENTIDAD: ChatIdentity = { kind: 'cliente', subscriberId: 'sub-1', abonado: 1234 };

function ctx(): ToolContext {
  const user: AgentUser = {
    id: 'sub-1',
    name: 'Prueba',
    permissions: [CHAT_CLIENTE_PERMISSION],
    meta: { identity: IDENTIDAD },
  };
  return {
    user,
    convKey: 'kapso:573001112233',
    committing: false,
    can: () => true,
    canStrict: () => true,
    audit: async () => undefined,
  } as unknown as ToolContext;
}

describe('ComercialToolset', () => {
  describe('planes_disponibles', () => {
    it('sin planes elegidos en Configuración, cotiza el catálogo comercial 2026', async () => {
      const t = armar();
      const r = await t.execute('planes_disponibles', {}, ctx());

      // El plan estrella con su precio publicado, tal cual lo vende la fuerza comercial.
      expect(r).toContain('600 Megas');
      expect(r).toContain('110.000');
      expect(r).toContain('PLANES PARA EL HOGAR');
      expect(r).toContain('PLANES PARA NEGOCIOS');
      // Los 12 del catálogo, ni uno más: nada de la tabla `Plan`.
      PLANES_COMERCIALES.forEach((p) => expect(r).toContain(p.nombre));
    });

    it('con planes elegidos en Configuración, manda la BD y NO el catálogo', async () => {
      const t = armar({
        elegidos: ['p1'],
        planes: [
          { id: 'p1', name: 'Fibra 600', kind: 'INTERNET', megas: 600, price: 99_000 },
          { id: 'p2', name: 'Plan muerto del legacy', kind: 'INTERNET', megas: 1, price: 20_000 },
        ],
      });
      const r = await t.execute('planes_disponibles', {}, ctx());

      expect(r).toContain('Fibra 600');
      // El que no se eligió no se cotiza, aunque esté activo en la tabla.
      expect(r).not.toContain('Plan muerto del legacy');
      // Y el catálogo queda fuera: manda la BD.
      expect(r).not.toContain('PLANES PARA EL HOGAR');
    });

    it('avisa cuando no hay planes publicados del tipo que preguntan', async () => {
      const t = armar({ elegidos: ['p1'], planes: [] });
      const r = await t.execute('planes_disponibles', { tipo: 'TV' }, ctx());
      expect(r).toContain('No tengo planes publicados de ese tipo');
    });
  });

  describe('sedes', () => {
    /**
     * El caso real que lo motivó: la BD tenía «Diagonal 34 # 31B - 87» para Yopal y
     * el documento comercial «Carrera 20 #26-76». Manda el documento — la columna
     * `dir` de `Branch` arrastra direcciones de antes de los traslados.
     */
    it('el documento PISA a la dirección de la BD cuando difieren', async () => {
      const t = armar({ sedes: [{ id: 's1', name: 'Yopal', dir: 'Diagonal 34 # 31B - 87' }] });
      const r = await t.execute('sedes', {}, ctx());
      expect(r).toContain(OFICINAS.yopal);
      expect(r).not.toContain('Diagonal 34 # 31B - 87');
    });

    it('también manda el documento cuando la sede no tiene dirección en la BD', async () => {
      const t = armar({ sedes: [{ id: 's1', name: 'CABECERA AGUAZUL', dir: null }] });
      const r = await t.execute('sedes', {}, ctx());
      expect(r).toContain(OFICINAS.aguazul);
    });

    /** Mocoa y Villavicencio existen en la BD pero no en el documento. */
    it('una sede fuera del documento conserva la dirección de la BD', async () => {
      const t = armar({ sedes: [{ id: 's1', name: 'Mocoa', dir: 'Calle 7 #4-11' }] });
      const r = await t.execute('sedes', {}, ctx());
      expect(r).toContain('Calle 7 #4-11');
    });

    it('reconoce el municipio dentro de nombres del legacy, con prefijos y tildes', async () => {
      const t = armar({
        sedes: [
          { id: 's1', name: 'Almacen cabecera Villanueva', dir: '' },
          { id: 's2', name: 'MONTERREY', dir: undefined },
        ],
      });
      const r = await t.execute('sedes', {}, ctx());
      expect(r).toContain(OFICINAS.villanueva);
      expect(r).toContain(OFICINAS.monterrey);
    });

    it('una sede que no es de ningún municipio conocido no inventa dirección', async () => {
      const t = armar({ sedes: [{ id: 's1', name: 'Bodega central', dir: null }] });
      const r = await t.execute('sedes', {}, ctx());
      expect(r).toContain('dirección no registrada');
    });

    it('sin sedes en la BD, da igual las oficinas del documento', async () => {
      const t = armar({ sedes: [] });
      const r = await t.execute('sedes', {}, ctx());
      Object.values(OFICINAS).forEach((dir) => expect(r).toContain(dir));
    });
  });

  it('datos_empresa no se inventa nada cuando no hay ficha', async () => {
    const t = armar({ empresa: null });
    const r = await t.execute('datos_empresa', {}, ctx());
    expect(r).toContain('No tengo los datos de contacto');
  });

  it('una herramienta que no es suya se rechaza, no se adivina', async () => {
    const t = armar();
    expect(await t.execute('mi_estado_de_cuenta', {}, ctx())).toContain('no disponible');
  });
});
