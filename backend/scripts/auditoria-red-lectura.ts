/**
 * Auditoría de SOLO LECTURA de toda la red (2026-09-23, trabajo nocturno).
 *
 * Vuelca a una carpeta lo que hace falta para juzgar el estado de la red:
 *   - Mikrotik (API): identidad, recursos, interfaces, VLANs, rutas, firewall,
 *     servicios expuestos, usuarios, PPP (secrets/activos/perfiles), address-lists,
 *     colas, logs. Una vez por IP:puerto (EPON y EOC de Villanueva son el mismo).
 *   - OLT Huawei (SSH/telnet): versión, tableros, CPU/memoria/temperatura,
 *     alarmas, uplinks, VLANs, service-ports, perfiles, ONUs y potencia óptica
 *     por puerto, autofind.
 *   - GenieACS (NBI, solo GET): dispositivos, fallas y tareas pendientes.
 *
 * LISTA BLANCA, se comprueba ANTES de enviar cada comando:
 *   - OLT: `display ...`, `interface gpon|epon F/S` y `quit` (solo para
 *     entrar/salir del contexto donde vive `display ont optical-info`).
 *   - Mikrotik: comandos que terminan en `/print`.
 *   - GenieACS: solo método GET.
 * Cualquier otra cosa lanza error y no sale del servidor.
 *
 * Una sola sesión por OLT y se cierra al terminar. Antes de abrirla espera a
 * que no haya otro script de diagnóstico de OLT corriendo (los VTY son pocos).
 * La salida va SIEMPRE a archivos; nunca pipear a `head` (SIGPIPE deja la
 * sesión VTY colgada).
 *
 * Uso (desde backend/):
 *   npx ts-node --transpile-only scripts/auditoria-red-lectura.ts <carpeta> [mikrotik|olt|genieacs|todo] [NOMBRE_OLT]
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createOltDriver } from '../src/network/olt/olt-factory';
import { RouterosClient } from '../src/network/routeros/routeros-client';
import { decryptSecret } from '../src/common/secret-box';

const prisma = new PrismaClient();
const ahora = () => new Date().toISOString();

// ───────────────────────── Mikrotik ─────────────────────────

/** [archivo, comando, proplist opcional]. Solo `/print`. */
const MK_CMDS: [string, string, string?][] = [
  ['identidad', '/system/identity/print'],
  ['recursos', '/system/resource/print'],
  ['routerboard', '/system/routerboard/print'],
  ['salud', '/system/health/print'],
  ['reloj', '/system/clock/print'],
  ['paquetes', '/system/package/print'],
  ['licencia', '/system/license/print'],
  ['ntp', '/system/ntp/client/print'],
  ['scheduler', '/system/scheduler/print'],
  ['scripts', '/system/script/print', 'name,owner,last-started,run-count,policy'],
  ['usuarios', '/user/print', 'name,group,address,disabled,last-logged-in'],
  ['grupos', '/user/group/print'],
  ['usuarios-activos', '/user/active/print'],
  ['servicios-ip', '/ip/service/print'],
  ['snmp', '/snmp/print'],
  ['dns', '/ip/dns/print'],
  ['interfaces', '/interface/print'],
  ['ethernet', '/interface/ethernet/print'],
  ['vlans', '/interface/vlan/print'],
  ['bridges', '/interface/bridge/print'],
  ['bridge-puertos', '/interface/bridge/port/print'],
  ['l2tp-server', '/interface/l2tp-server/server/print'],
  ['pptp-server', '/interface/pptp-server/server/print'],
  ['sstp-server', '/interface/sstp-server/server/print'],
  ['ovpn-server', '/interface/ovpn-server/server/print'],
  ['direcciones', '/ip/address/print'],
  ['rutas', '/ip/route/print'],
  ['pools', '/ip/pool/print'],
  ['pools-usados', '/ip/pool/used/print', 'pool,address,owner,info'],
  ['dhcp-server', '/ip/dhcp-server/print'],
  ['dhcp-leases', '/ip/dhcp-server/lease/print', 'address,mac-address,host-name,status,dynamic,server'],
  ['arp', '/ip/arp/print', 'address,mac-address,interface,dynamic,invalid,complete'],
  ['vecinos', '/ip/neighbor/print'],
  ['fw-filter', '/ip/firewall/filter/print'],
  ['fw-nat', '/ip/firewall/nat/print'],
  ['fw-mangle', '/ip/firewall/mangle/print'],
  ['fw-raw', '/ip/firewall/raw/print'],
  ['address-lists', '/ip/firewall/address-list/print', 'list,address,disabled,dynamic,comment,creation-time'],
  ['conexiones-conteo', '/ip/firewall/connection/tracking/print'],
  ['ppp-perfiles', '/ppp/profile/print'],
  ['ppp-secrets', '/ppp/secret/print', 'name,service,profile,remote-address,local-address,disabled,comment,last-logged-out,last-disconnect-reason,last-caller-id'],
  ['ppp-activos', '/ppp/active/print', 'name,service,caller-id,address,uptime,radius'],
  ['ppp-aaa', '/ppp/aaa/print'],
  ['pppoe-servers', '/interface/pppoe-server/server/print'],
  ['radius', '/radius/print'],
  ['colas-simples', '/queue/simple/print', 'name,target,max-limit,disabled,dynamic,parent,comment'],
  ['colas-arbol', '/queue/tree/print'],
  ['colas-tipos', '/queue/type/print'],
  ['logging', '/system/logging/print'],
  ['log', '/log/print', 'time,topics,message'],
  // Añadidos para la auditoría de seguridad (solo /print).
  ['snmp-comunidades', '/snmp/community/print', 'name,addresses,read-access,write-access,security,disabled'],
  ['ssh-llaves', '/user/ssh-keys/print'],
  ['romon', '/tool/romon/print'],
  ['mac-server', '/tool/mac-server/print'],
  ['mac-winbox', '/tool/mac-server/mac-winbox/print'],
  ['bandwidth-server', '/tool/bandwidth-server/print'],
  ['socks', '/ip/socks/print'],
  ['proxy', '/ip/proxy/print'],
  ['upnp', '/ip/upnp/print'],
  ['ip-cloud', '/ip/cloud/print'],
  ['ntp-server', '/system/ntp/server/print'],
  ['archivos', '/file/print', 'name,type,size,creation-time,last-modified'],
  ['listas-interfaces', '/interface/list/member/print'],
  ['ipsec-peers', '/ip/ipsec/peer/print', 'name,address,exchange-mode,passive,disabled'],
];

async function leerMikrotiks(base: string) {
  const dir = join(base, 'mikrotik');
  mkdirSync(dir, { recursive: true });
  // AUDIT_MK_ROUTER="nombre" → solo ese router (reintento puntual).
  const routers = (await prisma.mikrotik.findMany({ orderBy: { name: 'asc' } }))
    .filter((r) => !process.env.AUDIT_MK_ROUTER || r.name === process.env.AUDIT_MK_ROUTER);
  const resumen: any[] = [];
  const vistos = new Map<string, string>();
  for (const r of routers) {
    const clave = `${r.ip}:${r.port}`;
    if (vistos.has(clave)) {
      resumen.push({ router: r.name, host: clave, mismoEquipoQue: vistos.get(clave) });
      continue;
    }
    vistos.set(clave, r.name);
    const api = new RouterosClient();
    const fila: any = { router: r.name, host: clave, tech: r.tech, sedeLegacy: r.sedeLegacy, usuarioApi: r.username, inicio: ahora(), archivos: {} as Record<string, any> };
    const leer = async (cmd: string, proplist?: string) => {
      if (!/^\/[a-z0-9/-]+\/print$/.test(cmd)) throw new Error(`comando no permitido: ${cmd}`);
      return api.comm(cmd, proplist ? { '.proplist': proplist } : {}, 90000);
    };
    try {
      await api.connect(r.ip, Number(r.port), r.username, decryptSecret(r.password), { timeoutMs: 15000 });
      const sub = join(dir, r.name);
      mkdirSync(sub, { recursive: true });
      // AUDIT_MK_SOLO="a,b" → solo esas entradas de MK_CMDS (para completar una recolección sin repetirla entera).
      const solo = (process.env.AUDIT_MK_SOLO || '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const [archivo, cmd, proplist] of MK_CMDS.filter(([a]) => !solo.length || solo.includes(a))) {
        try {
          const filas = await leer(cmd, proplist);
          writeFileSync(join(sub, `${archivo}.json`), JSON.stringify(filas, null, 1));
          fila.archivos[archivo] = filas.length;
        } catch (e) {
          fila.archivos[archivo] = 'ERROR: ' + (e as Error).message;
        }
      }
      fila.conecta = true;
    } catch (e) {
      fila.conecta = false;
      fila.error = (e as Error).message;
    } finally {
      try { api.close(); } catch { /* cerrando */ }
    }
    fila.fin = ahora();
    resumen.push(fila);
    console.log(`${r.name}: ${fila.conecta ? 'OK' : 'NO CONECTA — ' + fila.error}`);
  }
  const nombre = process.env.AUDIT_MK_ROUTER ? `resumen-extra-${process.env.AUDIT_MK_ROUTER}.json` : process.env.AUDIT_MK_SOLO ? 'resumen-extra.json' : 'resumen.json';
  writeFileSync(join(dir, nombre), JSON.stringify(resumen, null, 2));
}

// ───────────────────────── OLT ─────────────────────────

const OLT_PERMITIDO = /^(display [a-z0-9 /_.:-]+|interface (gpon|epon) \d+\/\d+|quit)$/i;

/** Espera (hasta 90 min) a que ningún otro script de diagnóstico tenga una sesión abierta con la OLT. */
function esperarOtrosDiagnosticosOlt(log: (s: string) => void) {
  const patron = /diagnostico-vlans-olt|olt-anchos-banda|ligar-vlans-a-olt/;
  for (let i = 0; i < 180; i++) {
    const ps = execSync('ps -eo pid,args', { encoding: 'utf8' })
      // Solo procesos node/ts-node/npx que corren ESE script (no cualquier línea que lo mencione, p. ej. el prompt de claude).
      .split('\n').filter((l) => patron.test(l) && /^\s*\d+\s+(\S*\/)?(node|ts-node|npx)\b/.test(l));
    if (!ps.length) return;
    if (i === 0) log(`esperando a que termine otro diagnóstico de OLT: ${ps.join(' | ')}`);
    execSync('sleep 30');
  }
  log('siguen corriendo otros diagnósticos tras 90 min; sigo igual (una sola sesión propia)');
}

async function leerOlt(base: string, olt: any) {
  const dir = join(base, 'olt');
  mkdirSync(dir, { recursive: true });
  // AUDIT_OLT_EXTRA="display a;display b" → sesión corta solo con esos comandos (misma lista blanca), a <olt>-extra.txt.
  const extra = (process.env.AUDIT_OLT_EXTRA || '').split(';').map((c) => c.trim()).filter(Boolean);
  const archivo = join(dir, `${olt.name.toLowerCase()}${extra.length ? '-extra' : ''}.txt`);
  writeFileSync(archivo, `=== ${olt.name} · ${olt.brand} · ${olt.ip}:${olt.port} · ${olt.transport} · inicio ${ahora()}\n`);
  const log = (s: string) => appendFileSync(archivo, s + '\n');
  esperarOtrosDiagnosticosOlt(log);

  const driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password), olt.transport);
  const cerrar = () => { try { driver.disconnect(); } catch { /* cerrando */ } };

  let conecto = false;
  for (let intento = 1; intento <= 2 && !conecto; intento++) {
    conecto = await driver.connect();
    if (!conecto) { log(`NO CONECTA (intento ${intento}): ${driver.getError()}`); if (intento < 2) execSync('sleep 20'); }
  }
  if (!conecto) return { olt: olt.name, conecta: false, error: driver.getError() };

  const enviar = async (cmd: string) => {
    if (!OLT_PERMITIDO.test(cmd) || /\bundo\b|[;\n]/.test(cmd)) throw new Error(`comando no permitido: ${cmd}`);
    log('\n' + '─'.repeat(72) + `\n$ ${cmd}\n` + '─'.repeat(72));
    let out = '';
    try { out = await (driver as any).sendCommand(cmd); } catch (e) { out = 'ERROR: ' + (e as Error).message; }
    log(out || '(sin salida)');
    return out;
  };

  try {
    await driver.prepare(); // enable + config: solo cambia de modo, no escribe nada.
    if (extra.length) {
      for (const c of extra) await enviar(c);
      log(`\n=== fin ${ahora()}`);
      return { olt: olt.name, conecta: true, extra: extra.length };
    }
    for (const c of [
      'display version', 'display sysuptime', 'display patch-information', 'display board 0',
      'display cpu 0/9', 'display cpu 0/10', 'display memory 0/9', 'display memory 0/10',
      'display temperature 0/9', 'display power-supply 0', 'display fan 0',
      'display alarm active all', 'display alarm history all',
      'display port state 0/8/0', 'display port state 0/8/1', 'display port state 0/9/0', 'display port state 0/9/1',
      'display port state 0/10/0', 'display port state 0/10/1', 'display port state 0/19/0', 'display port state 0/20/0',
      'display vlan all', 'display service-port all',
      'display ont-lineprofile gpon all', 'display ont-srvprofile gpon all',
      'display dba-profile all', 'display traffic table ip from-index 0',
      'display ont autofind all',
      'display autosave interval', 'display autosave configuration',
      'display ntp-service status', 'display snmp-agent sys-info', 'display ssh server status',
      'display users', 'display sysman service state', 'display security config',
    ]) await enviar(c);

    const tableros = (await enviar('display board 0')).split('\n')
      .map((l) => l.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ slot: Number(m[1]), nombre: m[2], estado: m[3], tipo: /GP|GICF/i.test(m[2]) ? 'gpon' : /EP/i.test(m[2]) ? 'epon' : '' }))
      .filter((t) => t.tipo);

    for (const t of tableros) {
      const detalle = await enviar(`display board 0/${t.slot}`);
      await enviar(`display ont info summary 0/${t.slot}`);
      // Puertos que existen en el tablero (líneas "  N  GPON/EPON ...") — si no se reconocen, 0..15.
      const puertos = [...new Set(detalle.split('\n')
        .map((l) => l.match(/^\s*(\d{1,2})\s+(GPON|EPON)/i)).filter(Boolean).map((m) => Number(m![1])))];
      const lista = puertos.length ? puertos : Array.from({ length: 16 }, (_, i) => i);
      for (const p of lista) await enviar(`display ont info 0 ${t.slot} ${p} all`);
      await enviar(`interface ${t.tipo} 0/${t.slot}`);
      try {
        for (const p of lista) await enviar(`display ont optical-info ${p} all`);
        for (const p of lista) await enviar(`display port state ${p}`);
      } finally {
        await enviar('quit');
      }
    }
    log(`\n=== fin ${ahora()}`);
    return { olt: olt.name, conecta: true, tableros: tableros.length };
  } finally {
    cerrar();
  }
}

async function leerOlts(base: string, soloNombre?: string) {
  const olts = (await prisma.olt.findMany({ orderBy: { name: 'asc' } }))
    .filter((o) => !soloNombre || o.name.toLowerCase() === soloNombre.toLowerCase());
  const resumen: any[] = [];
  for (const o of olts) {
    try {
      const r = await leerOlt(base, o);
      resumen.push(r);
      console.log(`${o.name}: ${r.conecta ? 'OK' : 'NO CONECTA — ' + (r as any).error}`);
    } catch (e) {
      resumen.push({ olt: o.name, conecta: false, error: (e as Error).message });
      console.log(`${o.name}: ERROR — ${(e as Error).message}`);
    }
  }
  if (!soloNombre) writeFileSync(join(base, 'olt', 'resumen.json'), JSON.stringify(resumen, null, 2));
}

// ───────────────────────── GenieACS ─────────────────────────

async function leerGenieacs(base: string) {
  const dir = join(base, 'genieacs');
  mkdirSync(dir, { recursive: true });
  const s = (await prisma.genieacsServer.findFirst({ where: { isDefault: true } }))
    ?? (await prisma.genieacsServer.findFirst({ orderBy: { createdAt: 'asc' } }));
  if (!s) { writeFileSync(join(dir, 'error.txt'), 'No hay servidor GenieACS registrado'); return; }
  const headers: Record<string, string> = {};
  const pass = decryptSecret(s.password);
  if (s.username) headers.Authorization = 'Basic ' + Buffer.from(`${s.username}:${pass}`).toString('base64');
  const get = async (ruta: string) => {
    const r = await fetch(s.nbiUrl.replace(/\/+$/, '') + ruta, { method: 'GET', headers, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const proy = [
    '_id', '_lastInform', '_registered', '_tags', '_deviceId._Manufacturer', '_deviceId._ProductClass',
    '_deviceId._SerialNumber', 'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'InternetGatewayDevice.DeviceInfo.UpTime', 'InternetGatewayDevice.ManagementServer.ConnectionRequestUsername',
  ].join(',');
  for (const [archivo, ruta] of [
    ['dispositivos', `/devices/?projection=${encodeURIComponent(proy)}`],
    ['fallas', '/faults/'],
    ['tareas', '/tasks/'],
    ['presets', '/presets/'],
    ['provisions', '/provisions/?projection=_id'],
  ] as const) {
    try { writeFileSync(join(dir, `${archivo}.json`), JSON.stringify(await get(ruta), null, 1)); }
    catch (e) { writeFileSync(join(dir, `${archivo}.error.txt`), (e as Error).message); }
  }
}

async function main() {
  const [carpeta, que = 'todo', soloOlt] = process.argv.slice(2);
  if (!carpeta) { console.error('Uso: auditoria-red-lectura.ts <carpeta> [mikrotik|olt|genieacs|todo] [NOMBRE_OLT]'); process.exit(1); }
  mkdirSync(carpeta, { recursive: true });
  for (const sig of ['SIGPIPE', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(1));
  try {
    if (que === 'mikrotik' || que === 'todo') await leerMikrotiks(carpeta);
    if (que === 'genieacs' || que === 'todo') await leerGenieacs(carpeta);
    if (que === 'olt' || que === 'todo') await leerOlts(carpeta, soloOlt);
  } finally {
    await prisma.$disconnect();
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
