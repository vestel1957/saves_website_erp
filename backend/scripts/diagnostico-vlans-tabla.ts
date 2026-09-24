/**
 * Tabla del diagnóstico de VLANs (Fase 0 del trabajo nocturno 2026-09-23) a
 * partir de lo YA capturado por `diagnostico-vlans-olt.ts` y
 * `diagnostico-vlans-mikrotik.ts`. No toca ningún equipo; lee el catálogo.
 *
 * Uso (desde backend/):
 *   npx ts-node scripts/diagnostico-vlans-tabla.ts <carpeta-salida>
 *   (espera <carpeta>/olt/<olt>.txt y <carpeta>/mikrotik/*.json; escribe en stdout)
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { detalleVlanDeSalida, vlansDeSalida, vlansPorPuertoDeSalida } from '../src/network/olt/olt-huawei.driver';
import {
  LecturaOltVlans, lecturaMikrotikDeFilas, routerDeLaOlt, saludDeVlans, uplinkHabitual, interfazHaciaOlt,
} from '../src/network/vlan-salud';

const prisma = new PrismaClient();

function lecturaDeCaptura(texto: string): LecturaOltVlans | null {
  const bloques = texto.split(/\n─+\n\$ /);
  const get = (cmd: string) => {
    const b = bloques.find((x) => x.startsWith(cmd + '\n'));
    return b ? b.slice(b.indexOf('\n')) : null;
  };
  const all = get('display vlan all');
  if (!all) return null;
  const vlans = vlansDeSalida(all);
  const red = detalleVlanDeSalida(1, get('display vlan 1') ?? '').uplinks.map((u) => ({ fsp: u.fsp, estado: u.estado }));
  const vlansPorPuertoDeRed: Record<string, number[]> = {};
  for (const v of vlans) {
    const d = get(`display vlan ${v.vlan}`);
    if (!d) continue;
    for (const u of detalleVlanDeSalida(v.vlan, d).uplinks) (vlansPorPuertoDeRed[u.fsp] ??= []).push(v.vlan);
  }
  return { vlans, puertosDeRed: red, vlansPorPuertoDeRed, puertos: vlansPorPuertoDeSalida(get('display service-port all') ?? '') };
}

async function main() {
  const dir = process.argv[2];
  const routersJson = readdirSync(join(dir, 'mikrotik')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, 'mikrotik', f), 'utf8')));
  const mks = await prisma.mikrotik.findMany();
  const olts = await prisma.olt.findMany({ include: { branch: { select: { name: true } } }, orderBy: { name: 'asc' } });
  for (const olt of olts) {
    const f = join(dir, 'olt', olt.name.toLowerCase() + '.txt');
    const texto = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const l = lecturaDeCaptura(texto);
    console.log(`\n### ${olt.branch?.name ?? '—'} · OLT ${olt.name}\n`);
    if (!l) {
      console.log(`La OLT no respondió (${(texto.match(/NO CONECTA: ([^\n]*)/) ?? [])[1] ?? 'sin captura'}). Sin diagnóstico de OLT.\n`);
      const r = routersJson.filter((j) => mks.find((m) => m.name === j.router)?.branchId === olt.branchId);
      for (const j of r) {
        console.log(`Mikrotik ${j.router} (${j.identidad}): ${j.vlans.length} interfaces VLAN, ${j.pppoe.length} servidores PPPoE.`);
        const sinPppoe = j.vlans.filter((v: any) => !j.pppoe.some((s: any) => s.interface === v.name && s.disabled !== 'true')).map((v: any) => `${v['vlan-id']} (${v.name})`);
        if (sinPppoe.length) console.log(`  Interfaces VLAN sin servidor PPPoE: ${sinPppoe.join(', ')}.`);
      }
      continue;
    }
    const routers = routersJson
      .filter((j) => mks.find((m) => m.name === j.router)?.branchId === olt.branchId)
      .map((j) => lecturaMikrotikDeFilas(j.router, j.router, j.vlans, j.pppoe));
    const router = routerDeLaOlt(l, routers);
    const hab = uplinkHabitual(l);
    const catalogo = await prisma.vlan.findMany({ where: { branchId: olt.branchId, OR: [{ oltId: olt.id }, { oltId: null }] } });
    const filas = saludDeVlans({ oltId: olt.id, lectura: l, router, routerError: router ? null : 'ningún Mikrotik de la sede tiene sus VLANs', catalogo });
    console.log(`Uplink habitual: ${hab.fsp ?? (hab.ambiguo ? 'AMBIGUO' : 'ninguno')} · candidatos: ${hab.candidatos.map((c) => `${c.fsp} (${c.vlans} VLANs con clientes)`).join(', ')}`);
    console.log(`Mikrotik que la atiende: ${router?.name ?? 'ninguno'}${router ? ` · puerto hacia la OLT: ${hab.candidatos.map((c) => `${c.fsp}→${interfazHaciaOlt(l, router, c.fsp)}`).join(', ')}` : ''}\n`);
    console.log('| VLAN | PON (principal) | Clientes (service-ports) | Uplink OLT | Mikrotik (interfaz / PPPoE) | Catálogo | Veredicto |');
    console.log('|---:|---|---:|---|---|---|---|');
    for (const x of filas) {
      if (x.estado === 'OK' && !x.servicePorts && !x.catalogo.length) continue;
      const pon = x.pon.principal.join(', ') || (x.pon.otros.length ? `(solo arrastre en ${x.pon.otros.length})` : '—');
      const up = !x.olt.existe ? 'no existe' : x.olt.uplinks.map((u) => `${u.fsp}${u.estado === 'up' ? '' : ' (caído)'}`).join(', ') || '**NINGUNO**';
      const mk = x.mikrotik ? `${x.mikrotik.interfaz ? `${x.mikrotik.interfaz}@${x.mikrotik.sobre}` : '**falta**'} / ${x.mikrotik.pppoe ? 'sí' : '**no**'}` : '—';
      const cat = x.catalogo.map((c) => `${c.detail}${c.puerto ? ` (${c.puerto})` : ''}`).join('; ') || '**no**';
      const ver = x.estado === 'OK' ? 'OK' : `**${x.estado}**: ${x.falta.join('; ')}`;
      console.log(`| ${x.vlan} | ${pon} | ${x.servicePorts} | ${up} | ${mk} | ${cat} | ${ver} |`);
    }
    const n = (e: string) => filas.filter((x) => x.estado === e).length;
    console.log(`\nResumen: ${n('OK')} OK · ${n('ROTA')} ROTA (con clientes) · ${n('INCOMPLETA')} incompletas (en catálogo, sin clientes) · ${n('SIN_CATALOGO')} funcionan pero faltan en el catálogo · ${n('SIN_USO')} sin uso fuera del catálogo.`);
    const ajenas = catalogo.filter((c) => c.oltId == null && c.vlan > 0 && !l.vlans.some((v) => v.vlan === c.vlan));
    if (ajenas.length) console.log(`Catálogo heredado sin OLT que esta OLT no tiene (no se juzga aquí): ${[...new Set(ajenas.map((c) => c.vlan))].join(', ')}.`);
  }
}

main().finally(() => prisma.$disconnect());
