import { Logger } from '../core/logger';
import { Mikrotik } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RouterosClient } from './routeros/routeros-client';
import { decryptSecret } from '../common/secret-box';

/**
 * Reparte la IP fija de un abonado nuevo.
 *
 * POR QUÉ IP FIJA Y NO UN POOL DEL ROUTER. El corte no deshabilita el secret:
 * mete la IP del cliente en la address-list MOROSOS y una regla de firewall la
 * bloquea (ver `MikrotikService.cutOnApi`). Si la IP la repartiera un pool y
 * cambiara en cada reconexión, el cliente cortado se destaparía solo al volver a
 * conectar. La IP fija es carga estructural del corte, no una manía heredada.
 *
 * DE DÓNDE SALE EL ESPACIO. De los /24 que ESE router ya usa para sus secrets
 * PPPoE, y de ningún otro sitio (decisión de 2026-08-06). Nexus no inventa
 * bloques nuevos: si el router reparte 10.20.0.x–10.20.14.x, el hueco sale de
 * ahí. Así no hay forma de entregarle a un cliente una dirección de un bloque
 * que en realidad es de infraestructura o de otra sede.
 *
 * QUÉ SE CONSIDERA OCUPADO (en este orden de autoridad):
 *   1. el propio router: `/ppp/secret` (todas las remote-address) y `/ip/address`
 *      (las direcciones de sus interfaces — nunca se entrega la IP del router)
 *   2. `IpAssignment`: lo reservado por otra alta que va a medio camino
 *   3. `Subscriber.ipRemote` en la BD, por si el secret aún no está escrito
 * Más .0, .1 y .255 de cada /24, que por convención son red / gateway / broadcast.
 */

/** Números de host que nunca se entregan dentro de un /24. */
const HOST_RESERVADOS = new Set([0, 1, 255]);

/**
 * Cuántos secrets tiene que tener un /24 para considerarlo "red de clientes".
 *
 * No es un número redondo por gusto: con el umbral en 3 se colaban redes que NO
 * son de abonados —`192.168.5.0/24` en Villanueva GPON, `172.30.255.0/24` y
 * `192.168.6.0/24` en Yopal, y hasta una PÚBLICA (`38.199.241.0/24`) en
 * Tauramena—, todas con entre 3 y 11 secrets. Son erratas de tecleo y enlaces de
 * gestión; repartir ahí es entregarle a un cliente la dirección de un equipo.
 * Con 20 desaparecen todas y cada router se queda con su bloque de verdad
 * (Villanueva EOC → 80.0.x, GPON → 10.20.x, Yopal → 10.100.x…), que es
 * exactamente lo acordado: no inventar bloques nuevos.
 */
const MIN_SECRETS_POR_RED = 20;

const esIp = (v: unknown): v is string => typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
const aNumero = (ip: string) => ip.split('.').reduce((acc, oct) => acc * 256 + Number(oct), 0);
const aIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export type ResultadoIp = {
  ip: string | null;
  motivo?: string;
  /** Cuántas quedaban libres tras entregar ésta (para avisar antes de que se agote). */
  libres?: number;
};

export class IpAllocatorService {
  private readonly logger = new Logger('IpAllocatorService');

  constructor(private prisma: PrismaService) {}

  /**
   * El router FÍSICO. Villanueva EOC y EPON son el mismo equipo dado de alta dos
   * veces (190.14.238.115:5000): repartir por fila `Mikrotik` entregaría la misma
   * IP dos veces creyendo que son routers distintos.
   */
  private host(mk: Pick<Mikrotik, 'ip' | 'port'>): string {
    return `${mk.ip}:${mk.port}`;
  }

  /**
   * Elige y RESERVA la primera IP libre del router. La reserva (unique en
   * `IpAssignment`) es lo que impide que dos altas simultáneas —el backend corre
   * en cluster_mode, un candado en memoria no basta— se lleven la misma.
   *
   * Devuelve `ip: null` con motivo si no hay espacio; nunca lanza por eso: el
   * alta tiene que poder seguir sin IP y avisar, no reventar a medias.
   */
  async asignar(mk: Mikrotik, subscriberId: string): Promise<ResultadoIp> {
    let ocupadas: Set<number>;
    let redes: number[];
    let porRed: Map<number, number>;
    try {
      ({ ocupadas, redes, porRed } = await this.censo(mk));
    } catch (e) {
      return { ip: null, motivo: `No se pudo leer el router para elegir IP: ${(e as Error).message}` };
    }
    if (!redes.length) {
      return { ip: null, motivo: 'El router no tiene ninguna red en uso de la que sacar una IP libre.' };
    }

    const libres = this.candidatas(redes, ocupadas, porRed);
    if (!libres.length) {
      return { ip: null, motivo: 'No quedan IPs libres en las redes que usa este router.' };
    }

    // Se intenta reservar en orden. Si otra alta ganó la carrera, Postgres rechaza
    // por el unique y se pasa a la siguiente — por eso el bucle y no un solo intento.
    const routerHost = this.host(mk);
    for (const n of libres.slice(0, 50)) {
      const ip = aIp(n);
      try {
        await this.prisma.ipAssignment.create({
          data: { routerHost, ip, subscriberId, state: 'RESERVADA' },
        });
        return { ip, libres: libres.length - 1 };
      } catch {
        continue; // ya reservada por otro; siguiente candidata
      }
    }
    return { ip: null, motivo: 'No se pudo reservar ninguna IP libre (demasiadas altas a la vez).' };
  }

  /**
   * IPs libres, en el orden en que conviene entregarlas.
   *
   * El orden importa más de lo que parece. Repartiendo "la primera libre del /24
   * más bajo" salían cosas como mudar un cliente de Yopal GPON de 10.100.x a
   * 10.0.0.x —que es el bloque del OTRO router de la sede—: no chocaba con nadie,
   * pero le cambiaba la red a un cliente sin motivo, y esos /24 se corresponden
   * con sectores de la planta física. Así que:
   *
   *   · con `cerca` (reparación): primero su MISMA red, luego las más próximas.
   *     Al cliente se le mueve el último octeto y se queda en su sector.
   *   · sin `cerca` (alta nueva): primero la red con más clientes, que es el
   *     bloque de verdad del router y no un residuo de tres direcciones sueltas.
   */
  private candidatas(
    redes: number[],
    ocupadas: Set<number>,
    porRed: Map<number, number>,
    cerca?: number,
  ): number[] {
    const orden = [...redes].sort((a, b) => {
      if (cerca !== undefined) {
        const da = Math.abs(a - cerca);
        const db = Math.abs(b - cerca);
        if (da !== db) return da - db;
      }
      return (porRed.get(b) ?? 0) - (porRed.get(a) ?? 0) || a - b;
    });
    const libres: number[] = [];
    for (const red of orden) {
      for (let host = 2; host <= 254; host++) {
        if (HOST_RESERVADOS.has(host)) continue;
        const n = red + host;
        if (!ocupadas.has(n)) libres.push(n);
      }
    }
    return libres;
  }

  /** La IP ya está escrita en el `/ppp/secret`: la reserva pasa a definitiva. */
  async confirmar(mk: Pick<Mikrotik, 'ip' | 'port'>, ip: string): Promise<void> {
    await this.prisma.ipAssignment
      .updateMany({ where: { routerHost: this.host(mk), ip }, data: { state: 'CONFIRMADA' } })
      .catch(() => undefined);
  }

  /**
   * El alta falló después de reservar: se suelta la IP. Sin esto cada intento
   * fallido quemaría una dirección para siempre.
   */
  async liberar(mk: Pick<Mikrotik, 'ip' | 'port'>, ip: string): Promise<void> {
    await this.prisma.ipAssignment
      .deleteMany({ where: { routerHost: this.host(mk), ip, state: 'RESERVADA' } })
      .catch(() => undefined);
  }

  /**
   * Qué está ocupado y en qué redes se puede repartir.
   *
   * SE CENSA LA SEDE ENTERA, no el router. Villanueva tiene dos equipos
   * (…115 EOC/EPON y …116 GPON) y Yopal otros dos, y los dos de cada sede
   * reparten sobre redes que se solapan (Yopal y Yopal_Eoc usan ambos
   * 10.0.0.x–10.0.2.x). Censando sólo el router propio, dos clientes de la misma
   * sede podían acabar con la misma IP, y entonces cortar a uno mete en MOROSOS
   * una dirección que también es del otro.
   */
  private async censo(mk: Mikrotik): Promise<{ ocupadas: Set<number>; redes: number[]; porRed: Map<number, number> }> {
    const hermanos = await this.prisma.mikrotik.findMany({ where: { sedeLegacy: mk.sedeLegacy } });
    // Un equipo físico puede estar dado de alta varias veces (EOC y EPON son la
    // misma caja): se consulta una sola vez por host y no una por fila.
    const porHost = new Map<string, Mikrotik>();
    for (const h of hermanos) porHost.set(this.host(h), h);

    const ocupadas = new Set<number>();
    const porRed = new Map<number, number>();
    /** Cuántos secrets tiene el /24 en el router al que se le va a repartir. */
    const porRedPropio = new Map<number, number>();

    for (const [host, router] of porHost) {
      const api = new RouterosClient();
      let secrets: Record<string, string>[] = [];
      let direcciones: Record<string, string>[] = [];
      try {
        await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 15000 });
        secrets = await api.comm('/ppp/secret/getall', { '.proplist': 'name,remote-address' });
        direcciones = await api.comm('/ip/address/getall', { '.proplist': 'address' });
      } catch (e) {
        // El router propio es obligatorio: sin su censo no se puede repartir sin
        // riesgo. Un hermano caído sólo se avisa — bloquear todas las altas de la
        // sede porque un segundo equipo no contesta sería peor que el riesgo.
        if (host === this.host(mk)) throw e;
        this.logger.warn(`Censo de IPs: ${router.name} (${host}) no respondió; se reparte sin ver sus secrets.`);
        continue;
      } finally {
        api.close();
      }

      const esPropio = host === this.host(mk);
      for (const s of secrets) {
        const ip = s['remote-address'];
        if (!esIp(ip)) continue;
        const n = aNumero(ip);
        ocupadas.add(n);
        const red = n & 0xffffff00;
        porRed.set(red, (porRed.get(red) ?? 0) + 1);
        if (esPropio) porRedPropio.set(red, (porRedPropio.get(red) ?? 0) + 1);
      }
      // Las direcciones de los interfaces del equipo (llegan como 10.20.0.1/24).
      for (const d of direcciones) {
        const ip = (d.address || '').split('/')[0];
        if (esIp(ip)) ocupadas.add(aNumero(ip));
      }
    }

    // Reservas en vuelo de otras altas, en cualquier equipo de la sede.
    const reservas = await this.prisma.ipAssignment.findMany({
      where: { routerHost: { in: [...porHost.keys()] } },
      select: { ip: true },
    });
    for (const r of reservas) if (esIp(r.ip)) ocupadas.add(aNumero(r.ip));

    // Lo que la BD cree que está en uso en la sede, por si un secret todavía no se
    // escribió (alta a medias, router caído en su momento).
    const enBd = await this.prisma.subscriber.findMany({
      where: { branch: { legacyId: mk.sedeLegacy }, ipRemote: { not: null } },
      select: { ipRemote: true },
    });
    for (const s of enBd) if (esIp(s.ipRemote)) ocupadas.add(aNumero(s.ipRemote!));

    const redes = [...porRedPropio.entries()]
      .filter(([, veces]) => veces >= MIN_SECRETS_POR_RED)
      .map(([red]) => red)
      .sort((a, b) => a - b);

    return { ocupadas, redes, porRed: porRedPropio };
  }

  /**
   * Informe de qué IPs están repetidas en un router: dos abonados con la misma
   * dirección significa que cortar a uno bloquea también al otro.
   */
  async duplicadas(mk: Mikrotik) {
    const api = new RouterosClient();
    let secrets: Record<string, string>[] = [];
    try {
      await api.connect(mk.ip, Number(mk.port), mk.username, decryptSecret(mk.password), { timeoutMs: 15000 });
      secrets = await api.comm('/ppp/secret/getall', { '.proplist': 'name,remote-address' });
    } finally {
      api.close();
    }
    const porIp = new Map<string, string[]>();
    for (const s of secrets) {
      const ip = s['remote-address'];
      if (!esIp(ip)) continue;
      if (!porIp.has(ip)) porIp.set(ip, []);
      porIp.get(ip)!.push(s.name);
    }
    const repetidas = [...porIp.entries()]
      .filter(([, nombres]) => nombres.length > 1)
      .map(([ip, nombres]) => ({ ip, usuarios: nombres }))
      .sort((a, b) => aNumero(a.ip) - aNumero(b.ip));
    return { router: mk.name, host: this.host(mk), total: repetidas.length, repetidas };
  }

  /**
   * Repara las IPs repetidas de un router: dos abonados con la misma dirección
   * significa que cortar a uno mete en MOROSOS una IP que también es del otro —
   * el segundo se queda sin internet sin deber nada, o el moroso sigue navegando.
   *
   * QUIÉN SE QUEDA CON LA IP. El que tenga sesión PPP activa en ese momento;
   * entre varios activos o ninguno, el primero por orden alfabético de usuario
   * (criterio estable: dos pasadas dan el mismo resultado). Al resto se le da una
   * libre. Se prefiere no mover a quien está conectado porque el cambio sólo
   * entra cerrándole la sesión.
   *
   * QUÉ SE TOCA POR CADA MUDANZA:
   *   1. el `/ppp/secret` (remote-address nuevo)
   *   2. `Subscriber.ipRemote`, para que el resto del ERP no quede desfasado
   *   3. la address-list MOROSOS si el abonado estaba cortado — sin esto el corte
   *      seguiría apuntando a la IP vieja y el cliente se destaparía solo
   *   4. la sesión PPP activa, que se cierra para que tome la dirección nueva
   *
   * `dryRun` (por defecto) NO toca nada: devuelve el plan para revisarlo.
   */
  async repararDuplicadas(mk: Mikrotik, { dryRun = true, limite = 0 } = {}) {
    const { ocupadas, redes, porRed } = await this.censo(mk);
    const routerHost = this.host(mk);

    const api = new RouterosClient();
    const acciones: {
      usuario: string; ipVieja: string; ipNueva: string | null;
      cortado: boolean; activo: boolean; ok?: boolean; motivo?: string;
    }[] = [];

    try {
      await api.connect(mk.ip, Number(mk.port), mk.username, decryptSecret(mk.password), { timeoutMs: 15000 });
      const secrets = await api.comm('/ppp/secret/getall', { '.proplist': '.id,name,remote-address,comment' });
      const activos = await api.comm('/ppp/active/getall', { '.proplist': '.id,name' });
      const nombresActivos = new Set(activos.map((a) => a.name));

      const porIp = new Map<string, typeof secrets>();
      for (const s of secrets) {
        const ip = s['remote-address'];
        if (!esIp(ip)) continue;
        if (!porIp.has(ip)) porIp.set(ip, []);
        porIp.get(ip)!.push(s);
      }

      for (const [ip, grupo] of [...porIp.entries()].sort((a, b) => aNumero(a[0]) - aNumero(b[0]))) {
        if (grupo.length < 2) continue;
        const ordenado = [...grupo].sort((a, b) => {
          const actA = nombresActivos.has(a.name) ? 0 : 1;
          const actB = nombresActivos.has(b.name) ? 0 : 1;
          return actA - actB || String(a.name).localeCompare(String(b.name));
        });
        // El primero conserva la IP; los demás se mudan.
        for (const s of ordenado.slice(1)) {
          if (limite && acciones.length >= limite) break;
          const sub = await this.prisma.subscriber.findFirst({
            where: { pppUsername: s.name },
            select: { id: true, status: true },
          });
          const cortado = ['CORTADO', 'CARTERA', 'SUSPENDIDO'].includes(sub?.status ?? '');
          const activo = nombresActivos.has(s.name);

          // Se busca hueco EN SU PROPIA RED primero: mudarlo de sector sería
          // cambiarle la red a un cliente que sólo tenía el último octeto repetido.
          const nuevaN = this.candidatas(redes, ocupadas, porRed, aNumero(ip) & 0xffffff00)[0];
          if (nuevaN === undefined) {
            acciones.push({ usuario: s.name, ipVieja: ip, ipNueva: null, cortado, activo, ok: false, motivo: 'sin IPs libres' });
            continue;
          }
          const ipNueva = aIp(nuevaN);
          // Se marca ocupada ya: en simulación es lo que evita proponer la misma
          // dirección para dos duplicados distintos y enseñar un plan imposible.
          ocupadas.add(nuevaN);
          const accion = { usuario: s.name, ipVieja: ip, ipNueva, cortado, activo, ok: undefined as boolean | undefined, motivo: undefined as string | undefined };
          acciones.push(accion);

          if (dryRun) continue;

          try {
            // Reserva primero: si otra alta corre a la vez, que no se la lleve.
            await this.prisma.ipAssignment.create({
              data: { routerHost, ip: ipNueva, subscriberId: sub?.id ?? null, state: 'RESERVADA' },
            });
            await api.comm('/ppp/secret/set', { '.id': s['.id'], 'remote-address': ipNueva });
            if (sub) {
              await this.prisma.subscriber.update({ where: { id: sub.id }, data: { ipRemote: ipNueva } });
            }
            // La address-list del corte tiene que seguir a la IP nueva.
            if (cortado) {
              const enLista = await api.comm('/ip/firewall/address-list/print', { '?list': 'MOROSOS', '?address': ip });
              for (const e of enLista) {
                if (e['.id']) await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ipNueva });
              }
            }
            // Cerrar la sesión: sin esto sigue navegando con la dirección vieja.
            if (activo) {
              const ses = await api.comm('/ppp/active/getall', { '.proplist': '.id', '?name': s.name });
              for (const a of ses) if (a['.id']) await api.comm('/ppp/active/remove', { '.id': a['.id'] });
            }
            await this.prisma.ipAssignment.updateMany({
              where: { routerHost, ip: ipNueva }, data: { state: 'CONFIRMADA' },
            });
            ocupadas.add(nuevaN);
            accion.ok = true;
          } catch (e) {
            await this.liberar(mk, ipNueva);
            accion.ok = false;
            accion.motivo = (e as Error).message;
            ocupadas.delete(nuevaN);
          }
        }
      }
    } finally {
      api.close();
    }

    return {
      router: mk.name, host: routerHost, dryRun,
      total: acciones.length,
      aplicadas: acciones.filter((a) => a.ok === true).length,
      fallidas: acciones.filter((a) => a.ok === false).length,
      acciones,
    };
  }

  /** Cuántas IPs libres le quedan a un router (para avisar antes de que se agote). */
  async disponibilidad(mk: Mikrotik) {
    const { ocupadas, redes } = await this.censo(mk);
    let libres = 0;
    for (const red of redes) {
      for (let host = 2; host <= 254; host++) {
        if (HOST_RESERVADOS.has(host)) continue;
        if (!ocupadas.has(red + host)) libres++;
      }
    }
    return {
      router: mk.name,
      host: this.host(mk),
      redes: redes.map((r) => `${aIp(r)}/24`),
      ocupadas: ocupadas.size,
      libres,
    };
  }
}

/** Utilidades compartidas con los scripts de mantenimiento. */
export const ipUtils = { esIp, aNumero, aIp };
