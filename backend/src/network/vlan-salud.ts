/**
 * Salud de las VLANs de una OLT de punta a punta (2026-09-23).
 *
 * Una VLAN solo da servicio si está en los cuatro sitios: el catálogo de nexus
 * (`/red/vlans`), la OLT (`vlan N smart`), el uplink de la OLT (`port vlan N
 * <uplink>`) y el Mikrotik de la sede (interfaz VLAN sobre el puerto que va a la
 * OLT + servidor PPPoE en ella). La 590 de Villanueva tenía tres de cuatro: la
 * ONU quedaba en línea y el cliente no navegaba, y nada lo avisaba.
 *
 * Aquí solo hay funciones PURAS sobre lo ya leído de los equipos: el servicio
 * lee (`VlanEquiposService`), esto cruza. Así se prueba con salidas reales sin
 * tocar un equipo.
 */
import type { VlanDeOlt } from './olt/olt-huawei.driver';
import type { PuertoConVlans } from './olt/olt-ssh.client';

/** Lo que se lee de la OLT para juzgar sus VLANs. */
export type LecturaOltVlans = {
  /** `display vlan all`. */
  vlans: VlanDeOlt[];
  /** Puertos de red (uplinks posibles) y su estado, de `display vlan 1`. */
  puertosDeRed: { fsp: string; estado: string }[];
  /** `display port vlan F/S/P` de cada puerto de red: qué VLANs lleva. */
  vlansPorPuertoDeRed: Record<string, number[]>;
  /** `display service-port all` agrupado por PON (la VLAN principal primero). */
  puertos: PuertoConVlans[];
};

/** Lo que se lee de un Mikrotik: interfaces VLAN y servidores PPPoE. */
export type LecturaMikrotikVlans = {
  id: string;
  name: string;
  vlans: { id?: string; name: string; vlanId: number; interfaz: string; disabled: boolean; running: boolean }[];
  pppoe: { id?: string; interfaz: string; serviceName: string; disabled: boolean; params: Record<string, string> }[];
};

export type FilaCatalogoVlan = {
  id: string; vlan: number; detail: string; tray: number | null; oltPort: number | null; oltId: string | null;
};

/**
 * OK: los cuatro sitios bien. ROTA: tiene clientes y le falta un tramo de
 * equipos (OLT/uplink/Mikrotik) — alguien no navega o no navegará. INCOMPLETA:
 * está en el catálogo, sin clientes y le falta algo (la próxima 590).
 * SIN_CATALOGO: funciona en los equipos pero el catálogo no la tiene.
 * SIN_USO: ni clientes ni catálogo; creada a medias en algún equipo.
 */
export type EstadoVlan = 'OK' | 'ROTA' | 'INCOMPLETA' | 'SIN_CATALOGO' | 'SIN_USO';

export type SaludVlan = {
  vlan: number;
  catalogo: { id: string; detail: string; puerto: string | null }[];
  /** PON donde es la VLAN principal / donde solo aparece de arrastre. */
  pon: { principal: string[]; otros: string[] };
  /** Service-ports (≈ clientes) que la usan en la OLT. */
  servicePorts: number;
  olt: { existe: boolean; uplinks: { fsp: string; estado: string }[]; ok: boolean };
  mikrotik: {
    router: string | null;
    interfaz: string | null;
    /** Puerto del router por el que llegan las demás VLANs de este uplink. */
    interfazEsperada: string | null;
    sobre: string | null;
    pppoe: boolean;
    ok: boolean;
  } | null;
  estado: EstadoVlan;
  /** Qué falta, en palabras de técnico. Vacío si está bien. */
  falta: string[];
};

const RED_TODAS = 1; // la VLAN 1 está en todos los puertos de red: no dice nada

/** VLANs que salen por cada puerto de red, a la inversa: VLAN → puertos. */
export function uplinksDeVlan(l: LecturaOltVlans, vlan: number): { fsp: string; estado: string }[] {
  return l.puertosDeRed.filter((p) => (l.vlansPorPuertoDeRed[p.fsp] ?? []).includes(vlan));
}

/**
 * El uplink "de siempre" de la OLT: el puerto de red, arriba, por el que salen
 * más VLANs con clientes. Nunca se fija en el código — en Villanueva es 0/8/0,
 * en Yopal 0/9/0 y Monterrey reparte entre 0/3/0 y 0/3/3. Si el primero no se
 * lleva al menos el 80 % es AMBIGUO: una persona tiene que elegir.
 */
export function uplinkHabitual(l: LecturaOltVlans): {
  fsp: string | null;
  ambiguo: boolean;
  candidatos: { fsp: string; estado: string; vlans: number }[];
} {
  const conClientes = l.vlans.filter((v) => v.vlan !== RED_TODAS && v.servicePorts > 0).map((v) => v.vlan);
  const candidatos = l.puertosDeRed
    .map((p) => ({ ...p, vlans: (l.vlansPorPuertoDeRed[p.fsp] ?? []).filter((v) => conClientes.includes(v)).length }))
    .filter((p) => p.vlans > 0)
    .sort((a, b) => b.vlans - a.vlans || (a.estado === 'up' ? -1 : 1));
  const arriba = candidatos.filter((c) => c.estado === 'up');
  const lider = arriba[0];
  if (!lider) return { fsp: null, ambiguo: false, candidatos };
  const total = arriba.reduce((s, c) => s + c.vlans, 0);
  const ambiguo = lider.vlans / total < 0.8;
  return { fsp: ambiguo ? null : lider.fsp, ambiguo, candidatos: arriba };
}

/**
 * Qué Mikrotik atiende a esta OLT: el que tiene interfaces para más VLANs con
 * clientes de la OLT. Así no se depende de `tech`/`isDefault` de la tabla, que
 * en Villanueva tiene dos filas para el mismo equipo.
 */
export function routerDeLaOlt(l: LecturaOltVlans, routers: LecturaMikrotikVlans[]): LecturaMikrotikVlans | null {
  const conClientes = new Set(l.vlans.filter((v) => v.vlan !== RED_TODAS && v.servicePorts > 0).map((v) => v.vlan));
  let mejor: { r: LecturaMikrotikVlans; n: number } | null = null;
  for (const r of routers) {
    const n = new Set(r.vlans.filter((v) => conClientes.has(v.vlanId)).map((v) => v.vlanId)).size;
    if (n > 0 && (!mejor || n > mejor.n)) mejor = { r, n };
  }
  return mejor?.r ?? null;
}

/**
 * Puerto del Mikrotik que va a ese uplink de la OLT: sobre el que cuelgan las
 * interfaces VLAN de las demás VLANs con clientes que salen por ese uplink. En
 * Monterrey 0/3/0 ↔ sfp-sfpplus2 y 0/3/3 ↔ ether2; en Villanueva 0/8/0 ↔
 * sfp-sfpplus2_OLT.
 */
export function interfazHaciaOlt(l: LecturaOltVlans, router: LecturaMikrotikVlans, uplink: string | null): string | null {
  const porUplink = new Set(
    l.vlans
      .filter((v) => v.vlan !== RED_TODAS && v.servicePorts > 0)
      .filter((v) => !uplink || (l.vlansPorPuertoDeRed[uplink] ?? []).includes(v.vlan))
      .map((v) => v.vlan),
  );
  const cuenta = new Map<string, number>();
  for (const v of router.vlans) {
    if (!porUplink.has(v.vlanId) || v.disabled) continue;
    cuenta.set(v.interfaz, (cuenta.get(v.interfaz) ?? 0) + 1);
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Las filas del catálogo que son de ESTA OLT: las ligadas a ella y, de las
 * heredadas sin OLT (`oltId` null), solo las que la OLT tiene. En Yopal el
 * catálogo trae ~20 VLANs de otro equipo (el Mikrotik las tiene sobre otro
 * puerto) que esta OLT no conoce: juzgarlas aquí sería puro ruido.
 */
export function catalogoDeLaOlt(oltId: string, l: LecturaOltVlans, catalogo: FilaCatalogoVlan[]): FilaCatalogoVlan[] {
  const enOlt = new Set(l.vlans.map((v) => v.vlan));
  return catalogo.filter((c) => c.vlan > 0 && (c.oltId === oltId || (c.oltId == null && enOlt.has(c.vlan))));
}

/** Cruza OLT + Mikrotik + catálogo y da el veredicto por VLAN. */
export function saludDeVlans(p: {
  oltId: string;
  lectura: LecturaOltVlans;
  router: LecturaMikrotikVlans | null;
  /** Por qué no hay router (dry-run, no conecta…) — se repite en cada fila. */
  routerError?: string | null;
  catalogo: FilaCatalogoVlan[];
}): SaludVlan[] {
  const { lectura: l, router } = p;
  const catalogo = catalogoDeLaOlt(p.oltId, l, p.catalogo);
  const habitual = uplinkHabitual(l);
  const numeros = new Set<number>([
    ...catalogo.map((c) => c.vlan),
    ...l.vlans.map((v) => v.vlan),
  ]);
  numeros.delete(RED_TODAS);

  const filas: SaludVlan[] = [];
  for (const n of [...numeros].sort((a, b) => a - b)) {
    const enOlt = l.vlans.find((v) => v.vlan === n);
    const cat = catalogo.filter((c) => c.vlan === n);
    const principal = l.puertos.filter((x) => x.vlans[0]?.vlan === n).map((x) => `${x.frame}/${x.slot}/${x.port}`);
    const otros = l.puertos.filter((x) => x.vlans.slice(1).some((v) => v.vlan === n)).map((x) => `${x.frame}/${x.slot}/${x.port}`);
    const servicePorts = enOlt?.servicePorts ?? 0;
    const uplinks = enOlt ? uplinksDeVlan(l, n) : [];
    const falta: string[] = [];

    if (!cat.length && (servicePorts > 0 || principal.length)) falta.push('no está en el catálogo de VLANs');
    if (!enOlt) falta.push('no existe en la OLT');
    const uplinkOk = uplinks.some((u) => u.estado === 'up');
    if (enOlt && !uplinkOk) {
      falta.push(uplinks.length
        ? `sale solo por ${uplinks.map((u) => u.fsp).join(', ')}, que está caído`
        : 'no sale por el uplink de la OLT');
    }

    let mk: SaludVlan['mikrotik'] = null;
    if (router) {
      const uplinkDeEsta = uplinks.find((u) => u.estado === 'up')?.fsp ?? habitual.fsp;
      const esperada = interfazHaciaOlt(l, router, uplinkDeEsta) ?? interfazHaciaOlt(l, router, null);
      const candidatas = router.vlans.filter((v) => v.vlanId === n);
      const iface = candidatas.find((v) => v.interfaz === esperada && !v.disabled)
        ?? candidatas.find((v) => !v.disabled) ?? candidatas[0] ?? null;
      const pppoe = !!iface && router.pppoe.some((s) => s.interfaz === iface.name && !s.disabled);
      if (!iface) falta.push(`falta la interfaz VLAN en el Mikrotik ${router.name}`);
      else if (iface.disabled) falta.push(`la interfaz ${iface.name} está deshabilitada en ${router.name}`);
      else if (esperada && iface.interfaz !== esperada) falta.push(`en ${router.name} está sobre ${iface.interfaz}, no sobre ${esperada} (el puerto hacia esta OLT)`);
      if (iface && !pppoe) falta.push(`falta el servidor PPPoE en ${iface.name} (${router.name})`);
      mk = {
        router: router.name, interfaz: iface?.name ?? null, interfazEsperada: esperada,
        sobre: iface?.interfaz ?? null, pppoe,
        ok: !!iface && !iface.disabled && pppoe && (!esperada || iface.interfaz === esperada),
      };
    } else if (p.routerError) {
      // Sin router no se puede juzgar ese tramo: se dice, no se da por bueno.
      falta.push(`Mikrotik sin revisar: ${p.routerError}`);
    }

    // Lo que falta en los EQUIPOS decide; que falte en el catálogo solo no
    // deja a nadie sin servicio.
    const enEquipos = falta.filter((f) => !f.startsWith('Mikrotik sin revisar') && f !== 'no está en el catálogo de VLANs');
    const estado: EstadoVlan = enEquipos.length
      ? (servicePorts > 0 ? 'ROTA' : cat.length ? 'INCOMPLETA' : 'SIN_USO')
      : cat.length || !falta.includes('no está en el catálogo de VLANs') ? 'OK' : 'SIN_CATALOGO';
    filas.push({
      vlan: n,
      catalogo: cat.map((c) => ({ id: c.id, detail: c.detail, puerto: c.tray != null && c.oltPort != null ? `0/${c.tray}/${c.oltPort}` : null })),
      pon: { principal, otros },
      servicePorts,
      olt: { existe: !!enOlt, uplinks, ok: !!enOlt && uplinkOk },
      mikrotik: mk,
      estado,
      falta,
    });
  }
  return filas;
}

/**
 * Número de VLAN SUGERIDO para un PON que no tiene ninguna, según el patrón de
 * su tarjeta (Villanueva slot 2: 460 + puerto·10). Se deduce de las VLANs
 * principales de los otros puertos del mismo slot: el paso más repetido y la
 * base más repetida. Solo sugiere: si el número ya lo usan clientes en la OLT
 * (`enUso.olt` = VLANs con service-ports) o está en el catálogo, o no hay patrón
 * claro, lo dice y no propone nada. Una VLAN creada en la OLT pero vacía (la 590
 * antes de su primer cliente) sí se sugiere: es justo la que espera ese puerto.
 */
export function sugerirVlanParaPuerto(
  puertos: PuertoConVlans[], frame: number, slot: number, port: number,
  enUso: { olt: number[]; catalogo: number[] },
): { vlan: number | null; motivo: string } {
  // Un puerto que ya da servicio ya tiene VLAN: la suya, no una sugerida.
  const propia = puertos.find((p) => p.frame === frame && p.slot === slot && p.port === port)?.vlans[0]?.vlan;
  if (propia) return { vlan: propia, motivo: `el puerto 0/${slot}/${port} ya usa la ${propia}` };
  const delSlot = puertos
    .filter((p) => p.frame === frame && p.slot === slot && p.port !== port && p.vlans[0])
    .map((p) => ({ port: p.port, vlan: p.vlans[0].vlan }));
  if (delSlot.length < 2) return { vlan: null, motivo: `la tarjeta 0/${slot} no tiene suficientes puertos con VLAN para deducir el patrón` };
  const moda = (xs: number[]) => {
    const c = new Map<number, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  const pasos: number[] = [];
  for (let i = 0; i < delSlot.length; i++) {
    for (let j = i + 1; j < delSlot.length; j++) {
      const d = (delSlot[j].vlan - delSlot[i].vlan) / (delSlot[j].port - delSlot[i].port);
      if (Number.isInteger(d) && d > 0) pasos.push(d);
    }
  }
  const paso = moda(pasos);
  if (!paso) return { vlan: null, motivo: `las VLANs de la tarjeta 0/${slot} no siguen un patrón` };
  const bases = moda(delSlot.map((p) => p.vlan - p.port * paso[0]));
  // El patrón tiene que explicar a la mayoría de los puertos, no a un par.
  if (bases[1] < Math.max(2, Math.ceil(delSlot.length / 2))) {
    return { vlan: null, motivo: `las VLANs de la tarjeta 0/${slot} no siguen un patrón claro` };
  }
  const vlan = bases[0] + port * paso[0];
  if (vlan < 2 || vlan > 4094) return { vlan: null, motivo: `el patrón daría ${vlan}, fuera de rango` };
  if (enUso.olt.includes(vlan)) return { vlan: null, motivo: `el patrón da ${vlan}, pero ya la usan clientes de otro puerto en la OLT` };
  if (enUso.catalogo.includes(vlan)) return { vlan: null, motivo: `el patrón da ${vlan}, pero ya está en el catálogo` };
  return { vlan, motivo: `patrón de la tarjeta 0/${slot}: ${bases[0]} + puerto·${paso[0]}` };
}

/** Filas crudas de `/interface/vlan/print` y `/interface/pppoe-server/server/print` → lectura. */
export function lecturaMikrotikDeFilas(
  id: string, name: string, vlans: Record<string, string>[], pppoe: Record<string, string>[],
): LecturaMikrotikVlans {
  return {
    id, name,
    vlans: vlans.map((v) => ({
      id: v['.id'], name: v.name ?? '', vlanId: Number(v['vlan-id']), interfaz: v.interface ?? '',
      disabled: v.disabled === 'true', running: v.running === 'true',
    })),
    pppoe: pppoe.map((s) => ({
      id: s['.id'], interfaz: s.interface ?? '', serviceName: s['service-name'] ?? '', disabled: s.disabled === 'true', params: s,
    })),
  };
}

/** Un `add` de RouterOS: menú + parámetros. Solo se permiten los dos de abajo. */
export type PasoRouterOs = { cmd: '/interface/vlan/add' | '/interface/pppoe-server/server/add'; params: Record<string, string> };

/** Parámetros del servidor PPPoE hermano que se copian tal cual (los demás son de estado o de versión). */
const PPPOE_COPIABLES = [
  'default-profile', 'authentication', 'one-session-per-host', 'max-mtu', 'max-mru', 'mrru',
  'keepalive-timeout', 'max-sessions', 'pado-delay',
];

/**
 * Qué agregar en el Mikrotik para que la VLAN N llegue al PPPoE: la interfaz
 * VLAN sobre el puerto que va a la OLT y el servidor PPPoE en ella, COPIANDO
 * nombre y parámetros de lo que ya hay (cada sede lo nombra distinto:
 * `vlan590`/`pppoe590` en Villanueva, `VLAN10`/`VLAN10` en Tauramena,
 * `vlan210`/`service1` en Yopal). Solo agrega: si la interfaz existe pero sobre
 * otro puerto o deshabilitada, NO se toca y se avisa para revisarlo a mano.
 */
export function planMikrotikParaVlan(
  router: LecturaMikrotikVlans, vlan: number, interfaz: string | null,
): { pasos: PasoRouterOs[]; avisos: string[]; nombre: string | null } {
  const avisos: string[] = [];
  const pasos: PasoRouterOs[] = [];
  const existentes = router.vlans.filter((v) => v.vlanId === vlan);
  let iface = existentes.find((v) => v.interfaz === interfaz) ?? existentes[0] ?? null;
  if (iface && interfaz && iface.interfaz !== interfaz) {
    avisos.push(`${router.name} ya tiene la VLAN ${vlan} (${iface.name}) sobre ${iface.interfaz}, no sobre ${interfaz}: no se toca, revisar a mano.`);
    return { pasos, avisos, nombre: iface.name };
  }
  if (iface?.disabled) avisos.push(`La interfaz ${iface.name} está deshabilitada en ${router.name}: no se habilita sola, revisar a mano.`);

  // Hermanas: interfaces VLAN habilitadas sobre el mismo puerto, la de número más cercano primero.
  const hermanas = router.vlans
    .filter((v) => v.interfaz === interfaz && !v.disabled && v.vlanId !== vlan)
    .sort((a, b) => Math.abs(a.vlanId - vlan) - Math.abs(b.vlanId - vlan));
  let nombre = iface?.name ?? null;
  if (!iface) {
    if (!interfaz) {
      avisos.push(`No se sabe sobre qué puerto de ${router.name} va la VLAN ${vlan} (ninguna VLAN de esta OLT está en ese router).`);
      return { pasos, avisos, nombre: null };
    }
    // El nombre sigue el patrón de las hermanas que llevan su número ("vlan580" → "vlan590").
    const conPatron = hermanas.find((h) => h.name.includes(String(h.vlanId)));
    nombre = conPatron ? conPatron.name.replace(String(conPatron.vlanId), String(vlan)) : `vlan${vlan}`;
    if (router.vlans.some((v) => v.name === nombre)) {
      avisos.push(`${router.name} ya tiene una interfaz llamada ${nombre} con otro número: no se crea, revisar a mano.`);
      return { pasos, avisos, nombre: null };
    }
    pasos.push({ cmd: '/interface/vlan/add', params: { name: nombre, 'vlan-id': String(vlan), interface: interfaz } });
    iface = { name: nombre, vlanId: vlan, interfaz, disabled: false, running: false };
  }

  if (!router.pppoe.some((s) => s.interfaz === iface!.name)) {
    const hermano = hermanas
      .map((h) => router.pppoe.find((s) => s.interfaz === h.name && !s.disabled))
      .find(Boolean);
    if (!hermano) {
      avisos.push(`No hay un servidor PPPoE hermano en ${router.name} del que copiar: créelo a mano en ${iface.name}.`);
    } else {
      const numHermano = router.vlans.find((v) => v.name === hermano.interfaz)?.vlanId;
      const servicio = numHermano != null && hermano.serviceName.includes(String(numHermano))
        ? hermano.serviceName.replace(String(numHermano), String(vlan))
        : `pppoe${vlan}`;
      const params: Record<string, string> = { interface: iface.name, 'service-name': servicio };
      for (const k of PPPOE_COPIABLES) if (hermano.params[k] != null && hermano.params[k] !== '') params[k] = hermano.params[k];
      pasos.push({ cmd: '/interface/pppoe-server/server/add', params });
    }
  } else if (!router.pppoe.some((s) => s.interfaz === iface!.name && !s.disabled)) {
    avisos.push(`El servidor PPPoE de ${iface.name} está deshabilitado en ${router.name}: no se habilita solo, revisar a mano.`);
  }
  return { pasos, avisos, nombre };
}

/** Cómo se leería el paso en la terminal de RouterOS (para mostrarlo antes de confirmar). */
export function pasoRouterOsComoTexto(p: PasoRouterOs): string {
  const menu = p.cmd.replace(/\/add$/, '');
  return `${menu} add ` + Object.entries(p.params).map(([k, v]) => `${k}=${/[\s,]/.test(v) ? `"${v}"` : v}`).join(' ');
}
