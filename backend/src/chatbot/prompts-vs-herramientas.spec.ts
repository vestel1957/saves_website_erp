import type { AgentUser, ToolContext } from '@s4gk/wa-agent';
import { promptCliente, promptPublico } from './chatbot.prompts';
import { CHAT_CLIENTE_PERMISSION, CHAT_PUBLICO_PERMISSION, type ChatIdentity } from './chatbot.identity';
import { combineToolsets } from './toolsets/toolset.util';
import { ClienteToolset } from './toolsets/cliente.toolset';
import { PublicoToolset } from './toolsets/publico.toolset';
import { ComercialToolset } from './toolsets/comercial.toolset';
import { TramitesToolset } from './toolsets/tramites.toolset';
import { TRAMITES } from './tramites.catalogo';

/**
 * El candado contra el fallo que se arregló el 2026-08-03: el prompt del agente de
 * CLIENTES le mandaba usar `planes_disponibles` —y el guion del cambio de plan
 * también— pero esa herramienta solo se le declaraba al agente PÚBLICO. El modelo la
 * pedía, no existía para él, y acababa improvisando un precio o rindiéndose delante
 * del cliente. Lo mismo con `sedes` en el guion del cambio de titular.
 *
 * Es un fallo silencioso: compila, arranca y las pruebas de cada toolset pasan. Solo
 * se ve escribiéndole al bot. De ahí esta prueba, que compara las DOS mitades:
 *
 *   lo que el texto le dice al modelo que use  ⟷  lo que el agente tiene declarado
 *
 * Se buscan solo nombres que sean herramientas REALES de algún toolset. Así los
 * slugs de trámite (`falla_internet`, `cambio_plan`) y los temas de info comercial
 * (`pronto_pago`) no cuentan como falsos positivos: no son herramientas de nadie.
 */

/** Dobles vacíos: aquí no se ejecuta ninguna herramienta, solo se declaran. */
const doble = () => ({}) as any;

function toolsets() {
  const cliente = new ClienteToolset(doble(), doble(), doble(), doble(), doble(), doble(), doble());
  const publico = new PublicoToolset(doble(), doble(), doble());
  const comercial = new ComercialToolset(doble(), doble(), doble());
  const tramites = new TramitesToolset(doble(), doble(), doble(), doble());
  return { cliente, publico, comercial, tramites };
}

function ctx(identity: ChatIdentity): ToolContext {
  const user: AgentUser = {
    id: identity.kind === 'cliente' ? 'sub-1' : 'wa:573001112233',
    name: 'Prueba Pérez',
    permissions: [identity.kind === 'cliente' ? CHAT_CLIENTE_PERMISSION : CHAT_PUBLICO_PERMISSION],
    meta: { identity },
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

const IDENT_CLIENTE: ChatIdentity = { kind: 'cliente', subscriberId: 'sub-1', abonado: 1234 };
const IDENT_PUBLICO: ChatIdentity = { kind: 'publico', phone: '573001112233' };

/** Todos los nombres de herramienta que existen en los toolsets de cara al cliente. */
function universo(): Set<string> {
  const { cliente, publico, comercial, tramites } = toolsets();
  const c = ctx(IDENT_CLIENTE);
  const p = ctx(IDENT_PUBLICO);
  return new Set([
    ...cliente.definitions(c).map((d) => d.name),
    ...tramites.definitions(c).map((d) => d.name),
    ...comercial.definitions(c).map((d) => d.name),
    ...publico.definitions(p).map((d) => d.name),
  ]);
}

/** Las herramientas que un texto le pide al modelo que use. */
function mencionadas(texto: string, todas: Set<string>): string[] {
  return [...todas].filter((n) => new RegExp(`\\b${n}\\b`).test(texto));
}

describe('los prompts no mandan usar herramientas que el agente no tiene', () => {
  const todas = universo();

  it('agente de CLIENTES: todo lo que su prompt nombra, lo tiene declarado', () => {
    const { cliente, comercial, tramites } = toolsets();
    const c = ctx(IDENT_CLIENTE);
    const suyas = new Set(combineToolsets(cliente, comercial, tramites).definitions(c).map((d) => d.name));

    const pedidas = mencionadas(promptCliente(ctx(IDENT_CLIENTE).user), todas);
    // Si esto queda vacío, la prueba no está probando nada: el prompt SÍ nombra
    // herramientas, y quedarse sin ninguna significaría que se rompió el escaneo.
    expect(pedidas.length).toBeGreaterThan(5);
    expect(pedidas.filter((n) => !suyas.has(n))).toEqual([]);
  });

  it('agente PÚBLICO: todo lo que su prompt nombra, lo tiene declarado', () => {
    const { publico, comercial, tramites } = toolsets();
    const p = ctx(IDENT_PUBLICO);
    const suyas = new Set(combineToolsets(publico, comercial, tramites).definitions(p).map((d) => d.name));

    const pedidas = mencionadas(promptPublico(ctx(IDENT_PUBLICO).user), todas);
    expect(pedidas.length).toBeGreaterThan(5);
    expect(pedidas.filter((n) => !suyas.has(n))).toEqual([]);
  });

  /**
   * Los guiones de los trámites llegan al modelo por `condiciones_de_tramite`, así
   * que son prompt igual que el otro — y ahí estaba escondida la otra mitad del
   * fallo: el guion de `cambio_plan` decía "muéstrale los planes con
   * planes_disponibles" y el de `cambio_titular` mandaba a `sedes`.
   */
  it('los guiones de los trámites solo nombran herramientas que el cliente tiene', () => {
    const { cliente, comercial, tramites } = toolsets();
    const c = ctx(IDENT_CLIENTE);
    const suyas = new Set(combineToolsets(cliente, comercial, tramites).definitions(c).map((d) => d.name));

    const faltan = Object.entries(TRAMITES).flatMap(([slug, def]) =>
      mencionadas([def.guion, def.costo ?? '', def.tiempo ?? ''].join(' '), todas)
        .filter((n) => !suyas.has(n))
        .map((n) => `${slug} → ${n}`),
    );
    expect(faltan).toEqual([]);
  });
});
