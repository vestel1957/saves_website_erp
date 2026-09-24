import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { Mikrotik } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { APP_PERMISSIONS, tienePermisoNominal } from '../auth/permissions.catalog';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { RouterosClient, RouterosError } from './routeros/routeros-client';
import { decryptSecret, encryptSecret } from '../common/secret-box';
import { IpAllocatorService } from './ip-allocator.service';
import { conservaEstadoAlReconectar } from './estado-al-reconectar';
import { esUsuarioPppUtil } from '../subscribers/conexion-alta';
import { esIpRemotaUtil } from '../support/ip-remota.policy';
import { filtrarCortables, fraseProtegidos } from '../common/corte.policy';
import type { OrdenesAutomaticasService } from '../support/ordenes-automaticas.service';
import type { EmisorDeEventos } from '../core/eventos';
import { ESTADO_SERVICIO_EVENT, type EstadoServicioEvent } from '../subscribers/subscribers.events';
import { subName } from '../common/subscriber-name';
import { lecturaMikrotikDeFilas, pasoRouterOsComoTexto, type LecturaMikrotikVlans, type PasoRouterOs } from './vlan-salud';

/**
 * Integración real de corte / reconexión contra los MikroTik de Vestel.
 *
 * Porta las funciones de producción del legacy
 * (`Customers_model.php::activar_estado_usuario` / `desactivar_estado_usuario`):
 *   CORTE:      cerrar sesión PPP activa → mover IP de ACTIVOS a MOROSOS (el secret NO se toca)
 *   RECONEXIÓN: quitar de MOROSOS → agregar a ACTIVOS → habilitar secret si quedó deshabilitado
 *
 * Quien bloquea es la regla de firewall `chain=forward action=drop` sobre la
 * address-list MOROSOS (en src y dst), igual que `Clientgroup::cortar_usuarios_multiple`
 * del legacy, que nunca deshabilita el secret. La reconexión sí sigue habilitando el
 * secret para sanar a los ~1.150 clientes cortados con el mecanismo viejo (disabled=yes).
 *
 * Resolución de router: por sede (branch.legacyId == mikrotik.sedeLegacy) y tecnología
 * de instalación; si no hay match exacto se usa el marcado como `isDefault`.
 *
 * ⚠️ SEGURIDAD: por defecto opera en DRY-RUN (no abre socket, sólo devuelve el plan de
 * comandos). Para ejecutar de verdad contra los routers de producción hay que arrancar
 * el backend con MIKROTIK_LIVE=true. Cada intento —real o simulado— queda auditado.
 */

const ADDRESS_LIST_ACTIVE = 'ACTIVOS';
const ADDRESS_LIST_DEBTOR = 'MOROSOS';

/**
 * ¿La ficha trae una IP usable? Ojo con `"0"`: 1.611 abonados lo tienen como
 * `ipRemote` (basura heredada del legacy) y tratarlo como IP buena significaba
 * mandarle al router `remote-address=0` y, sobre todo, no repartirles nunca una
 * de verdad — que es justo lo que los deja sin poder cortarse.
 */
const esIpValida = (v?: string | null): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test((v ?? '').trim());

/**
 * La IP local (`local-address`) que le toca a un secret nuevo, sacada de sus
 * vecinos en el router.
 *
 * Hasta 2026-09-16 el alta sólo la ponía si la ficha la traía, y a un abonado
 * nuevo nadie se la escribe: los secrets creados por nexus nacían sin
 * `local-address` (ANAPAULAINASALDUADEDAZA en Monterrey, y todos los de esa
 * semana). No es un valor fijo por router: Tauramena reparte 10.100.0.1 y
 * 10.1.100.1 según la red, así que manda la más usada en el MISMO /24 de la IP
 * remota; si esa red no tiene ninguna, la más usada del router.
 */
export function ipLocalDeLaRed(
  secrets: Record<string, string>[],
  ipRemota: string | null,
): string | null {
  const red = (ip: string) => ip.trim().split('.').slice(0, 3).join('.');
  const masUsada = (filas: Record<string, string>[]) => {
    const veces = new Map<string, number>();
    for (const f of filas) {
      const l = (f['local-address'] ?? '').trim();
      if (esIpValida(l)) veces.set(l, (veces.get(l) ?? 0) + 1);
    }
    return [...veces].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const suRed = esIpValida(ipRemota)
    ? masUsada(secrets.filter((s) => esIpValida(s['remote-address']) && red(s['remote-address']) === red(ipRemota!)))
    : null;
  return suRed ?? masUsada(secrets);
}

/**
 * ¿Estos dos secrets son la MISMA persona escrita de dos maneras?
 *
 * Los nombres PPPoE son el nombre completo pegado, tecleado a mano a lo largo de
 * los años, así que el mismo abonado aparece como MIRAMCUBIDESCUESTA y
 * MIRIAMCUBIDESCUESTA, o EPIMENIAVEGABUITRAGO2 y EPIMENIAVEGADEBUITRAGO2. Hace
 * falta distinguirlo de dos abonados distintos que comparten una IP mal apuntada
 * en la ficha: al primero NO se le crea un segundo secret (quedarían dos
 * peleándose la dirección), al segundo sí, con una IP libre.
 *
 * Distancia de edición sobre la longitud del más largo. El umbral de 0,85 separa
 * de sobra los casos reales: las erratas observadas quedan en 0,95 y dos nombres
 * distintos no pasan de 0,5.
 */
export function esElMismoNombre(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, '').toUpperCase();
  const y = b.replace(/\s+/g, '').toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const largo = Math.max(x.length, y.length);
  // Nombres muy cortos: una sola letra de diferencia ya puede ser otra persona.
  if (largo < 8) return false;
  return 1 - distanciaDeEdicion(x, y) / largo >= 0.85;
}

/** Levenshtein clásico, con una sola fila viva (los nombres no pasan de 40 letras). */
function distanciaDeEdicion(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const anterior = fila[j];
      fila[j] = Math.min(
        fila[j] + 1,                                   // borrar
        fila[j - 1] + 1,                               // insertar
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),    // sustituir
      );
      diagonal = anterior;
    }
  }
  return fila[b.length];
}

export type MikrotikAction =
  | 'CUT' | 'RECONNECT' | 'STATUS' | 'TEST' | 'PROVISION' | 'PROFILE' | 'EDIT'
  /** Interruptor manual del legacy: sólo la address-list MOROSOS (ver `toggleMoroso`). */
  | 'MOROSO_ON' | 'MOROSO_OFF'
  /** Alta de interfaz VLAN + servidor PPPoE (`configurarVlanEnRouter`). */
  | 'VLAN';

/**
 * Datos de conexión del abonado ANTES de guardar la ficha. Es lo que permite
 * saber QUÉ cambió (y, si cambió el usuario PPP, con qué nombre hay que buscar
 * el secret en el router, que todavía se llama como se llamaba).
 *
 * Las MAC (`macEquipo`, `macOnt`) no están aquí a propósito: son datos de
 * inventario del equipo del cliente, no parte del `/ppp/secret`, y el router no
 * tiene dónde recibirlas.
 */
/**
 * Estados en los que el abonado TIENE servicio montado (o está a punto), o sea
 * aquellos cuyo secret debe existir y estar al día. Los retirados y depurados se
 * quedan fuera: su secret ya no representa a nadie.
 */
const ESTADOS_CON_SERVICIO = [
  'ACTIVO', 'CORTADO', 'COMPROMISO', 'INSTALAR', 'SUSPENDIDO', 'CARTERA',
  'EXONERADO', 'EVENTO', 'REPORTADO',
] as const;

/**
 * De los anteriores, aquellos en los que el abonado DEBE estar navegando ahora.
 *
 * Sirve para decidir cómo NACE un secret que se crea de cero: el de quien tiene
 * el servicio al día nace limpio, y el de un deudor nace con su IP en MOROSOS.
 * Crear el secret de un cortado sin marcarlo es devolverle el internet gratis
 * —el corte de esta casa no deshabilita el secret, mete la IP en esa lista—.
 */
const ESTADOS_QUE_DEBEN_NAVEGAR = ['ACTIVO', 'COMPROMISO', 'INSTALAR', 'EXONERADO', 'EVENTO'] as const;

/** Parte del barrido `conciliarSecretsEnLote`. */
export interface ResumenConciliacion {
  /** true si no se escribió en ningún router (simulación o informe). */
  dryRun: boolean;
  total: number;
  /** Ya coincidían con la ficha. */
  alDia: number;
  /** Secrets puestos al día (o que lo estarían, en modo informe). */
  corregidos: number;
  /** Abonados cuyo secret NO existe en el router. Se reparten entre los seis de abajo. */
  sinSecret: number;
  /** Dados de alta en esta corrida. */
  creados: number;
  /** Se podían crear pero se corría en modo informe. */
  porCrear: number;
  /**
   * Sin secret pero SIN internet: el `name_s` es relleno del legacy ('0', '-').
   * Son clientes de TV, no abonados sin servicio, y llegaron a ser 1.009 de los
   * 1.682 "sin secret" que contaba el barrido: no hay nada que darles de alta.
   */
  sinUsuarioReal: number;
  /** El perfil de la ficha no identifica uno solo del router (ambiguo o inexistente). */
  perfilSinResolver: number;
  /** Su IP ya la tiene otro secret: probablemente él mismo con el nombre mal escrito. */
  posibleDuplicado: number;
  /** La IP de la ficha la tenía OTRO abonado: se creó con una libre. */
  ipDeFichaOcupada: number;
  /** Ya existe en otro equipo de la sede: la `installTech` de la ficha está mal. */
  enOtroEquipoDeLaSede: number;
  /** Se intentó y el router lo rechazó. */
  noSePudoCrear: number;
  /** Quién falta y por qué, para poder arreglar las fichas (tope 300). */
  faltantes: { abonado: number | null; usuario: string; router: string; motivo: string }[];
  /** Abonados sin Mikrotik resoluble (sin sede o sede sin router). */
  sinRouter: number;
  /** Comentarios puestos al día / fichas sin comentario que NO se copiaron (no se vacía el del router). */
  comentario: number;
  comentarioVacio: number;
  /** Direcciones RELLENADAS (el secret no tenía ninguna). */
  ipLocal: number;
  ipRemota: number;
  /** Direcciones de la ficha que el barrido NO escribió (el secret ya tenía una, o estaba repetida). */
  ipOmitida: number;
  ipLocalOmitida: number;
  /** Diferencias que el barrido deja como están, sólo para saber que existen. */
  perfilDistinto: number;
  claveDistinta: number;
  routers: { name: string; total: number; alDia: number; corregidos: number; sinSecret: number; creados: number; error?: string }[];
  muestra: { abonado: number | null; usuario: string; router: string; cambios: string }[];
  message: string;
}

/** Campos de conexión de la ficha que pueden acabar en el `/ppp/secret`. */
export const CAMPOS_DE_CONEXION = [
  'pppUsername', 'pppPassword', 'pppProfile', 'ipRemote', 'ipLocal', 'netComment',
] as const;

/**
 * Qué hay que escribirle al secret para que el router diga lo mismo que la ficha.
 *
 * Función pura (entra lo que tiene el router y lo que dice la ficha, sale el `/set`)
 * y con dos reglas distintas a propósito:
 *
 *  - `comment`, `remote-address` y `local-address` se RECONCILIAN siempre: la ficha
 *    manda. Son los datos que se corrigen desde la ventanilla y los que el corte
 *    necesita bien puestos, y muchos se arreglaron aquí antes de que nada viajara al
 *    router, así que "no cambió en este guardado" no significa "ya está allá".
 *  - `name`, `password` y `profile` sólo se tocan si se acaban de EDITAR. Pisarlos
 *    desde una ficha vieja deja al abonado sin autenticar o con otra velocidad; si
 *    difieren y nadie los tocó, se avisa y se dejan como están.
 */
export function conciliarSecret(
  ficha: SnapshotConexion,
  enElRouter: Record<string, string>,
  editados: readonly string[],
): { set: Record<string, string>; unset: string[]; avisos: string[] } {
  const norm = (v?: string | null) => (v ?? '').trim();
  const set: Record<string, string> = {};
  /** RouterOS no acepta cadena vacía en las direcciones: borrar es `unset`. */
  const unset: string[] = [];
  const avisos: string[] = [];

  // --- Lo que manda la ficha ---
  const comentario = norm(ficha.netComment);
  if (comentario !== norm(enElRouter.comment)) set.comment = comentario;

  const direcciones = [
    { campo: 'ipRemote', prop: 'remote-address', etiqueta: 'IP remota' },
    { campo: 'ipLocal', prop: 'local-address', etiqueta: 'IP local' },
  ] as const;
  for (const { campo, prop, etiqueta } of direcciones) {
    const valor = norm(ficha[campo]);
    const enRouter = norm(enElRouter[prop]);
    const buena = /^\d{1,3}(\.\d{1,3}){3}$/.test(valor) ? valor : '';
    if (buena) {
      if (buena !== enRouter) set[prop] = buena;
    } else if (enRouter) {
      // Vaciarla en la ficha es una orden; que llegue vacía de siempre, no.
      if (editados.includes(campo)) unset.push(prop);
      else avisos.push(`la ficha no trae ${etiqueta} y el router tiene ${enRouter}: se deja como está`);
    }
  }

  // --- Lo que sólo viaja si se acaba de editar ---
  const usuario = norm(ficha.pppUsername).replace(/\s+/g, '');
  if (editados.includes('pppUsername')) {
    if (!usuario) avisos.push('el usuario PPP quedó vacío: el secret conserva el nombre que tenía');
    else if (usuario !== norm(enElRouter.name)) set.name = usuario;
  }

  const clave = norm(ficha.pppPassword);
  if (editados.includes('pppPassword')) {
    // Una clave vacía en el secret deja al cliente sin poder autenticarse.
    if (!clave) avisos.push('la clave PPP quedó vacía: NO se borra en el router (dejaría al abonado sin autenticar)');
    else if (clave !== norm(enElRouter.password)) set.password = clave;
  } else if (clave && norm(enElRouter.password) && clave !== norm(enElRouter.password)) {
    avisos.push('la clave PPP de la ficha no es la del router: no se pisa sin que alguien la edite');
  }

  const perfil = norm(ficha.pppProfile);
  if (editados.includes('pppProfile')) {
    if (!perfil) avisos.push('el perfil quedó vacío: no se toca el del router');
    else if (perfil !== norm(enElRouter.profile)) set.profile = perfil;
  } else if (perfil && norm(enElRouter.profile) && perfil !== norm(enElRouter.profile)) {
    avisos.push(`el perfil de la ficha (${perfil}) no es el del router (${norm(enElRouter.profile)}): se cambia desde el plan`);
  }

  return { set, unset, avisos };
}

export type SnapshotConexion = {
  pppUsername?: string | null;
  pppPassword?: string | null;
  pppProfile?: string | null;
  ipRemote?: string | null;
  ipLocal?: string | null;
  netComment?: string | null;
};

export interface MikrotikActionResult {
  ok: boolean;
  dryRun: boolean;
  action: MikrotikAction;
  subscriberId?: string;
  mikrotik?: { id: string; name: string; host: string; tech: string };
  /** Comandos que se enviaron (o que se enviarían en dry-run). */
  steps: string[];
  /** Estado en vivo leído del router (sólo en STATUS/TEST cuando aplica). */
  live?: {
    secretExists?: boolean;
    secretDisabled?: boolean;
    sessionActive?: boolean;
    ip?: string;
    inActivos?: boolean;
    inMorosos?: boolean;
  };
  message: string;
  error?: string;
  /**
   * Sólo en RECONNECT real: ¿el router lo tenía cortado de verdad? true = hubo que
   * sacarlo de MOROSOS (en cualquier router de la sede), habilitarle o crearle el
   * secret. false = ya estaba al aire y la "reconexión" no cambió nada. undefined =
   * no se sabe (dry-run o fallo antes de mirar).
   */
  wasCut?: boolean;
}

type SubForNet = {
  id: string;
  legacyId: number | null;
  pppUsername: string | null;
  ipRemote: string | null;
  installTech: string | null;
  status: string | null;
  branch: { legacyId: number } | null;
  /**
   * El resto de la conexión. Sólo hace falta para CREAR el secret que no existe,
   * así que es opcional: las consultas que únicamente cortan o reconectan no
   * tienen por qué arrastrarlo.
   */
  pppPassword?: string | null;
  pppProfile?: string | null;
  pppService?: string | null;
  ipLocal?: string | null;
  netComment?: string | null;
  /**
   * Perfil PPP del PLAN de internet contratado, que es de dónde sale el perfil
   * cuando el de la ficha no sirve (ver `buscarPerfilDe`).
   */
  planPppProfile?: string | null;
};

/**
 * El plan de internet contratado, para leer su `pppProfile`. `take: 1` porque un
 * abonado tiene un solo internet activo; si tuviera dos, cualquiera de los dos da
 * la misma velocidad que se le está facturando.
 */
const SELECT_PLAN_PPP = {
  where: { kind: 'INTERNET', status: 'ACTIVO' },
  select: { plan: { select: { pppProfile: true } } },
  take: 1,
} as const;

/**
 * De dónde salió el perfil, para que la constancia del alta no mienta: si la ficha
 * dice "-" y el secret nació con el perfil del plan, hay que poder verlo.
 */
const origenDelPerfil = (origen?: 'ficha' | 'plan' | 'default'): string =>
  origen === 'plan' ? ' (del plan contratado; la ficha no lo resuelve)'
    : origen === 'default' ? ' (¡default! ni la ficha ni el plan resuelven)'
      : '';

/** Aplana `services[0].plan.pppProfile` al campo plano que usa el resto del servicio. */
function conPerfilDelPlan<T extends { services?: { plan: { pppProfile: string | null } | null }[] }>(
  s: T,
): Omit<T, 'services'> & { planPppProfile: string | null } {
  const { services, ...resto } = s;
  return { ...resto, planPppProfile: services?.[0]?.plan?.pppProfile ?? null };
}

export class MikrotikService {
  private readonly logger = new Logger('MikrotikService');
  /** true ⇒ ejecuta de verdad contra los routers. false ⇒ dry-run (simulación segura). */
  private live = process.env.MIKROTIK_LIVE === 'true';
  private liveCheckedAt = 0;

  /**
   * Caché corta del estado en vivo por abonado. La ficha del cliente lo pide sola
   * al abrirse, así que un router podría recibir una consulta por cada pestaña que
   * alguien abre; con 10 s de gracia la misma ficha reabierta no vuelve a marcar.
   * Cualquier acción sobre el abonado (corte, reconexión, alta…) la invalida en
   * `audit()`, para que el semáforo no enseñe el estado de antes del clic.
   */
  private statusCache = new Map<string, { at: number; res: MikrotikActionResult }>();
  private static readonly STATUS_TTL_MS = 10_000;

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsappService,
    private ips: IpAllocatorService,
    /**
     * Opcionales a propósito (mismo criterio que en `SubscribersService`): sin ellos el
     * corte contra el router sigue funcionando igual, sólo que no deja constancia. Que
     * la constancia falte nunca puede impedir cortar.
     */
    private readonly ordenes?: OrdenesAutomaticasService,
    private readonly events?: EmisorDeEventos,
  ) {}

  get isLive(): boolean {
    return this.live;
  }

  /**
   * Sincroniza el modo real desde el ajuste `network.mikrotikLive` (interruptor en
   * Configuración), con cache de 15s. La variable de entorno MIKROTIK_LIVE=true lo
   * fuerza a vivo (compatibilidad). Se llama al inicio de cada operación de red.
   */
  /**
   * ACTIVOS y MOROSOS de cada router, por `comment`. SOLO LECTURA: es lo que mira la
   * revisión diaria de cortes deshechos. Un router que no contesta se anota y se
   * sigue con el resto; routers con la misma IP:puerto (EPON/EOC de Villanueva) se
   * leen una vez.
   */
  async listasDeCorte(): Promise<{ listas: { router: string; sede: number | null; activos: Map<string, string>; morosos: Set<string> }[]; errores: string[] }> {
    await this.syncLive();
    if (!this.live) return { listas: [], errores: ['Mikrotik en dry-run: no se leyó ningún router.'] };
    const routers = await this.prisma.mikrotik.findMany();
    const vistos = new Set<string>();
    const listas: { router: string; sede: number | null; activos: Map<string, string>; morosos: Set<string> }[] = [];
    const errores: string[] = [];
    for (const r of routers) {
      const clave = `${r.ip}:${r.port}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const api = new RouterosClient();
      try {
        await api.connect(r.ip, Number(r.port), r.username, decryptSecret(r.password), { timeoutMs: 10000 });
        const activos = new Map<string, string>();
        for (const e of await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE }, 30000)) {
          if (e.comment) activos.set(e.comment, e['creation-time'] ?? '');
        }
        const morosos = new Set<string>();
        for (const e of await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR }, 30000)) {
          if (e.comment) morosos.add(e.comment);
        }
        listas.push({ router: r.name, sede: r.sedeLegacy ?? null, activos, morosos });
      } catch (e) {
        errores.push(`${r.name}: ${(e as Error).message}`);
      } finally {
        api.close();
      }
    }
    return { listas, errores };
  }

  /**
   * Interfaces VLAN y servidores PPPoE de los Mikrotik de una sede, para la salud
   * de VLANs (`vlan-salud.ts`). SOLO LECTURA (`/print`). Routers con la misma
   * IP:puerto (EPON/EOC de Villanueva) se leen una vez. En dry-run no se lee
   * nada, como `listasDeCorte`: el que pregunta ve el porqué en `errores`.
   */
  async vlansDeRoutersDeSede(branchId: string): Promise<{ routers: LecturaMikrotikVlans[]; errores: string[] }> {
    await this.syncLive();
    if (!this.live) return { routers: [], errores: ['Mikrotik en dry-run: no se leyó ningún router.'] };
    const filas = await this.prisma.mikrotik.findMany({ where: { branchId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    const vistos = new Set<string>();
    const routers: LecturaMikrotikVlans[] = [];
    const errores: string[] = [];
    for (const r of filas) {
      const clave = `${r.ip}:${r.port}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const api = new RouterosClient();
      try {
        await api.connect(r.ip, Number(r.port), r.username, decryptSecret(r.password), { timeoutMs: 10000 });
        const vlans = await api.comm('/interface/vlan/print', {}, 20000);
        const pppoe = await api.comm('/interface/pppoe-server/server/print', {}, 20000);
        routers.push(lecturaMikrotikDeFilas(r.id, r.name, vlans, pppoe));
      } catch (e) {
        errores.push(`${r.name}: ${(e as Error).message}`);
      } finally {
        api.close();
      }
    }
    return { routers, errores };
  }

  /**
   * Agrega en UN router la interfaz VLAN y/o el servidor PPPoE que calculó
   * `planMikrotikParaVlan`. Solo `add` de esos dos menús: cualquier otro paso se
   * rechaza aquí mismo. Dry-run salvo MIKROTIK_LIVE / interruptor de
   * Configuración; auditado en `MikrotikActionLog` con el usuario. Corta en el
   * primer error (si la interfaz no se creó, el PPPoE no tiene dónde ir).
   */
  async configurarVlanEnRouter(
    mikrotikId: string, vlan: number, pasos: PasoRouterOs[], user?: AuthUser, forzarDryRun = false,
  ): Promise<{ ok: boolean; dryRun: boolean; steps: string[]; error?: string }> {
    await this.syncLive();
    const router = await this.prisma.mikrotik.findUnique({ where: { id: mikrotikId } });
    if (!router) throw new NotFoundException('Mikrotik no encontrado');
    for (const p of pasos) {
      if (p.cmd !== '/interface/vlan/add' && p.cmd !== '/interface/pppoe-server/server/add') {
        throw new BadRequestException(`Paso no permitido en el router: ${p.cmd}`);
      }
    }
    const res: MikrotikActionResult = {
      ok: true, dryRun: forzarDryRun || !this.live, action: 'VLAN',
      mikrotik: { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech },
      steps: pasos.map(pasoRouterOsComoTexto), message: '',
    };
    if (!pasos.length) return { ok: true, dryRun: res.dryRun, steps: [] };
    if (res.dryRun) {
      if (!forzarDryRun) {
        res.steps = res.steps.map((x) => `DRY-RUN ${x}`);
        await this.audit('VLAN', null, router, res, user);
      }
      return { ok: true, dryRun: true, steps: res.steps };
    }
    const api = new RouterosClient();
    let hechos = 0;
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      for (const p of pasos) {
        await api.comm(p.cmd, p.params);
        hechos++;
      }
    } catch (e) {
      res.ok = false;
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
    } finally {
      api.close();
    }
    // Qué entró y qué no, paso a paso: un alta a medias tiene que verse tal cual.
    res.steps = res.steps.map((x, i) => (i < hechos ? x : `NO APLICADO ${x}`));
    await this.audit('VLAN', null, router, res, user);
    return { ok: res.ok, dryRun: false, steps: res.steps, error: res.error };
  }

  private async syncLive(): Promise<void> {
    const now = Date.now();
    if (now - this.liveCheckedAt < 15000) return;
    this.liveCheckedAt = now;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'network.mikrotikLive' } });
    // El interruptor de Configuración MANDA si está definido (true/false). Si no
    // existe, se usa la variable de entorno MIKROTIK_LIVE como valor por defecto.
    this.live = row?.value === 'true' || row?.value === 'false'
      ? row.value === 'true'
      : process.env.MIKROTIK_LIVE === 'true';
  }

  // ------------------------------------------------------------------
  // Mensajería masiva (WhatsApp) — cobro a morosos estilo Clientgroup
  // ------------------------------------------------------------------
  /** Normaliza a E.164 Colombia: 10 dígitos ⇒ prefija 57. */
  private toE164(phone?: string | null): string | null {
    if (!phone) return null;
    const d = phone.replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10) return `57${d}`;
    if (d.startsWith('57')) return d;
    return d;
  }

  async messageBatch(ids: string[], message: string, user?: AuthUser) {
    const subs = await this.prisma.subscriber.findMany({
      where: { id: { in: ids } },
      select: { id: true, abonado: true, firstName: true, lastName1: true, fullName: true, phone1: true, phone2: true },
    });
    // Abonado y nombre viajan en cada fila: el parte que ve quien mandó el envío
    // tiene que decir a QUIÉN se le mandó y quién se quedó sin mensaje.
    const results: { subscriberId: string; abonado: number | null; name: string | null; ok: boolean; phone?: string; error?: string }[] = [];
    for (const s of subs) {
      const name = (s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ')).trim();
      const quien = { subscriberId: s.id, abonado: s.abonado ?? null, name: name || null };
      const phone = this.toE164(s.phone1) ?? this.toE164(s.phone2);
      if (!phone) { results.push({ ...quien, ok: false, error: 'sin teléfono' }); continue; }
      const text = message
        .replace(/\{nombre\}/gi, name || 'estimado cliente')
        .replace(/\{abonado\}/gi, String(s.abonado ?? ''));
      try {
        const ok = await this.whatsapp.sendText(phone, text);
        results.push({ ...quien, ok, phone });
      } catch (e) {
        results.push({ ...quien, ok: false, phone, error: (e as Error).message });
      }
    }
    return { total: ids.length, sent: results.filter((r) => r.ok).length, results };
  }

  // ------------------------------------------------------------------
  // Resolución de router
  // ------------------------------------------------------------------
  private async loadSubscriber(id: string): Promise<SubForNet> {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true,
        legacyId: true,
        pppUsername: true,
        ipRemote: true,
        installTech: true,
        status: true,
        branch: { select: { legacyId: true } },
        // Lo que hace falta para crear el secret si resulta que no existe: la
        // reconexión de quien paga ya no puede quedarse a medias por no traerlo.
        pppPassword: true,
        pppProfile: true,
        pppService: true,
        ipLocal: true,
        netComment: true,
        // El perfil de respaldo cuando el de la ficha no resuelve (ver `buscarPerfilDe`).
        services: SELECT_PLAN_PPP,
      },
    });
    if (!s) throw new NotFoundException('Cliente no encontrado');
    return conPerfilDelPlan(s) as SubForNet;
  }

  /**
   * De los routers de UNA sede, el que le toca a este abonado: el de su tecnología
   * y, si no hay, el marcado por defecto. Aparte de `resolveRouter` porque el
   * barrido masivo agrupa miles de abonados y no puede consultar la tabla por cada
   * uno: carga los Mikrotik una vez y reparte con esto.
   */
  elegirRouter(installTech: string | null, deLaSede: Mikrotik[]): Mikrotik | undefined {
    const porTech = installTech
      ? deLaSede.find((r) => r.tech?.toUpperCase() === String(installTech).toUpperCase())
      : undefined;
    return porTech ?? deLaSede.find((r) => r.isDefault) ?? deLaSede[0];
  }

  /** Elige el Mikrotik para una sede+tecnología (fallback: isDefault de la sede). */
  async resolveRouter(sub: SubForNet) {
    if (!sub.branch) {
      throw new BadRequestException('El cliente no tiene sede asignada; no se puede resolver el Mikrotik.');
    }
    const routers = await this.prisma.mikrotik.findMany({
      where: { sedeLegacy: sub.branch.legacyId },
    });
    if (routers.length === 0) {
      throw new BadRequestException(`No hay Mikrotik configurado para la sede (gid ${sub.branch.legacyId}).`);
    }
    const chosen = this.elegirRouter(sub.installTech, routers);
    if (!chosen) {
      throw new BadRequestException(`No hay Mikrotik configurado para la sede (gid ${sub.branch.legacyId}).`);
    }
    return chosen;
  }

  /** Comentario usado en address-list, igual que el legacy: `activo_<idLegacy>`. */
  private comment(sub: SubForNet): string {
    return `activo_${sub.legacyId ?? sub.id}`;
  }

  /**
   * Resuelve el nombre de un perfil PPP contra los que EXISTEN en el router.
   *
   * RouterOS no compara el valor de `profile=` literalmente: lo resuelve por
   * PREFIJO. Un plan guardado como "100" hace match con `100Megas`,
   * `100MegasD` y `100MegasSt` a la vez y el router responde
   * `ambiguous value of profile, more than one possible value matches input`,
   * que tumba el /ppp/secret/add ENTERO: el abonado queda ACTIVO en el sistema
   * y sin secret en el router, o sea sin navegar y sin que nadie se entere.
   *
   * Aquí se manda siempre el `.id` del perfil (`*24`), que no admite
   * interpretación. Y si el nombre no identifica uno solo, el error dice qué
   * perfil se pidió, cuáles hay y en qué router, en vez del mensaje críptico.
   */
  private async resolveProfileId(
    api: RouterosClient,
    profileRaw: string,
    routerName: string,
  ): Promise<{ id: string; name: string }> {
    return this.elegirPerfil(await this.perfilesDe(api), profileRaw, routerName);
  }

  /** `resolveProfileId` para un abonado: ficha → plan contratado → default. */
  private async resolveProfileDe(
    api: RouterosClient,
    sub: SubForNet,
    routerName: string,
  ): Promise<{ id: string; name: string; origen?: 'ficha' | 'plan' | 'default' }> {
    return this.elegirPerfilDe(await this.perfilesDe(api), sub, routerName);
  }

  /** Los perfiles PPP del router. Se lee aparte para poder cachearlo por router. */
  private async perfilesDe(api: RouterosClient): Promise<{ id: string; name: string }[]> {
    const rows = await api.comm('/ppp/profile/getall', { '.proplist': '.id,name' });
    return rows.filter((r) => r['.id'] && r.name != null).map((r) => ({ id: r['.id'], name: r.name.trim() }));
  }

  /**
   * La búsqueda en sí, sobre una lista ya leída y SIN excepciones: el barrido
   * recorre miles de abonados contra el mismo router (no puede releer los
   * perfiles por cada uno) y necesita el motivo en una línea para el informe,
   * no el mensaje largo con los 60 perfiles del router repetido 600 veces.
   */
  private buscarPerfil(
    perfiles: { id: string; name: string }[],
    profileRaw: string,
  ):
    | { perfil: { id: string; name: string } }
    | { perfil?: undefined; pedido: string; clase: 'ambiguo' | 'inexistente'; candidatos: string[] } {
    const pedido = (profileRaw || 'default').trim();

    // 1) nombre exacto  2) exacto ignorando mayúsculas  3) prefijo único
    const norm = (s: string) => s.toLowerCase();
    const exacto = perfiles.find((p) => p.name === pedido)
      ?? perfiles.find((p) => norm(p.name) === norm(pedido));
    if (exacto) return { perfil: exacto };

    const porPrefijo = perfiles.filter((p) => norm(p.name).startsWith(norm(pedido)));
    if (porPrefijo.length === 1) return { perfil: porPrefijo[0] };

    return porPrefijo.length
      ? { pedido, clase: 'ambiguo', candidatos: porPrefijo.map((p) => p.name) }
      : { pedido, clase: 'inexistente', candidatos: perfiles.map((p) => p.name) };
  }

  /** El motivo en una línea, para el informe del barrido. */
  private motivoDelPerfil(fallo: { pedido: string; clase: 'ambiguo' | 'inexistente'; candidatos: string[] }): string {
    return fallo.clase === 'ambiguo'
      ? `el perfil "${fallo.pedido}" es ambiguo: coincide con ${fallo.candidatos.join(', ')}`
      : `el perfil "${fallo.pedido}" no existe en el router`;
  }

  /**
   * El perfil del router para ESTE abonado: primero el que dice su ficha y, si no
   * identifica uno solo, el del plan de internet que tiene contratado.
   *
   * El respaldo no es un adorno. 2.955 fichas ACTIVAS traen `"-"` en `pppProfile`
   * y otras un número suelto (`"100"`, que hace match con 100Megas, 100MegasD,
   * 100MegasSt, 100Megas26D y 1000Megas26D a la vez): heredado del legacy, que no
   * guardaba ahí el nombre del perfil. Mirando sólo la ficha, esos abonados **no
   * se pueden dar de alta nunca** —el barrido contaba 620 así y seguía de largo, y
   * el alta de un cliente nuevo se caía con `ambiguous value of profile`—. El plan
   * sí guarda el nombre exacto del router en `Plan.pppProfile`.
   *
   * La ficha manda mientras sirva: si resuelve, el plan ni se mira, aunque digan
   * cosas distintas. Cambiarle la velocidad a quien ya navega es trabajo de
   * `applyProfile` (cambio de plan), no de un alta ni de un barrido de madrugada.
   *
   * `default` NO es un respaldo del perfil roto: existe en los ocho routers, así
   * que resolvería siempre y taparía el problema creando el secret a la velocidad
   * de ese perfil en vez de a la que el cliente compró. Un perfil que la ficha
   * pide y no resuelve se queda sin crear y se apunta para arreglarlo a mano. Sólo
   * se cae a `default` cuando la ficha viene VACÍA y tampoco hay plan, que es lo
   * que ya hacía el `sub.pppProfile || 'default'` de antes.
   *
   * El fallo que se devuelve es el de la ficha (el primero), que es el dato que
   * hay que corregir a mano y el que sale en el informe.
   */
  private buscarPerfilDe(
    perfiles: { id: string; name: string }[],
    sub: SubForNet,
  ): ReturnType<MikrotikService['buscarPerfil']> & { origen?: 'ficha' | 'plan' | 'default' } {
    const deLaFicha = (sub.pppProfile ?? '').trim();
    const candidatos = [
      { origen: 'ficha' as const, pedido: deLaFicha },
      { origen: 'plan' as const, pedido: (sub.planPppProfile ?? '').trim() },
      // Sólo si la ficha no pide nada: ver el párrafo de arriba.
      { origen: 'default' as const, pedido: deLaFicha ? '' : 'default' },
    ].filter((c) => c.pedido);

    let primerFallo: ReturnType<MikrotikService['buscarPerfil']> | undefined;
    for (const { origen, pedido } of candidatos) {
      const r = this.buscarPerfil(perfiles, pedido);
      if (r.perfil) return { ...r, origen };
      primerFallo ??= r;
    }
    return primerFallo ?? this.buscarPerfil(perfiles, 'default');
  }

  /** Lo mismo, pero reventando y con el detalle largo: es lo que espera quien da de alta a UNO. */
  private elegirPerfil(
    perfiles: { id: string; name: string }[],
    profileRaw: string,
    routerName: string,
  ): { id: string; name: string } {
    return this.perfilOReventar(this.buscarPerfil(perfiles, profileRaw), routerName);
  }

  /** `buscarPerfilDe` (ficha → plan → default) para quien da de alta a UNO. */
  private elegirPerfilDe(
    perfiles: { id: string; name: string }[],
    sub: SubForNet,
    routerName: string,
  ): { id: string; name: string; origen?: 'ficha' | 'plan' | 'default' } {
    const r = this.buscarPerfilDe(perfiles, sub);
    return { ...this.perfilOReventar(r, routerName), origen: r.origen };
  }

  private perfilOReventar(
    r: ReturnType<MikrotikService['buscarPerfil']>,
    routerName: string,
  ): { id: string; name: string } {
    if (r.perfil) return r.perfil;
    throw new RouterosError(
      r.clase === 'ambiguo'
        ? `El perfil "${r.pedido}" es ambiguo en ${routerName}: coincide con ${r.candidatos.join(', ')}. `
          + 'Corrige el perfil del plan para que sea el nombre exacto del router.'
        : `El perfil "${r.pedido}" no existe en ${routerName}. `
          + `Perfiles disponibles: ${r.candidatos.slice(0, 25).join(', ')}${r.candidatos.length > 25 ? '…' : ''}.`,
    );
  }

  // ------------------------------------------------------------------
  // Auditoría
  // ------------------------------------------------------------------
  private async audit(
    action: MikrotikAction,
    sub: SubForNet | null,
    router: { id: string; name: string } | null,
    res: MikrotikActionResult,
    user?: AuthUser,
  ) {
    // La foto guardada ya no vale: acabamos de tocar al abonado en el router.
    if (sub?.id) this.statusCache.delete(sub.id);
    try {
      await this.prisma.mikrotikActionLog.create({
        data: {
          subscriberId: sub?.id ?? null,
          mikrotikId: router?.id ?? null,
          mikrotikName: router?.name ?? null,
          action,
          ok: res.ok,
          dryRun: res.dryRun,
          detail: (res.error ? `ERROR: ${res.error} | ` : '') + res.steps.join(' · ').slice(0, 1900),
          pppUsername: sub?.pppUsername ?? null,
          userId: user?.id ?? null,
          userName: user?.name ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`No se pudo auditar acción Mikrotik: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // Primitivas de corte/reconexión sobre una conexión YA abierta.
  // Se reutilizan tanto en la acción individual como en el lote (una sola
  // conexión por router → cientos de clientes sin reconectar cada vez).
  // No abren/cierran socket, no auditan, no tocan el estado en BD.
  // ------------------------------------------------------------------
  /**
   * Deja la IP en `list` con el comment del abonado, sin chocar con el router.
   *
   * RouterOS no admite dos entradas con la MISMA dirección en la misma lista
   * ("failure: already have such entry"), y aquí se buscaba sólo por comment. Una
   * IP que antes fue de otro abonado (p. ej. la 80.0.4.59: `activo_9162`, retirado,
   * seguía en ACTIVOS de Villanueva EPON) tumbaba la reconexión de su dueño actual
   * DESPUÉS de sacarlo de MOROSOS: el router quedaba bien y nexus lo daba por fallido,
   * no marcaba la ficha y abría una orden de reconexión que nadie necesitaba
   * (abonado 510, 21-09-2026). La entrada ajena se ADOPTA: la IP es de quien tiene
   * hoy el secret, y la pertenencia a la lista es por dirección, no por comment.
   */
  private async ponerEnLista(api: RouterosClient, list: string, ip: string, comment: string) {
    const propias = await api.comm('/ip/firewall/address-list/print', { '?list': list, '?comment': comment });
    const ajenas = (await api.comm('/ip/firewall/address-list/print', { '?list': list, '?address': ip }))
      .filter((e) => e['.id'] && e['comment'] !== comment && e['dynamic'] !== 'true');
    if (propias.length === 0 && ajenas.length) {
      const [adoptada, ...resto] = ajenas;
      await api.comm('/ip/firewall/address-list/set', { '.id': adoptada['.id'], comment });
      for (const e of resto) await api.comm('/ip/firewall/address-list/remove', { '.id': e['.id'] });
      return;
    }
    // Si ya tiene la suya, la ajena con la misma IP sobra (y haría chocar el `set`).
    for (const e of ajenas) await api.comm('/ip/firewall/address-list/remove', { '.id': e['.id'] });
    if (propias.length === 0) {
      await api.comm('/ip/firewall/address-list/add', { address: ip, list, comment });
    } else {
      for (const e of propias) if (e['.id']) await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ip });
    }
  }

  /**
   * Saca al abonado de `list`: su entrada por comment y, si se conoce la IP, cualquier
   * otra con esa misma dirección —la de un dueño anterior de la IP lo dejaría dentro
   * de la lista aunque "su" entrada ya no esté—.
   */
  private async sacarDeLista(api: RouterosClient, list: string, comment: string, ip?: string) {
    const entradas = [
      ...(await api.comm('/ip/firewall/address-list/print', { '?list': list, '?comment': comment })),
      ...(ip ? await api.comm('/ip/firewall/address-list/print', { '?list': list, '?address': ip }) : []),
    ];
    const ids = new Set(entradas.filter((e) => e['dynamic'] !== 'true').map((e) => e['.id']).filter(Boolean));
    for (const id of ids) await api.comm('/ip/firewall/address-list/remove', { '.id': id });
    return ids.size;
  }

  private async cutOnApi(api: RouterosClient, sub: SubForNet): Promise<{ ok: boolean; steps: string[]; error?: string }> {
    const name = sub.pppUsername!.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      if (secrets.length === 0) {
        steps.push(`secret '${name}' no existe en el router`);
      } else {
        const secret = secrets[0];
        const active = await api.comm('/ppp/active/getall', { '.proplist': '.id,address', '?name': name });
        if (active.length && active[0]['.id']) {
          await api.comm('/ppp/active/remove', { '.id': active[0]['.id'] });
          steps.push('sesión PPP activa cerrada');
        }

        // El secret NO se deshabilita: el corte lo hace la regla de firewall
        // `drop src/dst-address-list=MOROSOS`, presente en los 8 routers.
        // El cliente reconecta y recibe la misma IP (remote-address es fijo en
        // el secret, verificado: ~8.480 de 8.505), así que la entrada en MOROSOS
        // sigue siendo válida y queda bloqueado.
        const ip = secret['remote-address'] || active[0]?.['address'] || sub.ipRemote || '';
        if (ip) {
          await this.sacarDeLista(api, ADDRESS_LIST_ACTIVE, comment, ip);
          await this.ponerEnLista(api, ADDRESS_LIST_DEBTOR, ip, comment);
          steps.push(`IP ${ip}: ${ADDRESS_LIST_ACTIVE} → ${ADDRESS_LIST_DEBTOR}`);
        } else {
          steps.push('sin IP conocida: no se tocaron address-list');
        }
      }
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /**
   * `router` hace falta para poder DAR DE ALTA al que no está: reconectar a
   * quien no tiene secret no es reconectar nada. Ver el bloque de abajo.
   */
  private async reconnectOnApi(api: RouterosClient, sub: SubForNet, router: Mikrotik): Promise<{ ok: boolean; steps: string[]; error?: string; wasCut?: boolean }> {
    const name = sub.pppUsername!.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const steps: string[] = [];
    let wasCut = false;
    try {
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      let ip = secrets[0]?.['remote-address'] || '';
      if (!ip) {
        const active = await api.comm('/ppp/active/getall', { '?name': name });
        ip = active[0]?.['address'] || '';
      }
      if (!ip) ip = sub.ipRemote || '';

      if (!secrets[0]?.['.id']) {
        /**
         * Sin secret no hay nada que reactivar, y hasta aquí eso se despachaba
         * con una línea en el detalle y un `ok: true`: el abonado pagaba, la
         * cajera veía "reconexión aplicada" y el cliente seguía sin internet.
         * Se le da de alta con lo que dice su ficha, que es lo que alguien
         * tendría que haber hecho a mano; si la ficha no da (perfil ambiguo,
         * usuario de relleno), se dice POR QUÉ y la reconexión falla de verdad.
         */
        const alta = await this.crearSecretEnApi(api, sub, router);
        steps.push(...alta.steps);
        if (!alta.creado) {
          return { ok: false, steps, error: `no existía el secret '${name}' y no se pudo crear: ${alta.motivo}` };
        }
        if (alta.ip) ip = alta.ip;
        wasCut = true;
      } else if (secrets[0]['disabled'] === 'true') {
        // Compatibilidad: cortes viejos (legacy y primeras versiones de este
        // módulo) dejaron el secret en disabled=yes. Al reconectar lo sanamos.
        await api.comm('/ppp/secret/set', { '.id': secrets[0]['.id'], disabled: 'no' });
        steps.push('secret habilitado (venía deshabilitado por un corte anterior)');
        wasCut = true;
      }

      const fueraDeMorosos = await this.sacarDeLista(api, ADDRESS_LIST_DEBTOR, comment, ip);
      if (fueraDeMorosos) { steps.push(`removido de ${ADDRESS_LIST_DEBTOR}`); wasCut = true; }

      if (ip) {
        await this.ponerEnLista(api, ADDRESS_LIST_ACTIVE, ip, comment);
        steps.push(`IP ${ip} en ${ADDRESS_LIST_ACTIVE}`);
      }
      return { ok: true, steps, wasCut };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /**
   * Solo mueve la IP a la lista MOROSOS (quita de ACTIVOS) sin tocar el secret.
   * Se usa en los OTROS Mikrotiks de la sede donde el cliente no tiene su secret,
   * para que quede en morosos "en cada mikrotik" (fiel al legacy).
   */
  private async markMorosoOnApi(api: RouterosClient, sub: SubForNet, ip: string): Promise<{ ok: boolean; steps: string[]; error?: string }> {
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      if (!ip) { steps.push('sin IP conocida: no se marcó moroso'); return { ok: true, steps }; }
      await this.sacarDeLista(api, ADDRESS_LIST_ACTIVE, comment, ip);
      await this.ponerEnLista(api, ADDRESS_LIST_DEBTOR, ip, comment);
      steps.push(`IP ${ip} → ${ADDRESS_LIST_DEBTOR}`);
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /** Quita la IP de MOROSOS (y la devuelve a ACTIVOS) sin tocar el secret — reverso de markMorosoOnApi. */
  private async unmarkMorosoOnApi(api: RouterosClient, sub: SubForNet, ip: string): Promise<{ ok: boolean; steps: string[]; error?: string; wasCut?: boolean }> {
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      const fueraDeMorosos = await this.sacarDeLista(api, ADDRESS_LIST_DEBTOR, comment, ip);
      if (fueraDeMorosos) steps.push(`removido de ${ADDRESS_LIST_DEBTOR}`);
      if (ip) {
        await this.ponerEnLista(api, ADDRESS_LIST_ACTIVE, ip, comment);
        steps.push(`IP ${ip} en ${ADDRESS_LIST_ACTIVE}`);
      }
      return { ok: true, steps, wasCut: fueraDeMorosos > 0 };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /** Otros Mikrotiks de la sede (distintos al router primario) para replicar morosos. */
  private async sedeOtherRouters(sub: SubForNet, primaryId: string): Promise<Mikrotik[]> {
    if (!sub.branch) return [];
    const routers = await this.prisma.mikrotik.findMany({ where: { sedeLegacy: sub.branch.legacyId } });
    return routers.filter((r) => r.id !== primaryId);
  }

  /**
   * Abre conexión a cada router "other" de la sede y marca/desmarca la IP en MOROSOS
   * (sin tocar el secret, que solo vive en el router primario). Best-effort: los
   * fallos por router se anotan en los steps pero no tumban la acción principal.
   */
  private async replicateMorosoOnSede(
    sub: SubForNet,
    others: Mikrotik[],
    mode: 'mark' | 'unmark',
    res: MikrotikActionResult,
    ipConocida?: string,
  ) {
    const ip = ipConocida || sub.ipRemote || '';
    for (const other of others) {
      const oapi = new RouterosClient();
      try {
        await oapi.connect(other.ip, Number(other.port), other.username, decryptSecret(other.password), { timeoutMs: 8000 });
        const mr = mode === 'mark' ? await this.markMorosoOnApi(oapi, sub, ip) : await this.unmarkMorosoOnApi(oapi, sub, ip);
        oapi.close();
        res.steps.push(`[${other.name}] ${mr.ok ? mr.steps.join(' · ') : '✗ ' + mr.error}`);
        // Estar en MOROSOS en otro router de la sede también es estar cortado.
        if (mode === 'unmark' && (mr as { wasCut?: boolean }).wasCut) res.wasCut = true;
      } catch (e) {
        oapi.close();
        res.steps.push(`[${other.name}] ✗ no conectó: ${e instanceof RouterosError ? e.message : (e as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // CORTE
  // ------------------------------------------------------------------
  async cut(subscriberId: string, user?: AuthUser): Promise<MikrotikActionResult> {
    await this.syncLive();
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s); no hay conexión que cortar.');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'CUT',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    const others = await this.sedeOtherRouters(sub, router.id);

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/active/getall ?name=${name}  → /ppp/active/remove`,
        `(el secret NO se modifica)`,
        `address-list ${ADDRESS_LIST_ACTIVE} remove (comment=${comment})`,
        `address-list ${ADDRESS_LIST_DEBTOR} add/set (comment=${comment})`,
        ...others.map((o) => `[${o.name}] address-list ${ADDRESS_LIST_DEBTOR} add (comment=${comment})`),
      ];
      res.ok = true;
      res.message = `DRY-RUN: corte simulado de ${name} en ${router.name}${others.length ? ` + morosos en ${others.length} router(es) de la sede` : ''}. Sin cambios reales.`;
      await this.audit('CUT', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);

      const r = await this.cutOnApi(api, sub);
      api.close();
      res.steps.push(...r.steps);
      if (r.ok) {
        await this.markStatus(sub, 'CORTADO');
        res.ok = true;
        res.message = `Corte aplicado a ${name} en ${router.name}.`;
      } else {
        res.error = r.error;
        res.message = `Fallo el corte: ${r.error}`;
      }
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Fallo el corte: ${res.error}`;
    }

    // Replicar MOROSOS en los demás Mikrotiks de la sede (best-effort).
    await this.replicateMorosoOnSede(sub, others, 'mark', res);

    await this.audit('CUT', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // RECONEXIÓN
  // ------------------------------------------------------------------
  async reconnect(subscriberId: string, user?: AuthUser): Promise<MikrotikActionResult> {
    await this.syncLive();
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s); no hay conexión que reactivar.');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'RECONNECT',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    const others = await this.sedeOtherRouters(sub, router.id);

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/add ?name=${name} (solo si no existe: alta con los datos de la ficha)`,
        `/ppp/secret/set ?name=${name} disabled=no (solo si venía deshabilitado)`,
        `address-list ${ADDRESS_LIST_DEBTOR} remove (comment=${comment})`,
        `address-list ${ADDRESS_LIST_ACTIVE} add/set (comment=${comment})`,
        ...others.map((o) => `[${o.name}] address-list ${ADDRESS_LIST_DEBTOR} remove (comment=${comment})`),
      ];
      res.ok = true;
      res.message = `DRY-RUN: reconexión simulada de ${name} en ${router.name}${others.length ? ` + quitar de morosos en ${others.length} router(es) de la sede` : ''}. Sin cambios reales.`;
      await this.audit('RECONNECT', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);

      const r = await this.reconnectOnApi(api, sub, router);
      api.close();
      res.steps.push(...r.steps);
      if (r.ok) {
        res.wasCut = !!r.wasCut;
        await this.markStatus(sub, 'ACTIVO');
        res.ok = true;
        res.message = `Reconexión aplicada a ${name} en ${router.name}.`;
      } else {
        res.error = r.error;
        res.message = `Fallo la reconexión: ${r.error}`;
      }
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Fallo la reconexión: ${res.error}`;
    }

    // Quitar de MOROSOS en los demás Mikrotiks de la sede (best-effort).
    await this.replicateMorosoOnSede(sub, others, 'unmark', res);

    await this.audit('RECONNECT', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // INTERRUPTOR MANUAL: sólo la address-list MOROSOS
  // ------------------------------------------------------------------
  /**
   * El botón «Activar / Desactivar» de la ficha del legacy, tal cual.
   *
   * Es el port de `Customers.php::edita_estado_usuario` →
   * `Customers_model::activar_estado_usuario` / `::editar_estado_usuario`, y lo que
   * hace es lo ÚNICO que hacían aquellas dos: mover la IP del abonado entre las
   * address-list `ACTIVOS` y `MOROSOS` por `comment=activo_<id>`. Nada más.
   *
   * Lo que NO hace, y por eso no es un `cut()` / `reconnect()` con otro nombre:
   *   · no cambia el estado del abonado en la ficha (ni escribe `SubscriberStatusHistory`,
   *     así que tampoco viaja al legacy por la ida de bajas/reconexiones);
   *   · no tumba la sesión PPP abierta —el corte de verdad sí lo hace, para que el
   *     bloqueo se note en el acto; aquí el cliente sigue navegando hasta que la
   *     sesión se renueve, que es exactamente como se comporta el legacy—;
   *   · no abre ni cierra órdenes, y no cobra prorrateo de reconexión.
   *
   * La única concesión al legacy es habilitar el secret al ACTIVAR: `activar_estado_usuario`
   * manda `disabled=no` y hay ~1.150 abonados cortados con el mecanismo viejo a los que
   * quitarlos de MOROSOS no les devolvería nada si el secret sigue deshabilitado.
   *
   * Es una herramienta de depuración del parque —"probar si este cliente pasa o no pasa
   * por el firewall"—, así que va detrás de un permiso NOMINAL: ni el área ni el
   * superusuario lo heredan (ver `PERMISOS_NOMINALES`).
   */
  async toggleMoroso(
    subscriberId: string,
    accion: 'activar' | 'desactivar',
    user?: AuthUser,
  ): Promise<MikrotikActionResult> {
    if (!tienePermisoNominal(user, APP_PERMISSIONS.NETWORK_MOROSOS_TOGGLE)) {
      throw new ForbiddenException('Este interruptor está reservado a quien lo tenga concedido a su nombre.');
    }
    await this.syncLive();
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s); no hay IP que mover de lista.');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const activar = accion === 'activar';
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: activar ? 'MOROSO_OFF' : 'MOROSO_ON',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    const others = await this.sedeOtherRouters(sub, router.id);

    if (!this.live) {
      res.steps = activar
        ? [
            `connect ${routerInfo.host}`,
            `/ppp/secret/set ?name=${name} disabled=no (solo si venía deshabilitado)`,
            `address-list ${ADDRESS_LIST_DEBTOR} remove (comment=${comment})`,
            `address-list ${ADDRESS_LIST_ACTIVE} add/set (comment=${comment})`,
            ...others.map((o) => `[${o.name}] address-list ${ADDRESS_LIST_DEBTOR} remove (comment=${comment})`),
          ]
        : [
            `connect ${routerInfo.host}`,
            `address-list ${ADDRESS_LIST_ACTIVE} remove (comment=${comment})`,
            `address-list ${ADDRESS_LIST_DEBTOR} add/set (comment=${comment})`,
            ...others.map((o) => `[${o.name}] address-list ${ADDRESS_LIST_DEBTOR} add (comment=${comment})`),
          ];
      res.ok = true;
      res.message = `DRY-RUN: ${activar ? 'activación' : 'desactivación'} simulada de ${name} en ${router.name}. Sin cambios reales.`;
      await this.audit(res.action, sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    let ip = '';
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);

      ip = await this.ipEnElRouter(api, name, sub);
      if (ip) res.steps.push(`IP del abonado: ${ip}`);

      let r: { ok: boolean; steps: string[]; error?: string };
      if (activar) {
        // Igual que el legacy: sanar el secret que un corte viejo dejó deshabilitado.
        const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
        const idSecret = secrets[0]?.['.id'];
        if (idSecret && secrets[0]['disabled'] === 'true') {
          await api.comm('/ppp/secret/set', { '.id': idSecret, disabled: 'no' });
          res.steps.push('secret habilitado (venía disabled=yes)');
        }
        r = await this.unmarkMorosoOnApi(api, sub, ip);
      } else {
        r = await this.markMorosoOnApi(api, sub, ip);
      }
      api.close();
      res.steps.push(...r.steps);
      if (r.ok) {
        res.ok = true;
        res.live = { ip, inActivos: activar, inMorosos: !activar };
        res.message = activar
          ? `${name} fuera de ${ADDRESS_LIST_DEBTOR} en ${router.name}. El estado de la ficha no se toca.`
          : `${name} en ${ADDRESS_LIST_DEBTOR} en ${router.name}. El estado de la ficha no se toca.`;
      } else {
        res.error = r.error;
        res.message = `No se pudo ${activar ? 'activar' : 'desactivar'}: ${r.error}`;
      }
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudo ${activar ? 'activar' : 'desactivar'}: ${res.error}`;
    }

    // Los demás Mikrotiks de la sede: allí el abonado no tiene secret, pero sí debe
    // estar (o no estar) en MOROSOS — si no, sigue navegando por el otro router.
    await this.replicateMorosoOnSede(sub, others, activar ? 'unmark' : 'mark', res, ip);

    await this.audit(res.action, sub, router, res, user);
    return res;
  }

  /**
   * La IP con la que se escribe la address-list, buscada como la busca el legacy:
   * primero la fija del `/ppp/secret`, si no la de la sesión abierta y, en último
   * lugar, la de la ficha. El orden importa: quien no tiene IP fija sólo se puede
   * bloquear por la que está usando ahora mismo.
   */
  private async ipEnElRouter(api: RouterosClient, name: string, sub: SubForNet): Promise<string> {
    try {
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      const delSecret = secrets[0]?.['remote-address'] || '';
      if (esIpValida(delSecret)) return delSecret.trim();
      const activos = await api.comm('/ppp/active/getall', { '?name': name });
      const deSesion = activos[0]?.['address'] || '';
      if (esIpValida(deSesion)) return deSesion.trim();
    } catch {
      // Si el router no deja leer, queda la de la ficha: peor es no poder bloquear.
    }
    return esIpValida(sub.ipRemote) ? (sub.ipRemote as string).trim() : '';
  }

  // ------------------------------------------------------------------
  // ALTA / PROVISIÓN (crear el secret PPPoE en el router)
  // ------------------------------------------------------------------
  /**
   * Los campos de la ficha tal y como los espera un `/ppp/secret`.
   *
   * RouterOS NO acepta cadena vacía en los argumentos de dirección: manda
   * `invalid value for argument remote-address` y tumba el alta entera. Los
   * campos sin valor sencillamente no se mandan y el router los deja en su
   * defecto, que es justo lo que se quiere. El `profile` sale de aquí con el
   * nombre de la ficha: quien vaya a escribir tiene que cambiarlo por el `.id`
   * que devuelva `resolveProfileId` (ver por qué en su encabezado).
   */
  private camposDelSecret(sub: SubForNet, comentario?: string): Record<string, string> {
    const datos: Record<string, string> = {
      name: (sub.pppUsername ?? '').replace(/\s+/g, ''),
      profile: (sub.pppProfile || 'default').trim(),
      service: sub.pppService || 'pppoe',
    };
    if (sub.pppPassword) datos.password = sub.pppPassword;
    if (sub.ipLocal?.trim()) datos['local-address'] = sub.ipLocal.trim();
    const c = (comentario ?? sub.netComment ?? '').trim();
    if (c) datos.comment = c;
    return datos;
  }

  /**
   * IP local para un secret que se va a crear y cuya ficha no la trae (ver
   * `ipLocalDeLaRed`). No leer el router no tumba el alta: nace sin ella, como antes.
   */
  private async ipLocalParaAlta(
    api: RouterosClient,
    ipRemota: string | null,
    secrets?: Record<string, string>[],
  ): Promise<string | null> {
    try {
      const filas = secrets
        ?? await api.comm('/ppp/secret/getall', { '.proplist': 'remote-address,local-address' }, 30000);
      return ipLocalDeLaRed(filas, ipRemota);
    } catch {
      return null;
    }
  }

  /**
   * Al secret que YA existe sin `local-address` (y cuya ficha tampoco la trae) le
   * pone la de su red. Es lo único que toca: la autenticación no reescribe un
   * secret existente, y los creados antes del 2026-09-16 seguían vacíos — en
   * Monterrey eso es `nas-error` y el cliente no navega. Devuelve la IP puesta, o
   * null si no hubo nada que hacer. Nunca lanza.
   */
  async completarIpLocal(subscriberId: string, user?: AuthUser): Promise<string | null> {
    if (!this.live) return null;
    const api = new RouterosClient();
    try {
      const sub = await this.loadSubscriber(subscriberId);
      if (!sub.pppUsername || esIpValida(sub.ipLocal)) return null;
      const router = await this.resolveRouter(sub);
      const name = sub.pppUsername.replace(/\s+/g, '');
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      const [s] = await api.comm('/ppp/secret/getall', { '.proplist': '.id,remote-address,local-address', '?name': name });
      if (!s?.['.id'] || esIpValida(s['local-address'])) return null;
      const ip = await this.ipLocalParaAlta(api, s['remote-address'] ?? null);
      if (!ip) return null;
      await api.comm('/ppp/secret/set', { '.id': s['.id'], 'local-address': ip });
      await this.guardarIpLocal(subscriberId, ip);
      await this.audit('EDIT' as MikrotikAction, sub, router, {
        ok: true, dryRun: false, action: 'EDIT' as MikrotikAction,
        message: `IP local ${ip} puesta en el secret existente ${name} (estaba vacía)`,
        steps: [`local-address vacía → ${ip} (la de su red en ${router.name})`],
      } as any, user);
      return ip;
    } catch (e) {
      this.logger.warn(`completarIpLocal(${subscriberId}): ${(e as Error).message}`);
      return null;
    } finally {
      api.close();
    }
  }

  /**
   * Deja en la ficha la IP local que se acaba de escribir en el router. Con
   * `editedAt` porque `Iplocal` baja del legacy y sin la marca el sync la
   * devolvería vacía a los 15 minutos.
   */
  private async guardarIpLocal(subscriberId: string, ipLocal: string): Promise<void> {
    await this.prisma.subscriber
      .update({ where: { id: subscriberId }, data: { ipLocal, editedAt: new Date() } })
      .catch(() => undefined);
  }

  /**
   * Crea el `/ppp/secret` que falta, sobre una conexión YA abierta.
   *
   * `provision` es el alta a mano y hace lo suyo (crea o ACTUALIZA el que haya,
   * con su propia conexión). Esto es lo que faltaba: dar de alta al que no está
   * desde una sesión que ya está abierta, para los dos caminos por los que un
   * abonado se quedaba sin secret sin que nadie se enterara —la reconexión de
   * quien paga, que decía "no existe en el router" y devolvía ok, y el barrido
   * de madrugada, que se limitaba a CONTARLOS (1.682 el 2026-09-08)—.
   *
   * Nunca pisa un secret que ya exista: quien llama comprueba antes si está.
   *
   * `motivo` (sin error) es la razón por la que un abonado NO se pudo dar de
   * alta con lo que dice su ficha: perfil ambiguo o inexistente, usuario de
   * relleno del legacy, sin IP libre. Es lo que se lista en el informe para que
   * alguien lo corrija, en vez de fallar en silencio.
   */
  private async crearSecretEnApi(
    api: RouterosClient,
    sub: SubForNet,
    router: Mikrotik,
    opts: {
      /** Comentario a escribir si la ficha no trae `netComment`. */
      comentario?: string;
      /** Nacer en MOROSOS si el abonado no está en un estado que deba navegar. */
      marcarSegunEstado?: boolean;
      /** IPs remotas que ya usa este router (las trae el barrido en memoria). */
      ipsUsadas?: Set<string>;
      /** Perfiles ya leídos, para no releerlos por abonado en un barrido. */
      perfiles?: { id: string; name: string }[];
      /** Secrets ya leídos (con `remote-address` y `local-address`), para la IP local. */
      secrets?: Record<string, string>[];
    } = {},
  ): Promise<{ creado: boolean; ip: string | null; steps: string[]; motivo?: string }> {
    const steps: string[] = [];
    const name = (sub.pppUsername ?? '').replace(/\s+/g, '');
    if (!esUsuarioPppUtil(name)) {
      return {
        creado: false, ip: null, steps,
        motivo: `el usuario PPPoE de la ficha ("${(sub.pppUsername ?? '').trim()}") es relleno del legacy, no un nombre`,
      };
    }

    let perfil: { id: string; name: string; origen?: 'ficha' | 'plan' | 'default' };
    try {
      perfil = opts.perfiles
        ? this.elegirPerfilDe(opts.perfiles, sub, router.name)
        : await this.resolveProfileDe(api, sub, router.name);
    } catch (e) {
      return { creado: false, ip: null, steps, motivo: (e as Error).message };
    }

    /**
     * IP fija. El corte mete la IP del cliente en MOROSOS, así que un abonado sin
     * ella no se puede cortar; y una de la ficha que otro secret ya está usando
     * dejaría a los dos sin navegar, así que en ese caso se pide una libre.
     */
    let ip = esIpValida(sub.ipRemote) ? sub.ipRemote!.trim() : null;
    if (ip && opts.ipsUsadas?.has(ip)) {
      steps.push(`la IP ${ip} de la ficha ya la usa otro secret de ${router.name}: se pide una libre`);
      ip = null;
    }
    let reservada: string | null = null;
    if (!ip) {
      const asignada = await this.ips.asignar(router, sub.id);
      if (asignada.ip) {
        ip = reservada = asignada.ip;
        steps.push(`IP ${asignada.ip} repartida automáticamente (quedan ${asignada.libres} libres)`);
      } else {
        steps.push(`sin IP fija: ${asignada.motivo}`);
      }
    }

    const datos = this.camposDelSecret(sub, opts.comentario);
    datos.profile = perfil.id;
    if (ip) datos['remote-address'] = ip;
    const ipLocalNueva = datos['local-address'] ? null : await this.ipLocalParaAlta(api, ip, opts.secrets);
    if (ipLocalNueva) datos['local-address'] = ipLocalNueva;

    try {
      await api.comm('/ppp/secret/add', datos);
    } catch (e) {
      // Soltar la reserva: sin esto cada intento fallido quema una dirección.
      if (reservada) await this.ips.liberar(router, reservada);
      return { creado: false, ip: null, steps, motivo: e instanceof RouterosError ? e.message : (e as Error).message };
    }
    steps.push(
      `secret "${name}" creado · perfil ${perfil.name}${origenDelPerfil(perfil.origen)}`
      + `${ip ? ` · IP ${ip}` : ' · sin IP fija'}`,
    );
    if (ip) opts.ipsUsadas?.add(ip);
    if (ipLocalNueva) {
      steps.push(`IP local ${ipLocalNueva} (la de su red en ${router.name})`);
      await this.guardarIpLocal(sub.id, ipLocalNueva);
      sub.ipLocal = ipLocalNueva;
    }

    if (reservada) {
      // `editedAt` por lo mismo que en `changePlan`: `Ipremota` baja del legacy y
      // sin la marca el sync devolvería la IP vieja a los 15 minutos, dejando la
      // ficha diciendo una dirección distinta de la que el router acaba de
      // escribir — y el corte se hace por esa IP.
      await this.prisma.subscriber
        .update({ where: { id: sub.id }, data: { ipRemote: reservada, editedAt: new Date() } })
        .catch(() => undefined);
      await this.ips.confirmar(router, reservada);
      sub.ipRemote = reservada;
    }

    /**
     * Un secret recién creado deja navegando a su dueño. Si el abonado está
     * cortado o en cartera eso sería regalarle el mes, así que nace con la IP
     * en MOROSOS —que es como corta esta casa— y no navega hasta que pague.
     */
    if (opts.marcarSegunEstado && ip && !ESTADOS_QUE_DEBEN_NAVEGAR.includes(sub.status as any)) {
      const marca = await this.markMorosoOnApi(api, sub, ip);
      steps.push(marca.ok
        ? `${sub.status}: nace en ${ADDRESS_LIST_DEBTOR} (crearlo no le devuelve el servicio)`
        : `no se pudo marcar en ${ADDRESS_LIST_DEBTOR}: ${marca.error}`);
    }

    return { creado: true, ip, steps };
  }

  async provision(subscriberId: string, user?: AuthUser): Promise<MikrotikActionResult> {
    await this.syncLive();
    const full = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, legacyId: true, pppUsername: true, pppPassword: true, pppProfile: true,
        pppService: true, ipRemote: true, ipLocal: true, netComment: true, abonado: true,
        installTech: true, status: true, neighborhood: true, branch: { select: { legacyId: true } },
        // El perfil de respaldo cuando el de la ficha no resuelve (ver `buscarPerfilDe`).
        services: SELECT_PLAN_PPP,
      },
    });
    if (!full) throw new NotFoundException('Cliente no encontrado');
    if (!full.pppUsername) throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s) para dar de alta.');

    const sub = conPerfilDelPlan(full) as unknown as SubForNet;
    const router = await this.resolveRouter(sub);
    const name = full.pppUsername.replace(/\s+/g, '');
    const comment = full.netComment || `${full.neighborhood ?? ''} ${full.abonado ?? ''}`.trim();
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false, dryRun: !this.live, action: 'PROVISION' as MikrotikAction, subscriberId,
      mikrotik: routerInfo, steps: [], message: '',
    };

    // Los campos vacíos no se mandan: RouterOS no acepta cadena vacía en las
    // direcciones y tumbaría el alta entera (ver `camposDelSecret`).
    const secretData = this.camposDelSecret(sub, comment);

    /**
     * IP fija automática. El corte se hace metiendo la IP del cliente en la
     * address-list MOROSOS (ver `cutOnApi`), así que un abonado sin IP fija no se
     * puede cortar: reconecta y sale por otra dirección. Antes la escribía a mano
     * la cajera —de ahí las ~149 repetidas y los 1.611 con `ipRemote = "0"`, que
     * son abonados que en la práctica no se pueden cortar—.
     *
     * Sólo se reparte cuando NO hay una válida: una IP que ya funciona no se toca
     * nunca, porque cambiarla obliga a reiniciar la sesión PPP del cliente.
     */
    const ipActual = esIpValida(full.ipRemote) ? full.ipRemote!.trim() : null;
    let ipReservada: string | null = null;
    if (ipActual) {
      secretData['remote-address'] = ipActual;
    } else if (this.live) {
      const asignada = await this.ips.asignar(router, subscriberId);
      if (asignada.ip) {
        ipReservada = asignada.ip;
        secretData['remote-address'] = asignada.ip;
        res.steps.push(`IP asignada automáticamente: ${asignada.ip} (quedan ${asignada.libres} libres)`);
      } else {
        res.steps.push(`sin IP automática: ${asignada.motivo}`);
      }
    }

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/print ?name=${name}  (¿existe?)`,
        `si no existe → /ppp/secret/add ${Object.entries(secretData).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        `si existe → /ppp/secret/set (actualiza perfil/IP/clave)`,
      ];
      res.ok = true;
      res.message = `DRY-RUN: alta simulada de ${name} en ${router.name}. Sin cambios reales.`;
      await this.audit('PROVISION' as MikrotikAction, sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    let ipLocalNueva: string | null = null;
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);
      // El perfil se manda por .id: el nombre lo resuelve RouterOS por prefijo
      // y un valor ambiguo tumba el alta entera (ver resolveProfileId).
      const perfil = await this.resolveProfileDe(api, sub, router.name);
      secretData.profile = perfil.id;
      res.steps.push(`perfil "${perfil.name}" (${perfil.id})${origenDelPerfil(perfil.origen)}`);
      const existing = await api.comm('/ppp/secret/getall', { '.proplist': '.id,local-address', '?name': name });
      // Sin IP local en la ficha ni en el secret que haya, la de su red: el
      // router no la deja vacía por su cuenta (ver `ipLocalDeLaRed`).
      if (!secretData['local-address'] && !esIpValida(existing[0]?.['local-address'])) {
        ipLocalNueva = await this.ipLocalParaAlta(api, secretData['remote-address'] ?? null);
        if (ipLocalNueva) {
          secretData['local-address'] = ipLocalNueva;
          res.steps.push(`IP local ${ipLocalNueva} (la de su red en ${router.name})`);
        }
      }
      if (existing.length && existing[0]['.id']) {
        await api.comm('/ppp/secret/set', { '.id': existing[0]['.id'], ...secretData });
        res.steps.push('secret existente actualizado');
      } else {
        await api.comm('/ppp/secret/add', secretData);
        res.steps.push('secret creado');
      }
      api.close();
      res.ok = true;
      res.message = `Alta aplicada: ${name} provisionado en ${router.name}.`;
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Fallo el alta: ${res.error}`;
    }
    if (res.ok && ipLocalNueva) await this.guardarIpLocal(subscriberId, ipLocalNueva);

    // La IP se guarda en la ficha SÓLO si de verdad quedó en el router: si el
    // alta falló, soltarla evita quemar una dirección por cada reintento.
    if (ipReservada) {
      if (res.ok) {
        await this.prisma.subscriber
          // `editedAt` por lo mismo que el perfil en `changePlan`: `Ipremota` baja del
          // legacy, y sin la marca el sync devuelve la IP vieja (o vacía) a los 15
          // minutos, dejando la ficha diciendo una dirección distinta de la que el
          // router acaba de escribir en el secret — y el corte se hace por esa IP.
          .update({ where: { id: subscriberId }, data: { ipRemote: ipReservada, editedAt: new Date() } })
          .catch(() => undefined);
        await this.ips.confirmar(router, ipReservada);
      } else {
        await this.ips.liberar(router, ipReservada);
        res.steps.push(`IP ${ipReservada} liberada (el alta no llegó a aplicarse)`);
      }
    }

    await this.audit('PROVISION' as MikrotikAction, sub, router, res, user);
    return res;
  }

  /**
   * Deja al cliente con IP REMOTA ACTIVA: una dirección fija suya, escrita en su
   * `/ppp/secret` y guardada en la ficha. Es lo que resuelve el bloqueo del cierre
   * de órdenes (`ip-remota.policy.ts`, 2026-09-10) y lo que necesita sistemas para
   * entrar al equipo del abonado — y el corte para poder bloquearlo.
   *
   * Por qué no se reutiliza `provision()`, que también reparte IP: porque además
   * escribe perfil, clave y comentario. En un secret que ya existe y funciona eso es
   * demasiado: el técnico que sólo viene a poner la IP podría cambiarle la velocidad
   * al cliente si la ficha tiene el perfil mal. Aquí se toca UNA cosa.
   *
   * Orden de lo que hace:
   *  1. Si la ficha ya trae una IP utilizable, se respeta (una que funciona no se
   *     cambia nunca: obliga a reiniciar la sesión PPP del cliente). Salvo que otro
   *     secret del mismo router la tenga ya, y entonces no es suya: se pide una libre.
   *  2. Si no, la reparte `IpAllocatorService` desde los /24 que ese router usa.
   *  3. Se escribe en el secret, se corrigen las entradas de ACTIVOS/MOROSOS —que
   *     guardan la dirección, y con la vieja el corte dejaría de bloquearlo— y se
   *     reinicia la sesión para que tome efecto.
   *  4. Sólo si el router lo aceptó se guarda en la ficha, con `editedAt` (sin ese
   *     sello el sync devuelve la IP vieja a los 15 minutos).
   *
   * Si el secret no existe todavía no hay nada que preservar: ahí sí delega en
   * `provision()`, que es el alta completa.
   *
   * Dry-run salvo MIKROTIK_LIVE=true / el interruptor de Configuración, como todo lo
   * demás que toca un router. Auditado como `EDIT`.
   */
  async garantizarIpRemota(
    subscriberId: string,
    user?: AuthUser,
  ): Promise<MikrotikActionResult & { ip: string | null }> {
    await this.syncLive();
    const full = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, legacyId: true, pppUsername: true, pppPassword: true, pppProfile: true,
        pppService: true, ipRemote: true, ipLocal: true, netComment: true, abonado: true,
        installTech: true, status: true, neighborhood: true, branch: { select: { legacyId: true } },
        services: SELECT_PLAN_PPP,
      },
    });
    if (!full) throw new NotFoundException('Cliente no encontrado');
    if (!esUsuarioPppUtil(full.pppUsername)) {
      throw new BadRequestException(
        'Este cliente no tiene usuario PPPoE (su servicio no es de internet): no hay IP remota que activar.',
      );
    }

    const sub = conPerfilDelPlan(full) as unknown as SubForNet;
    const router = await this.resolveRouter(sub);
    const name = full.pppUsername!.replace(/\s+/g, '');
    const comentario = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const ipFicha = esIpRemotaUtil(full.ipRemote) ? full.ipRemote!.trim() : null;
    const res: MikrotikActionResult & { ip: string | null } = {
      ok: false, dryRun: !this.live, action: 'EDIT', subscriberId,
      mikrotik: routerInfo, steps: [], message: '', ip: ipFicha,
    };

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/print ?name=${name}`,
        ipFicha
          ? `remote-address ← ${ipFicha} (la de la ficha, si no la usa otro secret)`
          : 'pedir una IP libre al repartidor (las redes que ya usa este router)',
        `/ip/firewall/address-list/set ?comment=${comentario} address=<la IP>  (ACTIVOS y MOROSOS)`,
        `/ppp/active/remove ?name=${name}  (para que tome la dirección)`,
      ];
      res.ok = true;
      res.message = ipFicha
        ? `DRY-RUN: se comprobaría que ${name} tenga ${ipFicha} en ${router.name}. Sin cambios reales.`
        : `DRY-RUN: se le repartiría una IP libre de ${router.name} a ${name}. Sin cambios reales.`;
      await this.audit('EDIT', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    let reservada: string | null = null;
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);
      const filas = await api.comm('/ppp/secret/getall', { '?name': name });
      const secret = filas[0];
      if (!secret?.['.id']) {
        // No hay secret que arreglar: esto es un alta, y el alta ya reparte IP.
        api.close();
        res.steps.push(`${name} no tiene secret en ${router.name}: se da de alta (reparte IP)`);
        const alta = await this.provision(subscriberId, user);
        const despues = await this.prisma.subscriber.findUnique({
          where: { id: subscriberId }, select: { ipRemote: true },
        });
        return {
          ...alta,
          steps: [...res.steps, ...alta.steps],
          ip: esIpRemotaUtil(despues?.ipRemote) ? despues!.ipRemote!.trim() : null,
        };
      }

      let ip = ipFicha;
      if (ip) {
        /**
         * ¿La dirección de la ficha la tiene ya OTRO secret? Pasa: 1.089 abonados
         * vivos comparten IP con alguien (erratas de cuando la escribía la cajera a
         * mano). Dejarla duplicada es peor que no tenerla — sistemas entraría a quien
         * no es y el corte bloquearía a los dos —, así que se pide una libre.
         */
        const conEsaIp = await api.comm('/ppp/secret/getall', { '?remote-address': ip });
        const ajena = conEsaIp.find((s) => (s.name ?? '').replace(/\s+/g, '') !== name);
        if (ajena) {
          res.steps.push(`la IP ${ip} de la ficha ya la usa el secret "${ajena.name}": se pide una libre`);
          ip = null;
        }
      }
      if (!ip) {
        const asignada = await this.ips.asignar(router, subscriberId);
        if (!asignada.ip) {
          api.close();
          res.error = asignada.motivo ?? 'no hay IPs libres';
          res.message = `No se pudo repartir IP remota en ${router.name}: ${res.error}`;
          await this.audit('EDIT', sub, router, res, user);
          return res;
        }
        ip = reservada = asignada.ip;
        res.steps.push(`IP ${ip} repartida automáticamente (quedan ${asignada.libres} libres)`);
      }

      const enElRouter = (secret['remote-address'] ?? '').trim();
      if (enElRouter === ip) {
        res.steps.push(`el secret de ${name} ya tenía ${ip}`);
      } else {
        await api.comm('/ppp/secret/set', { '.id': secret['.id'], 'remote-address': ip });
        res.steps.push(`remote-address ${enElRouter || '(vacío)'} → ${ip}`);
        // Las entradas de ACTIVOS/MOROSOS guardan la dirección: con la vieja, el
        // corte deja de bloquear a este abonado y bloquea a quien herede esa IP.
        for (const lista of [ADDRESS_LIST_ACTIVE, ADDRESS_LIST_DEBTOR]) {
          const entradas = await api.comm('/ip/firewall/address-list/print', { '?list': lista, '?comment': comentario });
          for (const e of entradas) {
            if (!e['.id'] || e.address === ip) continue;
            await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ip });
            res.steps.push(`${lista}: ${e.address} → ${ip}`);
          }
        }
        // Sin reiniciar la sesión el cliente sigue navegando con la dirección vieja,
        // que es justamente la que nadie puede alcanzar.
        const activa = await api.comm('/ppp/active/getall', { '.proplist': '.id', '?name': name });
        if (activa[0]?.['.id']) {
          await api.comm('/ppp/active/remove', { '.id': activa[0]['.id'] });
          res.steps.push('sesión activa reiniciada (toma la IP nueva)');
        }
      }
      api.close();
      res.ip = ip;
      res.ok = true;
      res.message = `${name} quedó con IP remota ${ip} en ${router.name}.`;
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudo activar la IP remota en el router: ${res.error}`;
    }

    if (reservada) {
      if (res.ok) await this.ips.confirmar(router, reservada);
      else {
        // Sin esto, cada reintento fallido quema una dirección del bloque.
        await this.ips.liberar(router, reservada);
        res.steps.push(`IP ${reservada} liberada (no llegó a aplicarse)`);
      }
    }
    // La ficha se actualiza SÓLO con lo que el router aceptó: es la que manda para el
    // corte, y `editedAt` es lo que impide que el sync la devuelva atrás en 15 min.
    if (res.ok && res.ip && res.ip !== (full.ipRemote ?? '').trim()) {
      await this.prisma.subscriber
        .update({ where: { id: subscriberId }, data: { ipRemote: res.ip, editedAt: new Date() } })
        .catch(() => undefined);
      res.steps.push('ficha actualizada con la IP remota');
    }

    await this.audit('EDIT', sub, router, res, user);
    return res;
  }

  /**
   * Empuja un nuevo perfil PPP (velocidad/plan) al router y reinicia la sesión
   * activa para que tome efecto de inmediato. Dry-run salvo MIKROTIK_LIVE=true.
   * No cambia el estado del abonado; solo el perfil en el /ppp/secret.
   */
  async applyProfile(subscriberId: string, profileRaw: string, user?: AuthUser): Promise<MikrotikActionResult> {
    await this.syncLive();
    // Trim del perfil: un espacio inicial/final en los datos hacía que el perfil
    // no coincidiera con el del RouterOS y el cliente no tomara plan (bug conocido).
    const profile = (profileRaw || 'default').trim();
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s) para cambiar el perfil.');
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false, dryRun: !this.live, action: 'PROFILE', subscriberId,
      mikrotik: routerInfo, steps: [], message: '',
    };

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/set ?name=${name} profile=${profile}`,
        `/ppp/active/remove ?name=${name}  (reinicia sesión para aplicar el perfil)`,
      ];
      res.ok = true;
      res.message = `DRY-RUN: perfil de ${name} → "${profile}" en ${router.name}. Sin cambios reales.`;
      await this.audit('PROFILE', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);
      const secret = await api.comm('/ppp/secret/getall', { '.proplist': '.id', '?name': name });
      if (!secret.length || !secret[0]['.id']) throw new RouterosError(`No existe /ppp/secret para ${name}.`);
      // Por .id, no por nombre: un perfil ambiguo dejaba al cliente sin cambio
      // de plan con un error que nadie sabía leer (ver resolveProfileId).
      const perfil = await this.resolveProfileId(api, profile, router.name);
      await api.comm('/ppp/secret/set', { '.id': secret[0]['.id'], profile: perfil.id });
      res.steps.push(`perfil actualizado → ${perfil.name}`);
      const active = await api.comm('/ppp/active/getall', { '.proplist': '.id', '?name': name });
      if (active.length && active[0]['.id']) {
        await api.comm('/ppp/active/remove', { '.id': active[0]['.id'] });
        res.steps.push('sesión activa reiniciada (aplica el nuevo perfil)');
      }
      api.close();
      res.ok = true;
      res.message = `Perfil aplicado: ${name} → "${profile}" en ${router.name}.`;
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Falló el cambio de perfil: ${res.error}`;
    }
    await this.audit('PROFILE', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // EDICIÓN DE LA FICHA → SECRET (lo que se corrige aquí, se corrige allá)
  // ------------------------------------------------------------------
  /**
   * Lleva al `/ppp/secret` del router lo que dice la ficha del cliente después de
   * guardar «Plan y conexión».
   *
   * Hacía falta porque guardar la ficha sólo escribía en la base: el comentario y
   * la IP remota se corregían aquí y el router seguía con los de antes, así que la
   * ficha decía una cosa y el abonado navegaba con otra. Y la IP importa el doble:
   * el corte se hace metiendo ESA dirección en la address-list MOROSOS, o sea que
   * una IP cambiada sólo en la ficha deja al cliente sin poder cortarse.
   *
   * NO compara contra lo que se acaba de teclear, sino contra lo que el router
   * TIENE: la abonada 57458 tenía la IP local y la VLAN puestas en la ficha desde
   * antes de que esto existiera —o sea, sin cambio que detectar— y su secret seguía
   * sin `local-address` y con el comentario viejo. Guardar la ficha vuelve a poner
   * de acuerdo a los dos, aunque en ese guardado no se haya tocado nada.
   *
   * QUÉ se reconcilia SIEMPRE (manda la ficha): `comment`, `remote-address` y
   * `local-address`. QUÉ sólo si se acaba de editar: `name`, `password` y `profile`
   * —si la ficha se equivocara ahí, pisarlos deja al abonado sin autenticar o con
   * otra velocidad, así que una diferencia que nadie pidió cambiar sólo se avisa—.
   * QUÉ nunca: las MAC del equipo y de la ONT (son inventario, el secret no tiene
   * dónde recibirlas) ni el estado del abonado (para eso están `cut`/`reconnect`).
   *
   * Dry-run salvo MIKROTIK_LIVE=true / el interruptor de Configuración. Auditado
   * como acción `EDIT`, igual que el alta o el corte.
   */
  async aplicarEdicionDeFicha(
    subscriberId: string,
    antes: SnapshotConexion,
    user?: AuthUser,
  ): Promise<MikrotikActionResult> {
    await this.syncLive();
    const full = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, legacyId: true, pppUsername: true, pppPassword: true, pppProfile: true,
        ipRemote: true, ipLocal: true, netComment: true,
        installTech: true, status: true, branch: { select: { legacyId: true } },
      },
    });
    if (!full) throw new NotFoundException('Cliente no encontrado');

    const norm = (v?: string | null) => (v ?? '').trim();
    /** Campos que este guardado tocó de verdad (lo demás se reconcilia, no se pisa). */
    const editados = CAMPOS_DE_CONEXION.filter(
      (k) => Object.prototype.hasOwnProperty.call(antes, k) && norm(antes[k]) !== norm(full[k]),
    );

    const sub = full as unknown as SubForNet;
    const nombreAhora = norm(full.pppUsername).replace(/\s+/g, '');
    // El secret se BUSCA por el nombre viejo: el router todavía no sabe del cambio.
    const nombreAntes = (norm(antes.pppUsername) || norm(full.pppUsername)).replace(/\s+/g, '');
    const router = await this.resolveRouter(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false, dryRun: !this.live, action: 'EDIT', subscriberId,
      mikrotik: routerInfo, steps: [], message: '',
    };

    if (!nombreAntes) {
      res.ok = true;
      res.message = 'El cliente no tiene usuario PPPoE: no hay secret que actualizar en el router.';
      await this.audit('EDIT', sub, router, res, user);
      return res;
    }

    const comentario = this.comment(sub);

    if (!this.live) {
      // En simulación no se lee el router, así que el plan enseña la INTENCIÓN:
      // qué se compara y con qué valor de la ficha.
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/print ?name=${nombreAntes}  (comparar con la ficha)`,
        `comment ← "${norm(full.netComment)}"`,
        `remote-address ← ${esIpValida(full.ipRemote) ? norm(full.ipRemote) : '(la ficha no trae IP)'}`,
        `local-address ← ${esIpValida(full.ipLocal) ? norm(full.ipLocal) : '(la ficha no trae IP local)'}`,
        ...(editados.includes('pppUsername') && nombreAhora ? [`name ← ${nombreAhora}`] : []),
        ...(editados.includes('pppPassword') && norm(full.pppPassword) ? ['password ← (el de la ficha)'] : []),
        ...(editados.includes('pppProfile') && norm(full.pppProfile) ? [`profile ← ${norm(full.pppProfile)}`] : []),
        `/ip/firewall/address-list/set ?comment=${comentario} address=<IP de la ficha>  (ACTIVOS y MOROSOS)`,
        `/ppp/active/remove ?name=${nombreAntes}  (sólo si cambia nombre, perfil o IP)`,
      ];
      res.ok = true;
      res.message = `DRY-RUN: la ficha de ${nombreAntes} se compararía con su secret en ${router.name}. Sin cambios reales.`;
      await this.audit('EDIT', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);
      let filas = await api.comm('/ppp/secret/getall', { '?name': nombreAntes });
      if (!filas[0]?.['.id'] && nombreAhora && nombreAhora !== nombreAntes) {
        // Reintento idempotente: si el renombrado ya se había aplicado, el secret
        // vive con el nombre nuevo y buscarlo por el viejo no encuentra nada.
        filas = await api.comm('/ppp/secret/getall', { '?name': nombreAhora });
        if (filas[0]?.['.id']) res.steps.push(`el secret ya se llamaba ${nombreAhora}`);
      }
      const enElRouter = filas[0];
      if (!enElRouter?.['.id']) {
        throw new RouterosError(
          `No existe /ppp/secret para "${nombreAntes}" en ${router.name}: la ficha quedó guardada, `
          + 'pero para que el router la refleje hay que darlo de alta (Provisionar).',
        );
      }

      const { set, unset, avisos } = conciliarSecret(full, enElRouter, editados);

      if (set.profile) {
        // Por `.id`, no por nombre: un perfil ambiguo tumba el /set entero (ver resolveProfileId).
        const perfil = await this.resolveProfileId(api, set.profile, router.name);
        set.profile = perfil.id;
        res.steps.push(`perfil "${perfil.name}" (${perfil.id})`);
      }
      if (Object.keys(set).length) {
        await api.comm('/ppp/secret/set', { '.id': enElRouter['.id'], ...set });
        res.steps.push(`secret actualizado: ${Object.entries(set).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
      for (const k of unset) {
        await api.comm('/ppp/secret/unset', { '.id': enElRouter['.id'], 'value-name': k });
        res.steps.push(`${k} borrado del secret`);
      }

      /**
       * Y la address-list detrás de la IP: las entradas de ACTIVOS/MOROSOS se
       * localizan por `comment=activo_<legacyId>` y guardan la dirección. Si la IP
       * cambia y ellas se quedan con la vieja, el corte deja de bloquear a este
       * abonado y —peor— bloquea al que herede esa dirección del pool.
       */
      const nuevaIp = set['remote-address'];
      if (nuevaIp) {
        for (const lista of [ADDRESS_LIST_ACTIVE, ADDRESS_LIST_DEBTOR]) {
          const entradas = await api.comm('/ip/firewall/address-list/print', { '?list': lista, '?comment': comentario });
          for (const e of entradas) {
            if (!e['.id'] || e.address === nuevaIp) continue;
            await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: nuevaIp });
            res.steps.push(`${lista}: ${e.address} → ${nuevaIp}`);
          }
        }
      }

      /**
       * La sesión PPP viva se reinicia sólo cuando el cambio no puede tomar efecto
       * sin reconectar (nombre, perfil o direcciones). Por un comentario no se le
       * tumba la conexión al cliente: sería un corte gratuito.
       */
      const reinicia = ['name', 'profile', 'remote-address', 'local-address'];
      if (reinicia.some((k) => k in set) || unset.some((k) => reinicia.includes(k))) {
        const activa = await api.comm('/ppp/active/getall', { '.proplist': '.id', '?name': nombreAntes });
        if (activa[0]?.['.id']) {
          await api.comm('/ppp/active/remove', { '.id': activa[0]['.id'] });
          res.steps.push('sesión activa reiniciada (aplica los cambios)');
        }
      }
      api.close();

      for (const a of avisos) res.steps.push(`⚠ ${a}`);
      res.ok = true;
      const tocados = [...Object.keys(set), ...unset];
      res.message = tocados.length
        ? `Aplicado en ${router.name}: ${tocados.join(', ')}.`
        : `El secret de ${nombreAntes} en ${router.name} ya coincidía con la ficha.`;
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudieron aplicar los cambios en el router: ${res.error}`;
    }

    await this.audit('EDIT', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // ESTADO EN VIVO
  // ------------------------------------------------------------------
  /**
   * MAC con la que el cliente está conectado AHORA: el caller-id de su sesión PPPoE.
   * Es la del aparato que de verdad está en la casa, diga lo que diga el inventario;
   * la señal óptica la usa para encontrar la ONU cuando el equipo asignado no aparece
   * en la OLT. null si no hay sesión, router o modo real — nunca lanza.
   */
  async callerIdDeAbonado(subscriberId: string): Promise<string | null> {
    const api = new RouterosClient();
    try {
      await this.syncLive();
      if (!this.live) return null;
      const sub = await this.loadSubscriber(subscriberId);
      if (!sub.pppUsername) return null;
      const router = await this.resolveRouter(sub);
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 6000 });
      const active = await api.comm('/ppp/active/getall', { '?name': sub.pppUsername.replace(/\s+/g, '') });
      const mac = String(active[0]?.['caller-id'] ?? '').trim().toUpperCase();
      return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null;
    } catch {
      return null;
    } finally {
      api.close();
    }
  }

  async liveStatus(subscriberId: string): Promise<MikrotikActionResult> {
    const hit = this.statusCache.get(subscriberId);
    if (hit && Date.now() - hit.at < MikrotikService.STATUS_TTL_MS) return hit.res;
    await this.syncLive();
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s).');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'STATUS',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    if (!this.live) {
      res.ok = true;
      res.message = 'DRY-RUN: no se consulta el router. Active MIKROTIK_LIVE=true para estado real.';
      res.live = {};
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 6000 });
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      const active = await api.comm('/ppp/active/getall', { '?name': name });
      const inAct = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE, '?comment': comment });
      const inMor = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR, '?comment': comment });
      api.close();
      res.live = {
        secretExists: secrets.length > 0,
        secretDisabled: secrets[0]?.['disabled'] === 'true',
        sessionActive: active.length > 0,
        ip: secrets[0]?.['remote-address'] || active[0]?.['address'] || sub.ipRemote || '',
        inActivos: inAct.length > 0,
        inMorosos: inMor.length > 0,
      };
      res.ok = true;
      res.message = 'Estado leído del router.';
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudo leer el estado: ${res.error}`;
    }
    // Se guarda también el fallo: si el router no responde, no tiene sentido que
    // cada ficha abierta se quede otros 6 s esperando el mismo timeout.
    this.statusCache.set(subscriberId, { at: Date.now(), res });
    return res;
  }

  // ------------------------------------------------------------------
  // TEST de conexión a un router
  // ------------------------------------------------------------------
  async testRouter(mikrotikId: string): Promise<MikrotikActionResult> {
    await this.syncLive();
    const router = await this.prisma.mikrotik.findUnique({ where: { id: mikrotikId } });
    if (!router) throw new NotFoundException('Mikrotik no encontrado');
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'TEST',
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };
    if (!this.live) {
      res.ok = true;
      res.message = `DRY-RUN: no se contacta ${routerInfo.host}. Active MIKROTIK_LIVE=true para probar de verdad.`;
      return res;
    }
    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 6000 });
      const id = await api.comm('/system/identity/print');
      api.close();
      res.ok = true;
      res.steps.push(`identity=${id[0]?.['name'] ?? '?'}`);
      res.message = `Conexión OK con ${router.name} (${routerInfo.host}).`;
      await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: true } }).catch(() => undefined);
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudo conectar a ${router.name}: ${res.error}`;
      await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: false } }).catch(() => undefined);
    }
    return res;
  }

  // ------------------------------------------------------------------
  // BARRIDO: que la ficha y el secret digan lo mismo, sin abrir cliente por cliente
  // ------------------------------------------------------------------
  /**
   * Recorre los abonados con servicio y pone su `/ppp/secret` de acuerdo con la ficha.
   *
   * Guardar la ficha ya concilia a UNO (ver `aplicarEdicionDeFicha`), pero eso obliga a
   * que alguien abra el cliente: el desfase que traía el legacy —comentarios viejos, IP
   * local sin escribir— sólo se arreglaría a medida que alguien pase por cada ficha.
   * Esto lo arregla de una y, corriendo a diario, no deja que vuelva a acumularse.
   *
   * Es DELIBERADAMENTE más prudente que el guardado a mano, porque aquí no hay nadie
   * mirando la pantalla:
   *   · `comment` y `local-address`: se ponen como diga la ficha.
   *   · `remote-address`: SÓLO se rellena si el secret no tiene ninguna y esa IP no la
   *     está usando otro secret del mismo router. Una IP que ya funciona no se re-apunta
   *     en un barrido (la ficha arrastra ~1.611 con "0" y direcciones repetidas del
   *     legacy, y equivocarse ahí deja al abonado sin navegar).
   *   · usuario, clave y perfil: NO se tocan nunca. Sólo se cuentan los que difieren.
   *   · no se reinicia ninguna sesión PPP: los cambios entran cuando el cliente
   *     reconecta. Tumbarle la conexión a miles de abonados de madrugada no.
   *
   * Y da de alta al que NO TIENE secret (`altaDelQueFalta`), que es la única forma
   * de que el router acabe teniendo a todos: el alta de un cliente nuevo se cae de
   * vez en cuando —perfil ambiguo, sesión perdida— y hasta ahora el abonado se
   * quedaba sin navegar hasta que alguien abriera su ficha y lo notara. Nace en
   * MOROSOS si el abonado está cortado, para no regalarle el mes.
   *
   * Una conexión por router y un solo `/ppp/secret/getall` por router (8.500 secrets en
   * una llamada), no una consulta por abonado.
   */
  /**
   * El abonado no tiene secret: se le da de alta, o se dice por qué no se puede.
   *
   * Aquí está el trabajo que el barrido no hacía. Contaba los que faltaban y
   * seguía, así que el abonado recién instalado cuyo alta se cayó (perfil
   * ambiguo, sesión perdida) se quedaba sin navegar hasta que alguien abriera su
   * ficha y lo notara. Los motivos por los que NO se crea son tan importantes
   * como las altas: son la lista de fichas que hay que corregir a mano.
   *
   * Tres cosas frenan un alta automática, y ninguna es un fallo del router:
   *   · usuario de relleno del legacy ('0', '-'): ése no es un abonado con
   *     internet, es un cliente de TV. No lleva secret y no debe contar como
   *     pendiente.
   *   · el perfil de la ficha no identifica UNO solo del router: crear con el
   *     perfil equivocado es peor que no crear (velocidad ajena o alta caída).
   *   · su IP ya la tiene otro secret: casi siempre es él mismo con el nombre
   *     mal escrito (MIRAMCUBIDESCUESTA / MIRIAMCUBIDESCUESTA). Crear el
   *     segundo deja dos secrets peleándose la misma dirección.
   */
  /**
   * Qué nombres existen ya en CADA sede, mirando todos sus routers.
   *
   * Una sede tiene varios equipos (Villanueva: uno EOC/EPON y otro GPON) y el
   * abonado se busca sólo en el que le toca por `installTech`. Cuando esa
   * tecnología está mal puesta en la ficha —ELISABETHRODRIGUEZSANABRIA figura
   * como EPON y su secret vive en el GPON, navegando— el barrido lo daba por
   * ausente y le habría creado un SEGUNDO secret en la otra caja, con la misma
   * IP. Antes de crear nada se comprueba aquí: si ya está en la sede, lo que hay
   * que arreglar es la ficha, no el router.
   *
   * Una lectura por equipo FÍSICO (`ip:puerto`): EOC y EPON son la misma caja
   * dada de alta dos veces y comparten los secrets.
   */
  private async censoDeNombresPorSede(routers: Mikrotik[]): Promise<Map<number, Map<string, string>>> {
    const clave = (v?: string | null) => (v ?? '').trim().replace(/\s+/g, '').toLowerCase();
    const porSede = new Map<number, Map<string, string>>();
    const leidos = new Set<string>();

    for (const r of routers) {
      const marca = `${r.sedeLegacy}|${r.ip}:${r.port}`;
      if (leidos.has(marca)) continue;
      leidos.add(marca);
      const api = new RouterosClient();
      try {
        await api.connect(r.ip, Number(r.port), r.username, decryptSecret(r.password), { timeoutMs: 10000 });
        const filas = await api.comm('/ppp/secret/getall', { '.proplist': 'name' }, 30000);
        const m = porSede.get(r.sedeLegacy) ?? new Map<string, string>();
        for (const f of filas) if (f.name && !m.has(clave(f.name))) m.set(clave(f.name), r.name);
        porSede.set(r.sedeLegacy, m);
      } catch (e) {
        // Un equipo que no responde no puede frenar el barrido: sin su censo se
        // pierde el aviso de "ya está en el otro", no la capacidad de dar de alta.
        this.logger.warn(`No se pudo censar nombres de ${r.name}: ${(e as Error).message}`);
      }
      api.close();
    }
    return porSede;
  }

  private async altaDelQueFalta(
    api: RouterosClient,
    sub: SubForNet & { abonado?: number | null },
    router: Mikrotik,
    resumen: ResumenConciliacion,
    parte: { creados: number },
    opts: {
      crear: boolean; ipsUsadas: Set<string>; nombrePorIp: Map<string, string>;
      perfiles: { id: string; name: string }[];
      /** Nombres que ya existen en algún equipo de la sede (ver `censoDeNombresPorSede`). */
      enLaSede?: Map<string, string>;
      /** Los secrets del router ya leídos, para la IP local del alta. */
      secrets?: Record<string, string>[];
    },
  ): Promise<void> {
    const usuario = (sub.pppUsername ?? '').trim();
    const apuntar = (motivo: string) => {
      if (resumen.faltantes.length < 300) {
        resumen.faltantes.push({ abonado: sub.abonado ?? null, usuario, router: router.name, motivo });
      }
    };

    if (!esUsuarioPppUtil(usuario)) { resumen.sinUsuarioReal++; return; }

    // Ya está en otro equipo de la sede: crear el segundo no le daría internet a
    // nadie y dejaría dos secrets con la misma IP en cajas distintas.
    const otroEquipo = opts.enLaSede?.get(usuario.replace(/\s+/g, '').toLowerCase());
    if (otroEquipo && otroEquipo !== router.name) {
      resumen.enOtroEquipoDeLaSede++;
      apuntar(`ya existe en ${otroEquipo}: la tecnología de la ficha (${sub.installTech ?? '—'}) lo manda al equipo equivocado`);
      return;
    }

    /**
     * Su IP ya la tiene otro secret. Hay dos casos MUY distintos detrás y hasta
     * aquí se trataban igual (no crear), lo que dejaba sin internet a gente que
     * sólo arrastraba una IP mal apuntada en la ficha:
     *
     *  · el otro secret se llama casi igual (MIRAMCUBIDESCUESTA contra
     *    MIRIAMCUBIDESCUESTA): es ÉL, escrito mal el día del alta. Crear el
     *    segundo deja dos secrets peleándose la misma dirección y al abonado
     *    navegando por el que no es. Eso se sigue sin tocar: es trabajo de ficha.
     *  · el otro es un desconocido: la IP de la ficha es basura del legacy y
     *    quien manda es el router. Se le da de alta con una dirección LIBRE,
     *    que es justo lo que hace el repartidor si no se le da ninguna.
     */
    const ipFicha = esIpValida(sub.ipRemote) ? sub.ipRemote!.trim() : null;
    if (ipFicha && opts.ipsUsadas.has(ipFicha)) {
      const dueño = opts.nombrePorIp.get(ipFicha) ?? '';
      if (esElMismoNombre(usuario, dueño)) {
        resumen.posibleDuplicado++;
        apuntar(`su IP ${ipFicha} ya la usa el secret "${dueño}", que es su mismo nombre mal escrito: corregir la ficha antes de crear nada`);
        return;
      }
      // No se apunta como pendiente: se crea igual, y el paso queda en la
      // constancia del alta ("la IP … ya la usa otro secret: se pide una libre").
      resumen.ipDeFichaOcupada++;
    }

    // El perfil se comprueba SIEMPRE, también en modo informe: saber cuáles no
    // se pueden crear es la mitad del valor del barrido.
    const perfil = this.buscarPerfilDe(opts.perfiles, sub);
    if (!perfil.perfil) {
      resumen.perfilSinResolver++;
      apuntar(this.motivoDelPerfil(perfil));
      return;
    }

    if (!opts.crear) { resumen.porCrear++; apuntar('listo para dar de alta'); return; }

    const alta = await this.crearSecretEnApi(api, sub, router, {
      marcarSegunEstado: true, ipsUsadas: opts.ipsUsadas, perfiles: opts.perfiles, secrets: opts.secrets,
    });
    if (alta.creado) {
      resumen.creados++; parte.creados++;
      if (resumen.muestra.length < 40) {
        resumen.muestra.push({ abonado: sub.abonado ?? null, usuario, router: router.name, cambios: `ALTA · ${alta.steps.join(' · ')}` });
      }
    } else {
      resumen.noSePudoCrear++;
      apuntar(alta.motivo ?? 'el router rechazó el alta');
    }
  }

  async conciliarSecretsEnLote(
    opts: { mikrotikId?: string; branchId?: string; aplicar?: boolean; limite?: number; crearFaltantes?: boolean } = {},
    user?: AuthUser,
  ): Promise<ResumenConciliacion> {
    await this.syncLive();
    const aplicar = opts.aplicar !== false;
    const crearFaltantes = opts.crearFaltantes !== false;
    const resumen: ResumenConciliacion = {
      dryRun: !this.live || !aplicar,
      total: 0, alDia: 0, corregidos: 0, sinSecret: 0, sinRouter: 0,
      creados: 0, porCrear: 0, sinUsuarioReal: 0, perfilSinResolver: 0,
      posibleDuplicado: 0, ipDeFichaOcupada: 0, enOtroEquipoDeLaSede: 0, noSePudoCrear: 0, faltantes: [],
      comentario: 0, comentarioVacio: 0, ipLocal: 0, ipRemota: 0,
      ipOmitida: 0, ipLocalOmitida: 0, perfilDistinto: 0, claveDistinta: 0,
      routers: [], muestra: [], message: '',
    };

    if (!this.live) {
      resumen.message = 'DRY-RUN: no se contacta ningún router. Active MIKROTIK_LIVE=true (o el interruptor de Configuración).';
      return resumen;
    }

    const routers = await this.prisma.mikrotik.findMany({
      where: { ...(opts.mikrotikId ? { id: opts.mikrotikId } : {}) },
    });
    const subs = (await this.prisma.subscriber.findMany({
      where: {
        pppUsername: { not: null },
        status: { in: [...ESTADOS_CON_SERVICIO] as any },
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
      },
      select: {
        id: true, abonado: true, legacyId: true, pppUsername: true, pppPassword: true,
        pppProfile: true, pppService: true, ipRemote: true, ipLocal: true, netComment: true,
        installTech: true, status: true, branch: { select: { legacyId: true } },
        // El perfil de respaldo cuando el de la ficha no resuelve (ver `buscarPerfilDe`).
        // Una consulta más para todo el lote, no una por abonado.
        services: SELECT_PLAN_PPP,
      },
      take: opts.limite && opts.limite > 0 ? opts.limite : undefined,
    })).map(conPerfilDelPlan);
    resumen.total = subs.length;

    // Reparto por router SIN consultar la tabla por abonado.
    const grupos = new Map<string, { router: Mikrotik; subs: typeof subs }>();
    for (const sub of subs) {
      const deLaSede = sub.branch ? routers.filter((r) => r.sedeLegacy === sub.branch!.legacyId) : [];
      const router = deLaSede.length ? this.elegirRouter(sub.installTech, deLaSede) : undefined;
      if (!router || (opts.mikrotikId && router.id !== opts.mikrotikId)) { resumen.sinRouter++; continue; }
      const g = grupos.get(router.id) ?? { router, subs: [] as typeof subs };
      g.subs.push(sub);
      grupos.set(router.id, g);
    }

    const norm = (v?: string | null) => (v ?? '').trim();
    const enLaSede = await this.censoDeNombresPorSede(routers);

    for (const { router, subs: delRouter } of grupos.values()) {
      const parte = { name: router.name, total: delRouter.length, alDia: 0, corregidos: 0, sinSecret: 0, creados: 0, error: undefined as string | undefined };
      const api = new RouterosClient();
      try {
        await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 10000 });
        const filas = await api.comm(
          '/ppp/secret/getall',
          { '.proplist': '.id,name,profile,password,remote-address,local-address,comment' },
          30000,
        );
        // Los nombres se comparan sin espacios ni mayúsculas: así es como se
        // escribieron a lo largo de los años en la ficha y en el router.
        const clave = (v?: string | null) => norm(v).replace(/\s+/g, '').toLowerCase();
        const porNombre = new Map(filas.filter((f) => f.name).map((f) => [clave(f.name), f]));
        const ipsUsadas = new Set(filas.map((f) => norm(f['remote-address'])).filter(Boolean));
        /** Quién tiene cada IP: para no crear el secret de alguien que ya está con el nombre mal escrito. */
        const nombrePorIp = new Map(filas.filter((f) => norm(f['remote-address'])).map((f) => [norm(f['remote-address']), norm(f.name)]));
        // Una sola lectura de perfiles por router: la comparte cada alta.
        const perfiles = await this.perfilesDe(api);

        for (const sub of delRouter) {
          const enElRouter = porNombre.get(clave(sub.pppUsername));
          if (!enElRouter?.['.id']) {
            parte.sinSecret++; resumen.sinSecret++;
            await this.altaDelQueFalta(api, sub, router, resumen, parte, {
              crear: crearFaltantes && aplicar, ipsUsadas, nombrePorIp, perfiles,
              enLaSede: enLaSede.get(router.sedeLegacy), secrets: filas,
            });
            continue;
          }
          // Diferencias que este barrido NO toca, pero que conviene saber que existen.
          if (norm(sub.pppProfile) && norm(enElRouter.profile) && norm(sub.pppProfile) !== norm(enElRouter.profile)) resumen.perfilDistinto++;
          if (norm(sub.pppPassword) && norm(enElRouter.password) && norm(sub.pppPassword) !== norm(enElRouter.password)) resumen.claveDistinta++;

          const { set } = conciliarSecret(sub, enElRouter, []);
          const seguro: Record<string, string> = {};

          /**
           * El comentario se escribe, pero NUNCA se borra: una ficha sin comentario
           * no es una orden de vaciar el del router, es un dato que nadie capturó
           * —y ahí es donde el legacy dejó apuntada la VLAN del abonado—.
           */
          if ('comment' in set) {
            if (set.comment) { seguro.comment = set.comment; resumen.comentario++; }
            else resumen.comentarioVacio++;
          }

          /**
           * Las direcciones sólo se RELLENAN. Re-apuntar una que ya funciona es
           * justo lo que no puede hacer un barrido sin nadie mirando: la ficha
           * arrastra IPs del legacy repetidas y con "0", y la del router es la que
           * hoy tiene navegando al cliente.
           */
          const direcciones = [
            { prop: 'local-address' as const, contador: 'ipLocal' as const, omitido: 'ipLocalOmitida' as const },
            { prop: 'remote-address' as const, contador: 'ipRemota' as const, omitido: 'ipOmitida' as const },
          ];
          /**
           * Ni el router ni la ficha tienen IP local: la de su red. Sin esto, un
           * secret que nació vacío (los que creó nexus antes del 2026-09-16) seguía
           * vacío para siempre, porque aquí sólo se copiaba lo que dijera la ficha
           * — YAIRHUMBERTOMONTANAURREA en Monterrey, 2026-09-17: `nas-error`.
           */
          let ipLocalDeSuRed: string | null = null;
          if (!set['local-address'] && !norm(enElRouter['local-address']) && !esIpValida(sub.ipLocal)) {
            ipLocalDeSuRed = ipLocalDeLaRed(filas, enElRouter['remote-address'] ?? null);
            if (ipLocalDeSuRed) set['local-address'] = ipLocalDeSuRed;
          }
          for (const { prop, contador, omitido } of direcciones) {
            const nueva = set[prop];
            if (!nueva) continue;
            if (norm(enElRouter[prop])) { resumen[omitido]++; continue; }
            // Sólo la remota tiene que ser única: la local es la puerta de enlace y
            // la comparten todos los abonados que salen por el mismo lado.
            if (prop === 'remote-address' && ipsUsadas.has(nueva)) { resumen[omitido]++; continue; }
            seguro[prop] = nueva;
            resumen[contador]++;
            if (prop === 'remote-address') ipsUsadas.add(nueva);
          }

          if (Object.keys(seguro).length === 0) { parte.alDia++; resumen.alDia++; continue; }

          if (aplicar) {
            await api.comm('/ppp/secret/set', { '.id': enElRouter['.id'], ...seguro });
            if (ipLocalDeSuRed && seguro['local-address'] === ipLocalDeSuRed) {
              await this.guardarIpLocal(sub.id, ipLocalDeSuRed);
            }
            // Si acabamos de darle IP a quien no tenía, las entradas de las
            // address-list que sigan con otra dirección dejarían el corte mirando
            // a la IP equivocada.
            if (seguro['remote-address'] && sub.legacyId) {
              const comentario = `activo_${sub.legacyId}`;
              for (const lista of [ADDRESS_LIST_ACTIVE, ADDRESS_LIST_DEBTOR]) {
                const entradas = await api.comm('/ip/firewall/address-list/print', { '?list': lista, '?comment': comentario });
                for (const e of entradas) {
                  if (e['.id'] && e.address !== seguro['remote-address']) {
                    await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: seguro['remote-address'] });
                  }
                }
              }
            }
          }
          parte.corregidos++; resumen.corregidos++;
          if (resumen.muestra.length < 40) {
            resumen.muestra.push({
              abonado: sub.abonado ?? null,
              usuario: norm(sub.pppUsername),
              router: router.name,
              cambios: Object.entries(seguro).map(([k, v]) => `${k}=${v}`).join(' '),
            });
          }
        }
        api.close();
      } catch (e) {
        api.close();
        parte.error = e instanceof RouterosError ? e.message : (e as Error).message;
      }
      resumen.routers.push(parte);

      await this.prisma.mikrotikActionLog.create({
        data: {
          mikrotikId: router.id, mikrotikName: router.name, action: 'EDIT',
          ok: !parte.error, dryRun: !aplicar,
          detail: parte.error
            ? `ERROR barrido: ${parte.error}`
            : `Barrido ficha→secret: ${parte.total} abonados · ${parte.corregidos} ${aplicar ? 'corregidos' : 'por corregir'}`
              + ` · ${parte.alDia} al día · ${parte.sinSecret} sin secret · ${parte.creados} dados de alta`,
          userId: user?.id ?? null, userName: user?.name ?? 'Cron',
        },
      }).catch(() => undefined);
    }

    const fallidos = resumen.routers.filter((r) => r.error).length;
    const desglose = `${resumen.comentario} comentario(s), ${resumen.ipLocal} IP local, ${resumen.ipRemota} IP remota`;
    resumen.message = (aplicar
      ? `Barrido: ${resumen.corregidos} secret(s) puestos al día de ${resumen.total} abonados (${desglose})`
      : `Informe (sin tocar nada): ${resumen.corregidos} secret(s) quedarían al día de ${resumen.total} abonados (${desglose})`)
      + ` · ${resumen.alDia} ya ${aplicar ? 'coincidían' : 'coinciden'}`
      + `${fallidos ? ` · ${fallidos} router(es) sin responder` : ''}.`
      // El "sin secret" a secas no decía nada: se desglosa en lo que se hizo y en
      // lo que hay que arreglar a mano para que se pueda hacer.
      + ` De ${resumen.sinSecret} sin secret: ${aplicar ? `${resumen.creados} dados de alta` : `${resumen.porCrear} listos para dar de alta`}`
      + `, ${resumen.sinUsuarioReal} sin internet (usuario de relleno del legacy)`
      + `, ${resumen.perfilSinResolver} con el perfil sin resolver`
      + `, ${resumen.posibleDuplicado} que ya están con el nombre mal escrito`
      + `${resumen.ipDeFichaOcupada ? `, ${resumen.ipDeFichaOcupada} con la IP de la ficha ocupada (se repartió otra)` : ''}`
      + `${resumen.enOtroEquipoDeLaSede ? `, ${resumen.enOtroEquipoDeLaSede} que ya están en otro equipo de su sede` : ''}`
      + `${resumen.noSePudoCrear ? `, ${resumen.noSePudoCrear} rechazados por el router` : ''}.`;
    return resumen;
  }

  // ------------------------------------------------------------------
  // Lotes (corte/reconexión masivos, estilo Clientgroup)
  // ------------------------------------------------------------------
  /**
   * Corte de internet en lote.
   *
   * Antes de tocar un router pasa por el CANDADO (`corte.policy.ts`): fuera quien no
   * arrastra una sola factura vencida y quien tiene un compromiso de pago vigente. Va
   * aquí y no en quien arma la lista porque por este método entran los dos caminos de
   * la pantalla masiva —"cortar los N del filtro" y "cortar los que marqué"— y el
   * segundo no pasaba por ningún filtro. El corte individual de la ficha usa `cut()`
   * y no pasa por aquí: ahí decide una persona, caso por caso.
   */
  async cutBatch(ids: string[], user?: AuthUser, opts: { tanda?: boolean } = {}) {
    const { ids: cortables, protegidos } = await filtrarCortables(this.prisma, ids, undefined, 'INTERNET');
    if (!cortables.length) {
      // Un trozo del lote partido por la pantalla en el que todos están protegidos:
      // no es un error del lote, se contesta vacío con sus contadores.
      if (opts.tanda) {
        return { total: 0, ok: 0, results: [], ordenes: 0, protegidos, compromisosProtegidos: protegidos.compromiso };
      }
      throw new BadRequestException(
        `No se cortó a nadie: los ${ids.length} del lote están protegidos (${fraseProtegidos(protegidos)}).`,
      );
    }
    ids = cortables;
    const res = await this.batchByRouter(ids, 'CUT', user);
    // `ordenes` viaja a la pantalla: es la constancia que quedó del trabajo, y en un
    // lote donde el router falló es lo único que dice qué pasó.
    const ordenes = await this.registrarCorteDeInternet(ids, res.results, user);
    return {
      ...res,
      results: await this.conNombre(res.results),
      ordenes,
      // El parte tiene que decir a cuántos NO se les tocó y por qué: si no, quien
      // mandó cortar 300 y ve 180 cree que el lote falló.
      protegidos,
      compromisosProtegidos: protegidos.compromiso,
    };
  }
  async reconnectBatch(ids: string[], user?: AuthUser) {
    const res = await this.batchByRouter(ids, 'RECONNECT', user);
    // Y se BORRA el corte donde el lote de corte lo escribió. Sin esto el lote
    // reconectaba de verdad y la ficha seguía en rojo (ver `levantarCorteDeInternet`).
    await this.levantarCorteDeInternet(res.results, user);
    return { ...res, results: await this.conNombre(res.results) };
  }

  /**
   * Le pone número de abonado y nombre a cada resultado del lote.
   *
   * El lote trabaja con ids porque es lo que necesita el router, pero el parte que
   * lee quien mandó a cortar tiene que decir a QUIÉN se le cortó: una columna de
   * `cmr3j...` no le sirve a nadie para ir a revisar. Una sola consulta por lote.
   */
  private async conNombre<T extends { subscriberId?: string }>(
    results: T[],
  ): Promise<(T & { abonado: number | null; name: string | null })[]> {
    const ids = [...new Set(results.map((r) => r.subscriberId).filter((x): x is string => !!x))];
    // Sin ids no hay a quién buscar, pero las filas SIGUEN saliendo: devolver [] aquí
    // se comería el parte entero (p. ej. un lote que falló antes de resolver a nadie).
    if (!ids.length) return results.map((r) => ({ ...r, abonado: null, name: null }));
    const subs = await this.prisma.subscriber.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, abonado: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true,
        companyName: true, fullName: true,
      },
    });
    const por = new Map(subs.map((s) => [s.id, s]));
    return results.map((r) => {
      const s = r.subscriberId ? por.get(r.subscriberId) : undefined;
      return { ...r, abonado: s?.abonado ?? null, name: s ? subName(s) : null };
    });
  }

  /**
   * Restaura / sincroniza los secrets PPP de toda una sede contra su(s) router(s):
   * recorre los abonados con usuario PPPoE y estado activo/cortado y (re)crea su
   * secret vía provision() — crea el que falte y actualiza el existente. Es la
   * herramienta de recuperación tras formatear un router y el "sync CRM→Mikrotik".
   * Respeta el gate dry-run de provision(): sin MIKROTIK_LIVE=true solo simula.
   */
  async restoreBranch(branchId: string, opts: { statuses?: string[]; limit?: number } = {}, user?: AuthUser) {
    const statuses = (opts.statuses?.length ? opts.statuses : ['ACTIVO', 'CORTADO']) as any[];
    const limit = Math.min(2000, Math.max(1, opts.limit ?? 800));
    const subs = await this.prisma.subscriber.findMany({
      where: { branchId, status: { in: statuses }, pppUsername: { not: null } },
      select: { id: true }, take: limit,
    });
    let ok = 0, failed = 0;
    const errors: { subscriberId: string; error: string }[] = [];
    for (const s of subs) {
      try {
        const r = await this.provision(s.id, user);
        if (r.ok) ok++; else { failed++; if (errors.length < 15) errors.push({ subscriberId: s.id, error: r.error ?? r.message }); }
      } catch (e) {
        failed++;
        if (errors.length < 15) errors.push({ subscriberId: s.id, error: (e as Error).message });
      }
    }
    return {
      dryRun: !this.live, branchId, total: subs.length, ok, failed, errors: await this.conNombre(errors),
      message: !this.live
        ? `DRY-RUN: se simuló la restauración de ${subs.length} secret(s) de la sede; sin cambios reales.`
        : `Restauración de la sede: ${ok} secret(s) creados/actualizados${failed ? `, ${failed} con error` : ''}.`,
    };
  }

  /**
   * Corte/reconexión en lote agrupando por router: abre UNA sola conexión por
   * router y ejecuta todos sus clientes sobre ella (cientos de clientes sin
   * reconectar cada vez). Cada cliente se audita y marca su estado igual que la
   * acción individual. Respeta el gate dry-run.
   */
  private async batchByRouter(
    ids: string[],
    action: 'CUT' | 'RECONNECT',
    user?: AuthUser,
  ): Promise<{ total: number; ok: number; results: MikrotikActionResult[] }> {
    await this.syncLive();
    const results: MikrotikActionResult[] = [];
    const targetStatus = action === 'CUT' ? 'CORTADO' : 'ACTIVO';
    const verb = action === 'CUT' ? 'Corte' : 'Reconexión';
    const morosoMode: 'mark' | 'unmark' = action === 'CUT' ? 'mark' : 'unmark';

    // 1. Cargar abonados. Agrupar por router PRIMARIO (secret + acción completa) y,
    //    en paralelo, mapear los OTROS routers de la sede (solo lista MOROSOS).
    const groups = new Map<string, { router: Mikrotik; subs: SubForNet[] }>();
    const morosoGroups = new Map<string, { router: Mikrotik; subs: SubForNet[] }>();
    // Estado por-abonado que se va completando entre el router primario y los de sede.
    const state = new Map<string, { sub: SubForNet; primary: Mikrotik; res: MikrotikActionResult }>();

    for (const id of ids) {
      try {
        const sub = await this.loadSubscriber(id);
        if (!sub.pppUsername) {
          results.push({ ok: false, dryRun: !this.live, action, subscriberId: id, steps: [], message: 'El cliente no tiene usuario PPPoE (name_s).', error: 'sin pppUsername' });
          continue;
        }
        const router = await this.resolveRouter(sub);
        const g = groups.get(router.id) ?? { router, subs: [] };
        g.subs.push(sub);
        groups.set(router.id, g);
        for (const o of await this.sedeOtherRouters(sub, router.id)) {
          const mg = morosoGroups.get(o.id) ?? { router: o, subs: [] };
          mg.subs.push(sub);
          morosoGroups.set(o.id, mg);
        }
        state.set(sub.id, {
          sub, primary: router,
          res: { ok: false, dryRun: !this.live, action, subscriberId: sub.id, mikrotik: { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech }, steps: [], message: '' },
        });
      } catch (e) {
        results.push({ ok: false, dryRun: !this.live, action, subscriberId: id, steps: [], message: (e as Error).message, error: (e as Error).message });
      }
    }

    // 2. DRY-RUN: solo describe (router primario + morosos en los de la sede).
    if (!this.live) {
      for (const { sub, primary, res } of state.values()) {
        res.ok = true;
        res.steps.push(`DRY-RUN: ${verb.toLowerCase()} de ${sub.pppUsername} en ${primary.name} (secret + ${action === 'CUT' ? 'MOROSOS' : 'ACTIVOS'})`);
      }
      for (const { router, subs } of morosoGroups.values()) {
        for (const sub of subs) state.get(sub.id)?.res.steps.push(`DRY-RUN: [${router.name}] ${action === 'CUT' ? 'agregar a' : 'quitar de'} MOROSOS`);
      }
      for (const { sub, primary, res } of state.values()) {
        res.message = 'DRY-RUN: sin cambios reales.';
        await this.audit(action, sub, primary, res, user);
        results.push(res);
      }
      return { total: ids.length, ok: results.filter((r) => r.ok).length, results };
    }

    // 3. Router PRIMARIO por grupo: acción completa (una conexión por router).
    for (const { router, subs } of groups.values()) {
      const api = new RouterosClient();
      try {
        await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      } catch (e) {
        const msg = e instanceof RouterosError ? e.message : (e as Error).message;
        for (const sub of subs) { const st = state.get(sub.id)!; st.res.error = msg; st.res.message = `No se pudo conectar a ${router.name}`; st.res.steps.push(`✗ ${router.name}: ${msg}`); }
        await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: false } }).catch(() => undefined);
        continue;
      }
      await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: true } }).catch(() => undefined);
      for (const sub of subs) {
        const st = state.get(sub.id)!;
        const r = action === 'CUT' ? await this.cutOnApi(api, sub) : await this.reconnectOnApi(api, sub, router);
        st.res.ok = r.ok; st.res.error = r.error;
        if (action === 'RECONNECT' && r.ok) st.res.wasCut = !!(r as { wasCut?: boolean }).wasCut;
        st.res.steps.push(`[${router.name}] ${r.steps.join(' · ')}`);
        if (r.ok) { try { await this.markStatus(sub, targetStatus); } catch { /* estado BD best-effort */ } }
      }
      api.close();
    }

    // 4. OTROS routers de la sede: solo lista MOROSOS (una conexión por router).
    for (const { router, subs } of morosoGroups.values()) {
      const api = new RouterosClient();
      try {
        await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      } catch (e) {
        const msg = e instanceof RouterosError ? e.message : (e as Error).message;
        for (const sub of subs) state.get(sub.id)?.res.steps.push(`[${router.name}] ✗ no conectó: ${msg}`);
        continue;
      }
      for (const sub of subs) {
        const st = state.get(sub.id)!;
        const ip = sub.ipRemote || '';
        const mr = morosoMode === 'mark' ? await this.markMorosoOnApi(api, sub, ip) : await this.unmarkMorosoOnApi(api, sub, ip);
        st.res.steps.push(`[${router.name}] ${mr.ok ? mr.steps.join(' · ') : '✗ ' + mr.error}`);
        if (morosoMode === 'unmark' && (mr as { wasCut?: boolean }).wasCut && st.res.ok) st.res.wasCut = true;
      }
      api.close();
    }

    // 5. Finalizar: mensaje + auditoría por abonado.
    for (const { sub, primary, res } of state.values()) {
      res.message = res.ok ? `${verb} aplicado en ${primary.name}${morosoGroups.size ? ' + morosos en la sede' : ''}.` : `Fallo: ${res.error}`;
      await this.audit(action, sub, primary, res, user);
      results.push(res);
    }

    return { total: ids.length, ok: results.filter((r) => r.ok).length, results };
  }

  // ------------------------------------------------------------------
  // Historial de acciones (auditoría) de un cliente
  // ------------------------------------------------------------------
  async history(subscriberId: string, limit = 50) {
    return this.prisma.mikrotikActionLog.findMany({
      where: { subscriberId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  // ------------------------------------------------------------------
  /**
   * Deja CONSTANCIA del corte de internet: estado del servicio en la ficha + la orden
   * 'Corte Internet' ya cerrada. Es lo mismo que `registrarCorteDeTv` hace para la
   * televisión, y existe por el mismo motivo: sin esto `batchByRouter` sólo cambiaba
   * `Subscriber.status` a CORTADO y en la ficha no aparecía NI el servicio cortado ni
   * orden ninguna — el trabajo no existía para nadie.
   *
   * Dónde se anota el estado: en `SubInvoice.estadoCombo` de la factura vigente, que es
   * de donde la ficha lee "internet cortado" (ver `estadoPorServicio`). NO en
   * `SubscriberService`: ese respaldo sólo se materializó para los ACTIVO, y justo los
   * abonados que se cortan no tienen ni una fila (los 4 del caso que lo destapó tenían
   * `servicios: (ninguno)`). Se marca igualmente por si la tienen, pero la verdad está
   * en la factura.
   *
   * `serviceStatusAt` es lo que hace que el corte SOBREVIVA: sin esa marca la ida del
   * legacy devuelve el valor viejo a los 15 minutos y el corte se deshace solo.
   *
   * Sólo los que el router confirmó y no en dry-run: aquí, a diferencia de la TV, la
   * red SÍ llega (el Mikrotik alcanza a todo el parque), así que un corte que el router
   * no aceptó es un corte que no ocurrió y no hay nada que dejar dicho.
   *
   * NUNCA lanza: el corte ya está hecho en el router y es lo que espera quien llama.
   */
  private async registrarCorteDeInternet(
    ids: string[],
    results: MikrotikActionResult[],
    user?: AuthUser,
  ): Promise<number> {
    const hechos = results.filter((r) => r.ok && !r.dryRun && r.subscriberId).map((r) => r.subscriberId!);
    if (!hechos.length) return 0;
    const quien = user?.name || user?.email || null;
    try {
      // La factura VIGENTE de cada uno en una sola consulta. `DISTINCT ON` y no el
      // `distinct` de Prisma, que trae todas las filas y las descarta en memoria.
      const vigentes = await this.prisma.$queryRaw<{ id: string; subscriberId: string; serviceCombo: string | null }[]>`
        SELECT DISTINCT ON (i."subscriberId") i.id, i."subscriberId", i."serviceCombo"
          FROM "SubInvoice" i
         WHERE i."subscriberId" = ANY(${hechos}::text[])
           AND i.kind = 'RECURRENTE'
           AND i.status <> 'CANCELED'
         ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
      // Sólo donde la factura NOMBRA internet: a quien no lo tiene facturado no se le
      // inventa un internet cortado (y la ficha ni siquiera lo pintaría).
      const conInternet = vigentes.filter((f) => {
        const t = (f.serviceCombo ?? '').trim().toLowerCase();
        return !!t && t !== 'no' && t !== '-';
      });
      if (conInternet.length) {
        await this.prisma.subInvoice.updateMany({
          where: { id: { in: conInternet.map((f) => f.id) } },
          data: { estadoCombo: 'CORTADO', serviceStatusAt: new Date(), serviceStatusBy: quien },
        });
        await this.prisma.subscriberService
          .updateMany({ where: { subscriberId: { in: hechos }, kind: 'INTERNET' }, data: { status: 'CORTADO' } })
          .catch(() => undefined);
        // Al legacy en el acto. El oyente ignora el payload y dispara la barrida
        // completa, así que con emitir una vez por lote basta.
        this.events?.emit(ESTADO_SERVICIO_EVENT, {
          subscriberId: conInternet[0].subscriberId, servicio: 'INTERNET', estado: 'CORTADO',
        } satisfies EstadoServicioEvent);
      }
    } catch (e) {
      this.logger.warn(`No se pudo anotar el corte de internet en la factura: ${(e as Error).message}`);
    }

    if (!this.ordenes) return 0;
    let abiertas = 0;
    for (const id of hechos) {
      const orden = await this.ordenes
        .registrarResuelta({
          subscriberId: id,
          type: 'Corte Internet',
          subject: 'servicio',
          problem: 'Corte de internet por cartera.',
          section: ['Aplicado en el Mikrotik desde operaciones masivas.', quien ? `Lo registró ${quien}.` : null]
            .filter(Boolean).join(' '),
          autor: quien || 'Sistema',
        })
        .catch(() => null);
      if (orden) abiertas++;
    }
    this.logger.log(`Corte de internet: ${abiertas}/${hechos.length} órdenes registradas y cerradas.`);
    return abiertas;
  }

  /**
   * El ESPEJO de `registrarCorteDeInternet`: borra el corte de internet de donde la
   * ficha lo lee, después de una reconexión en lote que el router confirmó.
   *
   * Existía sólo la ida. `cutBatch` escribe el corte en DOS sitios —`estadoCombo` de la
   * factura vigente y la línea `SubscriberService` del internet— y la vuelta no borraba
   * ninguno: el lote sacaba al abonado de MOROSOS, le ponía el estado en ACTIVO… y su
   * ficha seguía diciendo "internet cortado" para siempre, porque ese chip no lo pinta
   * el estado del abonado (ver `SubscribersService.estadoPorServicio` y
   * `conEstadoDeServicio`, que le da prioridad absoluta al corte de la línea de
   * servicio). `ReconexionService` ya lo hacía por su cuenta para el camino del pago;
   * quien reconecta a mano desde operaciones masivas no tenía nada.
   *
   * Sólo lo CORTADO: una SUSPENSIÓN la pidió el cliente y no la deshace una reconexión.
   * Y el `ron` de la factura sube sólo si no queda ningún corte en pie —al que se le
   * devolvió el internet le puede seguir faltando la televisión—, mismo criterio que
   * `ReconexionService.levantarCorteDeFactura`.
   *
   * `serviceStatusAt` es lo que hace que el cambio SOBREVIVA: sin esa marca la ida del
   * sync devuelve el 'Cortado' del legacy a los quince minutos. Va por el gate de
   * RECONEXIÓN del writeback, no por el de bajas.
   *
   * NUNCA lanza: la reconexión ya está hecha en el router y es lo que espera quien llama.
   * No registra órdenes a propósito (eso sí lo hace el camino del pago, y duplicarlo
   * dejaría dos constancias del mismo trabajo).
   */
  private async levantarCorteDeInternet(results: MikrotikActionResult[], user?: AuthUser): Promise<number> {
    const hechos = results.filter((r) => r.ok && !r.dryRun && r.subscriberId).map((r) => r.subscriberId!);
    if (!hechos.length) return 0;
    const quien = user?.name || user?.email || null;
    try {
      const vigentes = await this.prisma.$queryRaw<{ id: string; subscriberId: string; estadoTv: string | null }[]>`
        SELECT DISTINCT ON (i."subscriberId") i.id, i."subscriberId", i."estadoTv"::text AS "estadoTv"
          FROM "SubInvoice" i
         WHERE i."subscriberId" = ANY(${hechos}::text[])
           AND i.kind = 'RECURRENTE'
           AND i.status <> 'CANCELED'
         ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
      const ids = vigentes.map((f) => f.id);
      let limpiadas = 0;
      if (ids.length) {
        limpiadas = (await this.prisma.subInvoice.updateMany({
          where: { id: { in: ids }, estadoCombo: 'CORTADO' },
          data: { estadoCombo: null, serviceStatusAt: new Date(), serviceStatusBy: quien },
        })).count;
        // El eje de la factura sube sólo donde ya no queda corte ninguno.
        const sinCorteDeTv = vigentes.filter((f) => f.estadoTv !== 'CORTADO').map((f) => f.id);
        if (sinCorteDeTv.length) {
          await this.prisma.subInvoice.updateMany({
            where: { id: { in: sinCorteDeTv }, ron: 'CORTADO', estadoCombo: null, estadoTv: null },
            data: { ron: 'ACTIVO' },
          });
        }
      }
      await this.prisma.subscriberService
        .updateMany({ where: { subscriberId: { in: hechos }, kind: 'INTERNET', status: 'CORTADO' }, data: { status: 'ACTIVO' } })
        .catch(() => undefined);
      if (limpiadas) {
        // Al legacy en el acto. El oyente ignora el payload y dispara la barrida
        // completa, así que con emitir una vez por lote basta.
        this.events?.emit(ESTADO_SERVICIO_EVENT, {
          subscriberId: hechos[0], servicio: 'INTERNET', estado: 'ACTIVO',
        } satisfies EstadoServicioEvent);
      }
      this.logger.log(`Reconexión de internet: corte levantado en ${limpiadas} factura(s) de ${hechos.length} abonado(s).`);
      return limpiadas;
    } catch (e) {
      this.logger.warn(`No se pudo levantar el corte de internet en la factura: ${(e as Error).message}`);
      return 0;
    }
  }

  private async markStatus(sub: SubForNet, next: 'CORTADO' | 'ACTIVO') {
    if (sub.status === next) return;
    // Reconectar a alguien con acuerdo de pago le devuelve el servicio, no le borra el
    // acuerdo: su estado se queda como está (ver `estado-al-reconectar.ts`). El corte sí
    // manda sobre cualquier estado — dejar de pagar el acuerdo es exactamente el caso.
    if (next === 'ACTIVO' && conservaEstadoAlReconectar(sub.status)) return;
    await this.prisma.subscriber.update({
      where: { id: sub.id },
      data: {
        previousStatus: (sub.status as any) ?? undefined,
        status: next as any,
        statusChangedAt: new Date(),
      },
    }).catch((e) => this.logger.warn(`No se pudo actualizar estado del cliente: ${e.message}`));
  }
}
