/**
 * ¿A qué clientes podemos entrar de verdad por su IP remota, y a cuáles no?
 *
 * Sistemas necesita llegar al equipo del abonado para mirar una señal, cambiar un
 * WiFi o descartar que el problema es del CPE. La ficha dice que todos tienen una
 * IP remota; la realidad es otra. Este barrido la mide, cliente por cliente, y deja
 * el listado de a quién SÍ se puede entrar hoy y por qué a los demás no.
 *
 *   npm run red:acceso                        → ACTIVO + COMPROMISO, ping
 *   npm run red:acceso -- --navegando         → todos los que tienen sesión ahora
 *   npm run red:acceso -- --http              → además prueba la web del equipo (80)
 *   npm run red:acceso -- --router=Yopal --muestra=200
 *   npm run red:acceso -- --estados=ACTIVO,COMPROMISO,CARTERA --csv=/tmp/acceso.csv
 *   npm run red:acceso -- --sede=Yopal --limite=500 --conexiones=8 --sin-csv
 *   npm run red:acceso -- --desde=Yopal,Ip_Villanueva_GPON   → lo que ve quien entra por esa VPN
 *
 * Sin `--csv` el detalle queda en `backend/salida/acceso-remoto-<fecha>.csv` (una
 * fila por cliente, para abrir en Excel y repartir el trabajo).
 *
 * CÓMO SE MIDE, y por qué así:
 *
 *  · El ping NO sale de este servidor. Las IPs de los abonados son privadas de la
 *    red PPPoE del ISP (10.x) y aquí no hay ruta hacia ellas: probado, ninguna
 *    responde. Quien sí las alcanza es el Mikrotik que las reparte, así que el
 *    barrido se hace DESDE cada router por la API (`/ping`), que es exactamente la
 *    ruta que usa sistemas cuando entra a un equipo.
 *  · Antes de pingear se lee `/ppp/active` una vez por router. Eso da tres cosas
 *    gratis: quién está navegando ahora mismo, con QUÉ IP está navegando (que no
 *    siempre es la de la ficha) y si la IP que tenemos guardada la está usando otro.
 *    Un "no responde" sin ese contexto no dice nada: no es lo mismo un equipo
 *    apagado que una ficha con la IP de un vecino.
 *  · A quien no tiene sesión no se le pinguea. No es ahorro de tiempo solamente: su
 *    IP no está asignada a nadie, y si respondiera sería porque la heredó otro
 *    cliente — un "sí tenemos acceso" que es mentira. Se marca NO_NAVEGA y, si la
 *    dirección aparece en la sesión de otro abonado, se dice de quién es.
 *  · `--http` es el segundo escalón: responder al ping es estar vivo, no es poder
 *    entrar. La prueba de verdad es que abra la web de administración, y eso se
 *    mira con `/tool/fetch` (HEAD, sin descargar nada). Se prueba a TODOS los que
 *    navegan, también a los que no contestan el ping (hay CPEs con el ICMP
 *    cerrado y la web abierta). Cuesta caro cuando el puerto está filtrado —el
 *    router espera 10 s— y por eso `--http` es opcional.
 *
 *  · "Responde desde su router" NO es "se entra": las sedes reparten rangos que se
 *    pisan (10.100.x está en cinco routers, 80.0.x en cuatro) y no hay rutas entre
 *    ellas. La misma IP puede ser el equipo de dos clientes, y cuál abre depende
 *    del router al que esté conectado el técnico: conectado a la VPN equivocada, la
 *    página no carga (sin ruta) o abre el equipo de OTRO cliente. Por eso se lee
 *    `/ppp/active` de TODOS los routers y cada fila dice por qué VPN se entra y si
 *    su IP está viva también en otra sede.
 *  · `--desde=<router>` mide lo que ve un técnico cuya VPN (o su oficina) cae en ese
 *    router. Probado: los CPE le contestan igual a una dirección de fuera de la red
 *    de clientes (el túnel L2TP, otra LAN del router) que al router mismo, así que
 *    preguntar DESDE el router de la VPN es preguntar desde el PC del técnico. Cada
 *    cliente queda SI / OTRO_EQUIPO (esa IP la tiene otro abonado en ese router) /
 *    SIN_RUTA (el router no sabe llegar: la página no carga).
 *
 * SÓLO LECTURA: ping y HEAD. No escribe nada en los routers ni en la base. Aun así
 * respeta `MIKROTIK_LIVE` como el resto del módulo: con el gate cerrado no abre
 * socket contra ningún equipo de producción.
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { RouterosClient, RouterosError } from '../src/network/routeros/routeros-client';
import { decryptSecret } from '../src/common/secret-box';
import { MikrotikService } from '../src/network/mikrotik.service';
import { IpAllocatorService } from '../src/network/ip-allocator.service';
import { esIpRemotaUtil } from '../src/support/ip-remota.policy';
import { esUsuarioPppUtil } from '../src/subscribers/conexion-alta';

// ---------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const tiene = (n: string) => args.includes(`--${n}`);
const num = (n: string, def: number) => (flag(n) ? Number(flag(n)) : def);

const ESTADOS_DEF = ['ACTIVO', 'COMPROMISO'];
const opciones = {
  estados: (flag('estados') ?? ESTADOS_DEF.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  /** Universo = quien tenga sesión PPP ahora, sin mirar el estado de la ficha. */
  navegando: tiene('navegando'),
  todos: tiene('todos'),
  sede: flag('sede'),
  router: flag('router'),
  http: tiene('http'),
  puertos: (flag('puertos') ?? '80').split(',').map((p) => Number(p.trim())).filter((p) => p > 0),
  conexiones: Math.max(1, num('conexiones', 6)),
  count: Math.max(1, num('count', 1)),
  limite: flag('limite') ? num('limite', 0) : 0,
  muestra: flag('muestra') ? num('muestra', 0) : 0,
  csv: flag('csv'),
  sinCsv: tiene('sin-csv'),
  /** Routers donde cae la VPN (u oficina) del técnico: se mide lo que se ve desde ahí. */
  desde: (flag('desde') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

// ------------------------------------------------------------------- tipos
type Fila = {
  abonado: number | null;
  legacyId: number | null;
  nombre: string;
  estado: string;
  sede: string;
  router: string;
  usuario: string;
  ipFicha: string;
  ipSesion: string;
  navegando: boolean;
  mac: string;
  uptime: string;
  ipProbada: string;
  responde: boolean;
  latenciaMs: number | null;
  web: string;
  acceso: 'SI' | 'SI_OTRA_IP' | 'NO';
  motivo: string;
  detalle: string;
  /** A qué VPN hay que estar conectado para llegarle: la de SU router. */
  entrarPor: string;
  /** Otros routers donde esa misma IP es ahora el equipo de otro abonado. */
  ipTambienEn: string;
  /** Veredicto visto desde cada router de `--desde`. */
  desde: Record<string, string>;
};

/** Lo que dice `/ppp/active` de un equipo (dos filas de `mikrotik` pueden ser el mismo). */
type Censo = {
  nombres: string[];
  porUsuario: Map<string, Record<string, string>>;
  porIp: Map<string, Record<string, string>>;
  sesiones: number;
  error?: string;
  /** Rutas que no son de clientes ni la de salida a internet (sólo para `--desde`). */
  rutas?: string[];
};

/** Dos filas de `mikrotik` con la misma IP:puerto son el mismo equipo (Villanueva EOC/EPON). */
const equipoDe = (r: { ip: string; port: string }) => `${r.ip}:${r.port}`;

function aNumero(ip: string): number | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function enPrefijo(ip: string, cidr: string): boolean {
  const [red, bits] = cidr.split('/');
  const n = Number(bits ?? 32);
  const a = aNumero(ip);
  const b = aNumero(red);
  if (a == null || b == null || !(n >= 0 && n <= 32)) return false;
  const mascara = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mascara) >>> 0) === ((b & mascara) >>> 0);
}

type SubBarrido = {
  id: string;
  abonado: number | null;
  legacyId: number | null;
  nombre: string;
  estado: string;
  sede: string;
  usuario: string;
  ipFicha: string;
};

/** `1s200ms15us` → milisegundos. RouterOS mezcla unidades en el mismo campo. */
function msDe(t?: string): number | null {
  if (!t) return null;
  let ms = 0;
  let hubo = false;
  for (const [, v, u] of t.matchAll(/(\d+(?:\.\d+)?)(us|ms|s|m)/g)) {
    hubo = true;
    const n = Number(v);
    ms += u === 'us' ? n / 1000 : u === 'ms' ? n : u === 's' ? n * 1000 : n * 60000;
  }
  return hubo ? Math.round(ms * 100) / 100 : null;
}

const normalizar = (s?: string | null) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** El `fullName` es cache y viene vacío en buena parte del padrón importado. */
function nombreDe(s: { fullName?: string | null; firstName?: string | null; secondName?: string | null; lastName1?: string | null; lastName2?: string | null; companyName?: string | null }): string {
  if (s.fullName?.trim()) return s.fullName.trim();
  const persona = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  return persona || (s.companyName ?? '').trim();
}

/** Un ping desde el router. `ok` = al menos un paquete de vuelta. */
async function pingear(api: RouterosClient, ip: string, count: number) {
  const filas = await api.comm('/ping', { address: ip, count: String(count) }, 4000 + count * 1500);
  const ok = filas.some((f) => Number(f['received'] ?? 0) > 0);
  const conTiempo = [...filas].reverse().find((f) => f['time']);
  return { ok, ms: ok ? msDe(conTiempo?.['time']) : null };
}

/**
 * ¿Abre la administración del equipo? HEAD sin guardar nada: interesa el código
 * HTTP, no el contenido. Un 401 cuenta como acceso (hay web, pide clave).
 */
async function web(api: RouterosClient, ip: string, puerto: number) {
  const https = puerto === 443;
  const url = `${https ? 'https' : 'http'}://${ip}${puerto === 80 || puerto === 443 ? '' : `:${puerto}`}/`;
  const params: Record<string, string> = { url, 'http-method': 'head', 'keep-result': 'no' };
  if (https) params['check-certificate'] = 'no';
  // 25 s > los ~10 s que espera el propio router: que el veredicto lo dé él y no
  // un timeout nuestro, que además dejaría la conexión inservible.
  const filas = await api.comm('/tool/fetch', params, 25000);
  return filas.find((f) => f['code'])?.['code'] ?? '';
}

/** Abre una conexión API al router (los workers la rehacen si se les cae). */
async function conectar(r: { ip: string; port: string; username: string; password: string }) {
  const api = new RouterosClient();
  await api.connect(r.ip, Number(r.port), r.username, decryptSecret(r.password), { timeoutMs: 8000 });
  return api;
}

async function main() {
  const prisma = new PrismaClient();
  const live = process.env.MIKROTIK_LIVE === 'true';
  const mikrotik = new MikrotikService(prisma as any, {} as any, new IpAllocatorService(prisma as any));

  const routers = await prisma.mikrotik.findMany();
  const elegidos = opciones.router
    ? routers.filter((r) => r.id === opciones.router || normalizar(r.name) === normalizar(opciones.router))
    : routers;
  if (opciones.router && !elegidos.length) {
    console.error(`No hay router que se llame "${opciones.router}". Hay: ${routers.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  const routersDesde = opciones.desde.map((d) => routers.find((r) => r.id === d || normalizar(r.name) === normalizar(d)));
  if (routersDesde.some((r) => !r)) {
    console.error(`--desde: no reconozco "${opciones.desde.filter((_, i) => !routersDesde[i]).join(', ')}". Hay: ${routers.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }

  // ------------------------------------------------------- padrón a barrer
  const where: any = { pppUsername: { not: null } };
  if (!opciones.todos && !opciones.navegando) where.status = { in: opciones.estados as any };
  if (opciones.router) where.branch = { legacyId: { in: [...new Set(elegidos.map((r) => r.sedeLegacy))] } };
  if (opciones.sede) {
    where.branch = Number.isFinite(Number(opciones.sede))
      ? { legacyId: Number(opciones.sede) }
      : { name: { contains: opciones.sede, mode: 'insensitive' } };
  }
  const padronCompleto = await prisma.subscriber.findMany({
    where,
    select: {
      id: true, abonado: true, legacyId: true, status: true,
      fullName: true, firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
      pppUsername: true, ipRemote: true, installTech: true,
      branch: { select: { legacyId: true, name: true } },
    },
    orderBy: { abonado: 'asc' },
  });
  // `--muestra` reparte el sorteo por todo el padrón (no los primeros N, que serían
  // los abonados más viejos y todos de la misma sede).
  const padron = opciones.muestra
    ? [...padronCompleto].sort(() => Math.random() - 0.5).slice(0, opciones.muestra)
    : opciones.limite ? padronCompleto.slice(0, opciones.limite) : padronCompleto;

  // Agrupar por el router que le toca a cada uno: la misma regla del corte
  // (`MikrotikService.elegirRouter`), no una copia que se desincronice.
  const porRouter = new Map<string, { router: (typeof routers)[number]; subs: SubBarrido[] }>();
  const sinRouter: SubBarrido[] = [];
  const sinInternet: SubBarrido[] = [];
  for (const s of padron) {
    const fila: SubBarrido = {
      id: s.id,
      abonado: s.abonado ?? null,
      legacyId: s.legacyId ?? null,
      nombre: nombreDe(s),
      estado: s.status ?? '',
      sede: s.branch?.name ?? '',
      usuario: (s.pppUsername ?? '').trim(),
      ipFicha: esIpRemotaUtil(s.ipRemote) ? String(s.ipRemote).trim() : '',
    };
    // El `name_s` del legacy trae '0' o '-' cuando el abonado es sólo televisión:
    // ésos no tienen equipo al que entrar, y contarlos como "sin acceso" ensucia
    // el número que importa.
    if (!esUsuarioPppUtil(s.pppUsername)) { sinInternet.push(fila); continue; }
    const deLaSede = elegidos.filter((r) => r.sedeLegacy === s.branch?.legacyId);
    const router = s.branch ? mikrotik.elegirRouter(s.installTech ?? null, deLaSede as any) : undefined;
    if (!router) { if (!opciones.router) sinRouter.push(fila); continue; }
    const g = porRouter.get(router.id) ?? { router, subs: [] };
    g.subs.push(fila);
    porRouter.set(router.id, g);
  }

  console.log(`\nAcceso remoto a los equipos de los clientes — ${new Date().toLocaleString('es-CO')}`);
  console.log(opciones.navegando
    ? 'Universo: todos los que tienen sesión PPPoE ahora mismo.'
    : `Universo: fichas en estado ${opciones.todos ? 'CUALQUIERA' : opciones.estados.join(' / ')} con internet.`);
  console.log(`Padrón: ${padron.length} abonados · ${sinInternet.length} sólo TV (sin equipo que probar) · ${sinRouter.length} sin router resuelto`);
  console.log(`Prueba: ping desde el router (count=${opciones.count})${opciones.http ? ` + web en ${opciones.puertos.join(', ')}` : ''} · ${opciones.conexiones} conexiones por equipo · SÓLO LECTURA`);

  if (!live) {
    console.log('\nMIKROTIK_LIVE=false: no se consulta ningún router (mismo gate que el resto del módulo).');
    console.log('Actívelo para medir de verdad; este barrido no escribe nada, sólo pregunta.\n');
    await prisma.$disconnect();
    return;
  }

  // ------------------------------------------ censo de sesiones de TODOS los routers
  // No sólo de los que se van a barrer: para saber si la IP de un cliente es, en otra
  // sede, el equipo de otro abonado hay que mirar todas (ver cabecera).
  const censo = new Map<string, Censo>();
  const clavesDesde = new Set((routersDesde as (typeof routers)[number][]).map(equipoDe));
  for (const r of routers) {
    const k = equipoDe(r);
    const ya = censo.get(k);
    if (ya) { ya.nombres.push(r.name); continue; }
    const c: Censo = { nombres: [r.name], porUsuario: new Map(), porIp: new Map(), sesiones: 0 };
    censo.set(k, c);
    try {
      const api = await conectar(r);
      try {
        const activos = await api.comm('/ppp/active/getall', {}, 30000);
        c.sesiones = activos.length;
        for (const a of activos) {
          c.porUsuario.set(normalizar(a['name']), a);
          if (a['address']) c.porIp.set(a['address'], a);
        }
        if (clavesDesde.has(k)) {
          // Las /32 de clientes ya están en `porIp`; la 0.0.0.0/0 sale a internet,
          // donde una 10.x no llega a ninguna parte.
          c.rutas = (await api.comm('/ip/route/print', {}, 60000))
            .filter((x) => x['disabled'] !== 'true' && x['dst-address'] && x['dst-address'] !== '0.0.0.0/0'
              && !String(x['gateway'] ?? '').startsWith('<pppoe'))
            .map((x) => x['dst-address']);
        }
      } finally {
        api.close();
      }
    } catch (e) {
      c.error = e instanceof RouterosError ? e.message : (e as Error).message;
    }
  }
  console.log(`Sesiones PPPoE vivas: ${[...censo.values()].map((c) => `${c.nombres.join('/')} ${c.error ? 'NO RESPONDE' : c.sesiones}`).join(' · ')}`);

  // --------------------------------------------------------- barrido por router
  const filas: Fila[] = [];
  const resumenRouters: any[] = [];

  for (const { router, subs } of porRouter.values()) {
    const t0 = Date.now();
    const desde = filas.length;
    const info = `${router.name} (${router.ip}:${router.port})`;
    const c = censo.get(equipoDe(router))!;
    if (c.error) {
      console.log(`\n✗ ${info}: no responde la API — ${c.error}. Sus ${subs.length} abonados quedan sin medir.`);
      for (const s of subs) filas.push(sinProbar(s, router.name, 'ROUTER_CAIDO', c.error));
      resumenRouters.push({ router: router.name, abonados: subs.length, navegando: 0, acceso: 0, pct: '—', seg: 0 });
      continue;
    }

    // Sesiones vivas: quién navega, con qué IP y desde qué equipo.
    const { porUsuario, porIp } = c;
    const activos = [...porUsuario.values()];

    // Sesiones que navegan y no cruzan con ninguna ficha del padrón: si el barrido
    // es completo, son secrets del router sin abonado detrás (equipos del ISP,
    // pruebas, gente retirada que quedó habilitada).
    const conocidos = new Set(subs.map((x) => normalizar(x.usuario)));
    const huerfanas = activos.filter((a) => !conocidos.has(normalizar(a['name']))).length;

    // Qué probar de cada uno (sin tocar la red todavía).
    type Tarea = { s: SubBarrido; ip: string; ses?: Record<string, string>; fila: Fila; reintentado?: boolean };
    const tareas: Tarea[] = [];
    for (const s of subs) {
      const ses = porUsuario.get(normalizar(s.usuario));
      const ipSesion = ses?.['address'] ?? '';
      const base = (f: Partial<Fila>): Fila => ({
        abonado: s.abonado, legacyId: s.legacyId, nombre: s.nombre, estado: s.estado, sede: s.sede,
        router: router.name, usuario: s.usuario, ipFicha: s.ipFicha, ipSesion, navegando: !!ses,
        mac: ses?.['caller-id'] ?? '', uptime: ses?.['uptime'] ?? '', ipProbada: '', responde: false,
        latenciaMs: null, web: '', acceso: 'NO', motivo: '', detalle: '', entrarPor: '', ipTambienEn: '', desde: {}, ...f,
      });
      if (opciones.navegando && !ses) continue;
      if (!ses) {
        // No navega: no se pinguea (ver cabecera). Pero si su IP la está usando
        // otro AHORA, eso es lo que hay que contar, no un "apagado" cualquiera.
        const ladron = s.ipFicha ? porIp.get(s.ipFicha) : undefined;
        filas.push(base({
          motivo: s.ipFicha ? 'NO_NAVEGA' : 'SIN_IP_FICHA',
          detalle: ladron ? `la IP de la ficha la está usando ${ladron['name']}` : 'sin sesión PPPoE (equipo apagado o cortado)',
        }));
        continue;
      }
      const ip = s.ipFicha || ipSesion;
      if (!ip) { filas.push(base({ motivo: 'SIN_IP', detalle: 'navega sin dirección visible' })); continue; }
      tareas.push({ s, ip, ses, fila: base({ ipProbada: ip }) });
    }

    // Cola de pings: varias conexiones API a la vez contra el mismo router.
    let i = 0;
    const trabajador = async () => {
      let api: RouterosClient | undefined;
      const dame = async (): Promise<RouterosClient> => {
        if (api && api.isConnected) return api;
        api = await conectar(router);
        return api;
      };
      while (true) {
        const t = tareas[i++];
        if (!t) break;
        try {
          const a = await dame();
          let r = await pingear(a, t.ip, opciones.count);
          // Un paquete perdido no es un equipo caído: al que falla se le insiste
          // una vez con más paquetes antes de darlo por inalcanzable.
          if (!r.ok) r = await pingear(await dame(), t.ip, Math.max(3, opciones.count));
          t.fila.responde = r.ok;
          t.fila.latenciaMs = r.ms;
          // La web se prueba TAMBIÉN a quien no contesta el ping: hay CPEs con el
          // ICMP cerrado y la administración abierta, y a ésos sí se entra. Cuesta
          // ~10 s cada puerto muerto, por eso `--http` es opcional.
          if (opciones.http) {
            let falloNuestro = '';
            for (const p of opciones.puertos) {
              try {
                const code = await web(await dame(), t.ip, p);
                if (code) { t.fila.web = `${p}:${code}`; break; }
              } catch (e) {
                const msg = e instanceof RouterosError ? e.message : (e as Error).message;
                // `failure: ...` es el veredicto del router SOBRE EL EQUIPO (puerto
                // cerrado, filtrado, sin ruta): eso es un puerto que no abre. Lo que
                // no empieza así es un tropiezo de nuestra sesión de API, y decir por
                // eso que el cliente no tiene web sería mentir en el informe.
                if (!/^failure:/i.test(msg)) falloNuestro = msg;
              }
            }
            if (!t.fila.web) {
              t.fila.web = falloNuestro ? 'no probada' : 'cerrada';
              if (falloNuestro) t.fila.detalle = `no se pudo probar la web: ${falloNuestro}`;
            }
          }
          const abreWeb = !!t.fila.web && t.fila.web !== 'cerrada' && t.fila.web !== 'no probada';
          if (r.ok || abreWeb) {
            const mismaIp = !t.s.ipFicha || t.s.ipFicha === t.fila.ipSesion;
            t.fila.acceso = mismaIp ? 'SI' : 'SI_OTRA_IP';
            t.fila.motivo = mismaIp ? (r.ok ? 'OK' : 'SOLO_WEB') : 'IP_FICHA_DESACTUALIZADA';
            if (!mismaIp) t.fila.detalle = `la ficha dice ${t.s.ipFicha} y navega por ${t.fila.ipSesion}`;
            else if (!r.ok) t.fila.detalle = 'no contesta el ping pero abre la administración web';
          } else {
            t.fila.motivo = 'NO_RESPONDE';
            t.fila.detalle = opciones.http
              ? 'navega, no contesta el ping y no abre la web: no hay por dónde entrar'
              : 'navega pero el equipo no contesta el ping (firewall del CPE o equipo del cliente en bridge)';
          }
        } catch (e) {
          const msg = e instanceof RouterosError ? e.message : (e as Error).message;
          // Un router con 1.400 sesiones a veces tarda en aceptar otra sesión de API.
          // Eso no es un cliente inalcanzable: se le da una segunda oportunidad antes
          // de contarlo como "no se pudo medir".
          if (!t.reintentado && /timeout|conect|socket|ECONN/i.test(msg)) {
            t.reintentado = true;
            tareas.push(t);
            continue;
          }
          t.fila.motivo = 'ERROR_ROUTER';
          t.fila.detalle = msg;
        }
        filas.push(t.fila);
        const hechas = filas.length;
        if (hechas % 250 === 0) process.stdout.write(`  … ${hechas} probados\r`);
      }
      (api as RouterosClient | undefined)?.close();
    };
    console.log(`\n▸ ${info}: ${subs.length} abonados, ${activos.length} sesiones activas`
      + `${huerfanas ? ` (${huerfanas} sin ficha en el padrón barrido)` : ''}, ${tareas.length} por probar…`);
    await Promise.all(Array.from({ length: Math.min(opciones.conexiones, Math.max(1, tareas.length)) }, trabajador));

    const delRouter = filas.slice(desde);
    const con = delRouter.filter((f) => f.acceso !== 'NO').length;
    resumenRouters.push({
      router: router.name,
      abonados: delRouter.length,
      navegando: delRouter.filter((f) => f.navegando).length,
      acceso: con,
      pct: delRouter.length ? `${Math.round((con * 100) / delRouter.length)}%` : '—',
      seg: Math.round((Date.now() - t0) / 1000),
    });
    console.log(`  ${con} de ${delRouter.length} accesibles en ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  for (const s of sinRouter) filas.push(sinProbar(s, '', 'SIN_ROUTER', 'la sede del cliente no tiene Mikrotik configurado'));

  // ------------------------- por dónde se entra y si la IP es de otro en otra sede
  const routerPorNombre = new Map(routers.map((r) => [r.name, r]));
  const ipDe = (f: Fila) => f.ipProbada || f.ipSesion || f.ipFicha;
  for (const f of filas) {
    const propio = routerPorNombre.get(f.router);
    const kPropio = propio ? equipoDe(propio) : '';
    if (propio) f.entrarPor = `VPN a ${censo.get(kPropio)!.nombres.join('/')} (${propio.ip})`;
    const ip = ipDe(f);
    if (!ip) continue;
    const otros: string[] = [];
    for (const [k, c] of censo) {
      if (k === kPropio) continue;
      const s = c.porIp.get(ip);
      if (s && normalizar(s['name']) !== normalizar(f.usuario)) otros.push(`${c.nombres.join('/')} (${s['name']})`);
    }
    f.ipTambienEn = otros.join(', ');
  }

  // ------------------------------------ lo que ve el técnico desde su VPN (--desde)
  for (const d of routersDesde as (typeof routers)[number][]) {
    const k = equipoDe(d);
    const c = censo.get(k)!;
    const porProbar: Fila[] = [];
    for (const f of filas) {
      const ip = f.ipProbada || f.ipSesion;
      const propio = routerPorNombre.get(f.router);
      const ses = c.porIp.get(ip);
      let v: string;
      if (!ip) v = '';
      else if (c.error) v = 'NO_MEDIDO';
      else if (propio && equipoDe(propio) === k) v = f.acceso !== 'NO' ? 'SI' : 'NO';
      else if (ses && normalizar(ses['name']) === normalizar(f.usuario)) v = 'SI';
      else if (ses) v = `OTRO_EQUIPO (${ses['name']})`;
      else if (c.rutas!.some((r) => enPrefijo(ip, r))) { v = 'NO'; porProbar.push(f); }
      else v = 'SIN_RUTA';
      f.desde[d.name] = v;
    }
    // Hay rutas hacia otras redes (túneles, /32 sueltas por una VPN): a ésas no se
    // les supone nada, se les pregunta.
    if (porProbar.length && !c.error) {
      const api = await conectar(d);
      try {
        for (const f of porProbar) {
          const r = await pingear(api, f.ipProbada || f.ipSesion, 2).catch(() => ({ ok: false }));
          if (r.ok) f.desde[d.name] = 'RESPONDE_POR_RUTA';
        }
      } finally {
        api.close();
      }
    }
  }

  // ------------------------------------------------------------------ informe
  const total = filas.length;
  const conAcceso = filas.filter((f) => f.acceso !== 'NO');
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ACCESO REMOTO: ${conAcceso.length} de ${total} (${total ? Math.round((conAcceso.length * 100) / total) : 0}%)`);
  console.log('='.repeat(70));
  console.table(resumenRouters);

  const motivos = new Map<string, number>();
  for (const f of filas) motivos.set(f.motivo || '—', (motivos.get(f.motivo || '—') ?? 0) + 1);
  console.log('\nPor qué:');
  console.table([...motivos.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([motivo, n]) => ({ motivo, abonados: n, pct: `${Math.round((n * 100) / (total || 1))}%`, quiere_decir: EXPLICA[motivo] ?? '' })));

  if (opciones.http) {
    const probados = filas.filter((f) => f.web && f.web !== 'no probada').length;
    const conWeb = filas.filter((f) => f.web && f.web !== 'cerrada' && f.web !== 'no probada').length;
    console.log(`\nAdministración web abierta: ${conWeb} de ${probados} equipos navegando`
      + ` (${probados ? Math.round((conWeb * 100) / probados) : 0}%). Ésos son a los que se entra de verdad,`
      + ' no sólo se les hace ping.');
    const noProbada = filas.filter((f) => f.web === 'no probada').length;
    if (noProbada) console.log(`(${noProbada} quedaron sin prueba de web por un tropiezo de la sesión de API, no del equipo.)`);
  }

  const porSede = new Map<string, { total: number; ok: number }>();
  for (const f of filas) {
    const s = porSede.get(f.sede || '—') ?? { total: 0, ok: 0 };
    s.total++; if (f.acceso !== 'NO') s.ok++;
    porSede.set(f.sede || '—', s);
  }
  console.log('\nPor sede:');
  console.table([...porSede.entries()].sort((a, b) => b[1].total - a[1].total)
    .map(([sede, s]) => ({ sede, abonados: s.total, conAcceso: s.ok, pct: `${Math.round((s.ok * 100) / (s.total || 1))}%` })));

  const desfase = filas.filter((f) => f.motivo === 'IP_FICHA_DESACTUALIZADA');
  const robadas = filas.filter((f) => f.detalle.startsWith('la IP de la ficha la está usando'));
  if (desfase.length) console.log(`\n⚠ ${desfase.length} navegan por una IP distinta a la de su ficha: entrar por la registrada da con otro equipo.`);
  if (robadas.length) console.log(`⚠ ${robadas.length} tienen en la ficha una IP que ahora mismo usa otro abonado.`);
  if (desfase.length || robadas.length) {
    console.log(`  ${desfase.length && robadas.length ? 'Ambas cosas las arregla' : 'Eso lo arregla'}`
      + ' `npm run secrets:conciliar -- --aplicar` (pone router y ficha de acuerdo).');
  }

  const repetidas = conAcceso.filter((f) => f.ipTambienEn);
  if (repetidas.length) {
    console.log(`\n⚠ ${repetidas.length} de los que tienen acceso comparten su IP con el equipo de OTRO cliente en otra sede.`
      + '\n  Entrar por esa IP conectado a la VPN equivocada abre el equipo del otro. Columna `entrar_por` del CSV.');
    const pares = new Map<string, number>();
    for (const f of repetidas) for (const o of f.ipTambienEn.split(', ')) {
      const k = [f.router, o.replace(/ \(.*\)$/, '')].sort().join(' ↔ ');
      pares.set(k, (pares.get(k) ?? 0) + 1);
    }
    console.table([...pares.entries()].sort((a, b) => b[1] - a[1]).map(([sedes, n]) => ({ sedes, ips_repetidas: n })));
  }

  for (const d of routersDesde as (typeof routers)[number][]) {
    const cuenta = new Map<string, Map<string, number>>();
    for (const f of filas) {
      const v = (f.desde[d.name] ?? '').replace(/ \(.*\)$/, '');
      if (!v) continue;
      const porRouter = cuenta.get(f.router || '—') ?? new Map<string, number>();
      porRouter.set(v, (porRouter.get(v) ?? 0) + 1);
      cuenta.set(f.router || '—', porRouter);
    }
    const cols = ['SI', 'NO', 'OTRO_EQUIPO', 'SIN_RUTA', 'RESPONDE_POR_RUTA', 'NO_MEDIDO'];
    console.log(`\nConectado a la VPN de ${d.name} (${d.ip}), por la IP del cliente:`);
    console.table([...cuenta.entries()].map(([router, m]) => Object.fromEntries([['router_del_cliente', router],
      ...cols.filter((col) => [...cuenta.values()].some((x) => x.get(col))).map((col) => [col, m.get(col) ?? 0])])));
    console.log('  SI = abre su equipo · OTRO_EQUIPO = abre el de otro abonado · SIN_RUTA = la página no carga');
  }

  // --------------------------------------------------------------------- CSV
  if (!opciones.sinCsv) {
    const ruta = opciones.csv ?? `salida/acceso-remoto-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
    const cab = ['abonado', 'legacyId', 'nombre', 'estado', 'sede', 'router', 'usuario_ppp', 'ip_ficha', 'ip_sesion',
      'navegando', 'mac_equipo', 'uptime', 'ip_probada', 'responde', 'latencia_ms', 'web', 'acceso', 'motivo', 'detalle',
      'entrar_por', 'ip_tambien_en', ...routersDesde.map((d) => `desde_${d!.name}`)];
    const linea = (f: Fila) => [f.abonado ?? '', f.legacyId ?? '', f.nombre, f.estado, f.sede, f.router, f.usuario,
      f.ipFicha, f.ipSesion, f.navegando ? 'si' : 'no', f.mac, f.uptime, f.ipProbada, f.responde ? 'si' : 'no',
      f.latenciaMs ?? '', f.web, f.acceso, f.motivo, f.detalle, f.entrarPor, f.ipTambienEn,
      ...routersDesde.map((d) => f.desde[d!.name] ?? '')]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';');
    mkdirSync(dirname(ruta), { recursive: true });
    // BOM: sin él Excel en español abre las tildes como basura.
    writeFileSync(ruta, '﻿' + [cab.join(';'), ...filas.map(linea)].join('\n'), 'utf8');
    console.log(`\nDetalle cliente por cliente: ${ruta} (${filas.length} filas)`);
  }

  await prisma.$disconnect();
}

/** Fila de los que ni se llegaron a probar (sin router, o router que no respondió). */
function sinProbar(s: SubBarrido, router: string, motivo: string, detalle: string): Fila {
  return {
    abonado: s.abonado, legacyId: s.legacyId, nombre: s.nombre, estado: s.estado, sede: s.sede, router,
    usuario: s.usuario, ipFicha: s.ipFicha, ipSesion: '', navegando: false, mac: '', uptime: '', ipProbada: '',
    responde: false, latenciaMs: null, web: '', acceso: 'NO', motivo, detalle, entrarPor: '', ipTambienEn: '', desde: {},
  };
}

const EXPLICA: Record<string, string> = {
  OK: 'se entra por la IP que dice la ficha',
  SOLO_WEB: 'no contesta el ping pero abre la administración web',
  IP_FICHA_DESACTUALIZADA: 'se entra, pero por otra IP: la ficha está vieja',
  NO_NAVEGA: 'sin sesión: equipo apagado, cortado o retirado',
  NO_RESPONDE: 'navega y no contesta: CPE con ICMP cerrado o en bridge',
  SIN_IP_FICHA: 'la ficha no tiene IP remota utilizable',
  SIN_IP: 'navega sin dirección visible en el router',
  SIN_ROUTER: 'la sede del cliente no tiene Mikrotik configurado',
  ROUTER_CAIDO: 'el Mikrotik no respondió: no se pudo medir',
  ERROR_ROUTER: 'el router falló durante la prueba',
};

main().catch((e) => { console.error(e); process.exit(1); });
