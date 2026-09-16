/**
 * Los AJUSTES DE PLAN hechos en el legacy que la corrida de este sistema pisó.
 *
 * Allá el plan de un abonado vive en la cabecera (`combo`/`television`/`puntos`) de su
 * última factura RECURRENTE, y se ajusta editándola ("Editar Factura" ▸ ASIGNAR SERVICIO)
 * o cerrando una orden (Subir/Bajar megas, Migración, Agregar TV/Internet, Toma
 * adicional). La corrida del legacy lee esa cabecera y cobra el mes siguiente con ella.
 *
 * Desde agosto factura ESTE sistema, y lo hace desde `SubscriberService`, que esos ajustes
 * no tocaban. La corrida del 01-09-2026 cobró el plan viejo y además estampó ese plan
 * viejo en la cabecera de la factura de septiembre, que es la que ahora "dicta" en los
 * dos lados: el ajuste quedó borrado también en el legacy. `syncPlanDesdeCabecera` ya no
 * puede verlo, porque sólo mira la última recurrente.
 *
 * Aquí se lee la cabecera ANTERIOR a la corrida (`--mes`, por defecto 2026-09) tal como
 * está hoy en el legacy, se compara con lo que factura este sistema y se aplica sólo lo
 * que tiene PRUEBA en el legacy desde `--desde`:
 *   · una edición de esa misma factura en `historial_crm` que deja ese valor, o
 *   · una orden RESUELTA del tipo que mueve ese servicio.
 * No se aplica si la ficha de aquí cambió DESPUÉS de la prueba (alguien lo corrigió aquí),
 * ni si la orden de megas llevaba un destino y la ficha ya lo tiene.
 *
 * Aplicar = `FacturasService.asignarServicio` (el mismo "Servicio asignado" de la
 * factura): plan a tarifa de catálogo en la ficha + cabecera de la recurrente vigente
 * marcada para que viaje al legacy. Sin tocar el router (`pushRouter: false`: allá la
 * red ya se movió al cerrar la orden) y SIN repreciar ninguna factura emitida: lo ya
 * cobrado en septiembre sale en el informe, para decidirlo aparte.
 *
 *   npx ts-node --transpile-only scripts/conciliar-ajustes-legacy.ts [--desde=2026-07-01] [--mes=2026-09] [--csv=ruta]
 *   npx ts-node --transpile-only scripts/conciliar-ajustes-legacy.ts --aplicar
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

for (const linea of (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n'); } catch { return []; } })()) {
  const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import * as mysql from 'mysql2/promise';
import { PrismaService } from '../src/prisma/prisma.service';
import { facturasService } from '../src/core/contenedor';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { leerColumna, armarCatalogo } = require('./lib/plan-cabecera');

const arg = (n: string, d: string) =>
  (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const DESDE = arg('desde', '2026-07-01');
const MES = arg('mes', '2026-09');
const CSV = arg('csv', '');
const APLICAR = process.argv.includes('--aplicar');
const MES_INICIO = `${MES}-01`;

type Kind = 'INTERNET' | 'TV' | 'PUNTOS';
const clave = (s: unknown) => String(s ?? '').trim().toLowerCase();
const letras = (s: unknown) => clave(s).replace(/[^a-z0-9]/g, '');
const dia = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

/** Órdenes del legacy que mueven cada servicio de la cabecera (`Tickets.php`). */
const ORDENES: Record<Kind, string[]> = {
  // Agregar o suspender la TV también mueve el internet: pasa de la tarifa sola (FS) a la
  // de combo (F) y al revés (#402: TV agregada, internet seguía a 66.000 en vez de 50.500).
  INTERNET: ['Subir megas', 'Bajar megas', 'Migracion', 'AgregarInternet', 'AgregarTelevision', 'Suspension Television'],
  TV: ['AgregarTelevision', 'Suspension Television'],
  PUNTOS: ['Toma Adicional', 'AgregarTelevision'],
};

interface Prueba { fecha: string; que: string; destino?: string | null }

const megasDe = (nombre: unknown) => Number(String(nombre ?? '').match(/(\d+)\s*megas/i)?.[1] ?? NaN);
/**
 * Una orden de megas sólo prueba el plan si dice a dónde iba y la cabecera va en ese
 * sentido. El legacy escribe `combo` en la factura ATADA a la orden, no en la vigente, y
 * sin destino la cabecera puede ser cualquier cosa (#53388: 'Subir megas' de 100 a 10).
 * Si la prueba incluye una edición de la factura o una migración, manda ésa.
 */
function megasSinSentido(prueba: Prueba[], de: string | null, a: string | undefined) {
  if (prueba.some((p) => !/megas/i.test(p.que))) return false;
  return prueba.some((p) => {
    const destino = p.destino && p.destino !== 'NULL' ? p.destino : null;
    if (!destino) return true;
    const [x, y] = [megasDe(de), megasDe(a)];
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    return /Subir/.test(p.que) ? y < x : /Bajar/.test(p.que) ? y > x : false;
  });
}

async function main() {
  const prisma = new PrismaService();
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });
  console.log(`\n=== Ajustes del legacy desde ${DESDE} contra la corrida de ${MES} · ${APLICAR ? 'APLICAR' : 'SIMULACIÓN'} ===\n`);

  // Los que factura la corrida.
  const subs = await prisma.subscriber.findMany({
    where: { status: { in: ['ACTIVO', 'COMPROMISO'] }, legacyId: { not: null } },
    select: {
      id: true, legacyId: true, abonado: true, status: true, branch: { select: { name: true } },
      services: { select: { id: true, kind: true, planName: true, qty: true, updatedAt: true } },
    },
  });
  const porCsd = new Map(subs.map((s) => [s.legacyId!, s]));
  const csds = [...porCsd.keys()];

  // Cabecera que dictaba ANTES de la corrida: la última recurrente del legacy anterior al
  // mes, saltando afiliaciones y traslados (la misma regla de `generar_facturas_logica`).
  const [cabeceras] = await my.query<mysql.RowDataPacket[]>(
    `SELECT v.csd, v.tid, v.invoicedate, v.television, v.combo, v.puntos
       FROM invoices v
       JOIN (SELECT i.csd, MAX(CONCAT(i.invoicedate, LPAD(i.tid, 10, '0'))) AS k
               FROM invoices i
              WHERE i.tipo_factura = 'Recurrente' AND i.invoicedate < ?
                AND NOT EXISTS (SELECT 1 FROM invoice_items it WHERE it.tid = i.tid
                                 AND (it.product LIKE '%afiliacion%' OR it.product LIKE '%traslado%'))
              GROUP BY i.csd) u
         ON u.csd = v.csd AND CONCAT(v.invoicedate, LPAD(v.tid, 10, '0')) = u.k`,
    [MES_INICIO],
  );
  const cabecera = new Map(cabeceras.filter((c) => porCsd.has(c.csd)).map((c) => [c.csd as number, c]));

  // Pruebas: ediciones de la factura (el JSON de la cabecera que quedó) y órdenes resueltas.
  const [ediciones] = await my.query<mysql.RowDataPacket[]>(
    `SELECT h.fecha, h.id_fila AS tid, h.descripcion, u.username
       FROM historial_crm h LEFT JOIN aauth_users u ON u.id = h.id_usuario
      WHERE h.fecha >= ? AND h.accion = 'Editar Factura {update}' AND h.tabla = 'invoices'`,
    [DESDE],
  );
  const edicionesPorTid = new Map<number, { fecha: string; quien: string; h: Record<string, unknown> }[]>();
  for (const e of ediciones) {
    let h: Record<string, unknown>;
    try { h = JSON.parse(e.descripcion); } catch { continue; }
    const arr = edicionesPorTid.get(Number(e.tid)) ?? [];
    arr.push({ fecha: String(e.fecha), quien: e.username ?? '?', h });
    edicionesPorTid.set(Number(e.tid), arr);
  }
  const tipos = [...new Set(Object.values(ORDENES).flat())];
  const [ordenes] = await my.query<mysql.RowDataPacket[]>(
    `SELECT t.cid, t.codigo, t.detalle, t.fecha_final,
            (SELECT tm.internet FROM temporales tm WHERE tm.corden = t.codigo LIMIT 1) AS destino
       FROM tickets t
      WHERE t.status = 'Resuelto' AND t.fecha_final >= ? AND t.detalle IN (?)`,
    [DESDE, tipos],
  );
  const ordenesPorCsd = new Map<number, mysql.RowDataPacket[]>();
  for (const o of ordenes) {
    const arr = ordenesPorCsd.get(o.cid) ?? [];
    arr.push(o);
    ordenesPorCsd.set(o.cid, arr);
  }

  // Lo que se cobró en el mes de la corrida.
  const facturasMes = await prisma.subInvoice.findMany({
    where: { kind: 'RECURRENTE', invoiceDate: new Date(`${MES_INICIO}T00:00:00Z`), subscriberId: { in: subs.map((s) => s.id) } },
    select: {
      id: true, tid: true, subscriberId: true, status: true, total: true, paidAmount: true, eInvoiceFlag: true,
      items: { select: { productName: true, qty: true, price: true, taxTotal: true } },
    },
  });
  const facturaDelMes = new Map(facturasMes.map((f) => [f.subscriberId, f]));

  const catalogo: Map<string, { id: string; name: string; price: unknown; taxRate: unknown }> = armarCatalogo(
    await prisma.plan.findMany({ select: { id: true, kind: true, name: true, price: true, taxRate: true, megas: true } }),
  );

  type Fila = Record<string, string | number | null>;
  const informe: Fila[] = [];
  const cuenta: Record<string, number> = {};
  const contar = (k: string) => { cuenta[k] = (cuenta[k] ?? 0) + 1; };

  for (const csd of csds) {
    const s = porCsd.get(csd)!;
    const cab = cabecera.get(csd);
    const fm = facturaDelMes.get(s.id);
    if (!cab || !fm) continue;

    // Lo que factura este sistema: las filas propias o, sin ellas, lo que se cobró.
    const propio = (kind: Kind) => s.services.find((x) => x.kind === kind);
    const derivado = !s.services.some((x) => x.kind !== 'PUNTOS');
    const cobrado = (kind: Kind) => fm.items.find((it) => {
      const n = clave(it.productName);
      if (kind === 'PUNTOS') return n.includes('punto');
      if (kind === 'TV') return n.includes('television') || n.startsWith('tv');
      return n.includes('mega');
    });
    const actual = (kind: Kind): string | null => {
      if (kind === 'PUNTOS') return String(propio('PUNTOS')?.qty ?? (derivado ? Number(cobrado('PUNTOS')?.qty ?? 0) : 0));
      return (derivado ? cobrado(kind)?.productName : propio(kind)?.planName)?.trim() ?? null;
    };

    // Lo que dice la cabecera del legacy.
    const quiere = (kind: Kind): { que: 'nada' | 'quitar' | 'plan'; nombre?: string; puntos?: number } => {
      if (kind === 'PUNTOS') {
        const p = String(cab.puntos ?? '').trim();
        return /^\d+$/.test(p) ? { que: 'plan', puntos: Number(p) } : { que: 'nada' };
      }
      return leerColumna(kind, kind === 'TV' ? cab.television : cab.combo);
    };
    const igual = (kind: Kind) => {
      const q = quiere(kind);
      const a = actual(kind);
      if (q.que === 'nada') return true;
      if (kind === 'PUNTOS') return Number(a ?? 0) === q.puntos;
      if (q.que === 'quitar') return !a;
      return clave(a) === clave(q.nombre);
    };

    const kinds = (['INTERNET', 'TV', 'PUNTOS'] as Kind[]).filter((k) => !igual(k));
    if (!kinds.length) continue;

    const dto: { internet?: string; tv?: string; puntos?: number } = {};
    const cambios: string[] = [];
    const pendientes: string[] = [];
    const pruebas: string[] = [];

    for (const kind of kinds) {
      const q = quiere(kind);
      const col = kind === 'INTERNET' ? 'combo' : kind === 'TV' ? 'television' : 'puntos';
      const valorCab = kind === 'PUNTOS' ? q.puntos : q.que === 'quitar' ? 'no' : q.nombre;
      const texto = `${kind === 'INTERNET' ? 'Internet' : kind === 'TV' ? 'TV' : 'Puntos'}: ${actual(kind) ?? 'ninguno'} → ${valorCab}`;

      const prueba: Prueba[] = [];
      for (const e of edicionesPorTid.get(Number(cab.tid)) ?? []) {
        const v = e.h[col];
        const coincide = kind === 'PUNTOS' ? Number(v || 0) === q.puntos : clave(v) === clave(cab[col]);
        if (coincide) prueba.push({ fecha: e.fecha, que: `Editar factura #${cab.tid} (${e.quien})` });
      }
      let destinoOrden: string | null = null;
      for (const o of ordenesPorCsd.get(csd) ?? []) {
        if (!ORDENES[kind].includes(o.detalle)) continue;
        // La suspensión sólo prueba la TV QUITADA: allá deja el nombre del plan en la
        // cabecera y la marca en `estado_tv`, así que no puede probar que se agregó.
        if (o.detalle === 'Suspension Television' && leerColumna('TV', cab.television).que !== 'quitar') continue;
        prueba.push({ fecha: dia(o.fecha_final), que: `Orden ${o.detalle} #${o.codigo}`, destino: o.destino });
        if (kind === 'INTERNET' && o.destino && clave(o.destino) !== 'null') destinoOrden = String(o.destino);
      }
      prueba.sort((a, b) => a.fecha.localeCompare(b.fecha));
      const ultima = prueba[prueba.length - 1];
      if (ultima) pruebas.push(`${kind}: ${prueba.map((p) => `${p.que} ${p.fecha.slice(0, 10)}${p.destino ? ` → ${p.destino}` : ''}`).join(' | ')}`);

      // Motivos para NO aplicarlo y dejarlo a revisión.
      const fila = propio(kind);
      let motivo: string | null = null;
      if (!ultima) motivo = 'sin prueba en el legacy';
      // El mismo día cuenta como "después": la orden cerrada aquí también sella la ficha.
      else if (fila && dia(fila.updatedAt) >= ultima.fecha.slice(0, 10)) motivo = `la ficha de aquí cambió después (${dia(fila.updatedAt)})`;
      else if (kind === 'INTERNET' && megasSinSentido(prueba, actual(kind), q.nombre)) motivo = 'orden de megas sin destino o en sentido contrario';
      else if (destinoOrden && letras(destinoOrden) === letras(actual(kind))) motivo = `la ficha ya tiene el destino de la orden (${destinoOrden})`;
      else if (destinoOrden && q.que === 'plan' && letras(destinoOrden) !== letras(q.nombre)) motivo = `la orden decía ${destinoOrden} y la cabecera ${q.nombre}`;
      else if (derivado && kind !== 'PUNTOS' && kinds.some((k) => k !== 'PUNTOS') && (['INTERNET', 'TV'] as Kind[]).some((k) => quiere(k).que === 'nada')) {
        motivo = 'plan derivado y la cabecera no dice los dos servicios';
      }

      let valor: string | number | undefined;
      if (!motivo) {
        if (kind === 'PUNTOS') valor = q.puntos;
        else if (q.que === 'quitar') valor = 'no';
        else {
          const plan = catalogo.get(`${kind}|${clave(q.nombre)}`);
          if (!plan) motivo = `'${q.nombre}' no está en el catálogo`;
          else valor = plan.id;
        }
      }
      if (motivo) { pendientes.push(`${texto} (${motivo})`); contar(`revisar: ${motivo.replace(/\(.*\)|'.*'|\d{4}-\d\d-\d\d|la orden decía .*/, '…')}`); continue; }
      if (kind === 'INTERNET') dto.internet = valor as string;
      else if (kind === 'TV') dto.tv = valor as string;
      else dto.puntos = valor as number;
      cambios.push(texto);
      contar(`aplicable: ${kind}`);
    }

    // A un abonado DERIVADO hay que registrarle los dos servicios a la vez: si sólo se le
    // crea la fila de internet, el snapshot de `asignarServicio` escribe 'no' en su TV.
    if (derivado && (dto.internet !== undefined || dto.tv !== undefined)) {
      for (const k of ['INTERNET', 'TV'] as const) {
        const campo = k === 'INTERNET' ? 'internet' : 'tv';
        if (dto[campo] !== undefined) continue;
        const q = quiere(k);
        if (q.que === 'quitar') dto[campo] = 'no';
        else if (q.que === 'plan') {
          const plan = catalogo.get(`${k}|${clave(q.nombre)}`);
          if (plan) dto[campo] = plan.id;
        }
      }
      if (quiere('INTERNET').que === 'plan' && !dto.internet || quiere('TV').que === 'plan' && !dto.tv) {
        pendientes.push('plan derivado con un servicio fuera del catálogo');
        cambios.length = 0;
        delete dto.internet; delete dto.tv;
      }
    }

    // Lo que la factura del mes cobró de más o de menos respecto de la cabecera.
    const cobro = fm.items.map((it) => `${it.productName} ${it.qty}×${Number(it.price) + Number(it.taxTotal ?? 0) / (it.qty || 1)}`).join('; ');

    let resultado = cambios.length ? (APLICAR ? 'aplicado' : 'se aplicaría') : 'a revisar';
    if (APLICAR && cambios.length) {
      try {
        await facturasService.asignarServicio(fm.id, {
          ...dto, pushRouter: false,
          reason: `Ajuste del legacy no aplicado por la corrida de ${MES} (${pruebas.join(' / ').slice(0, 400)})`,
        } as never, { id: 'conciliacion', email: 'conciliacion@saves', name: 'Conciliación ajustes legacy', roles: ['SYSTEM_ADMIN'], permissions: ['*'], sedes: [] } as never);
      } catch (e) {
        resultado = `ERROR: ${(e as Error).message}`;
      }
    }

    informe.push({
      sede: s.branch?.name ?? '', abonado: s.abonado, estado: s.status, resultado,
      cambios: cambios.join('; '), revisar: pendientes.join('; '), pruebas: pruebas.join(' / '),
      cabecera_legacy: `#${cab.tid} ${dia(cab.invoicedate)} · tv=${cab.television} · internet=${cab.combo} · puntos=${cab.puntos}`,
      factura_mes: fm.tid, factura_estado: fm.status, factura_total: Number(fm.total), factura_pagado: Number(fm.paidAmount),
      factura_electronica: fm.eInvoiceFlag ?? '', factura_cobro: cobro,
    });
  }

  informe.sort((a, b) => String(a.sede).localeCompare(String(b.sede)) || Number(a.abonado) - Number(b.abonado));
  const porSede: Record<string, { aplicar: number; revisar: number }> = {};
  for (const f of informe) {
    const k = String(f.sede || 'Sin sede');
    porSede[k] ??= { aplicar: 0, revisar: 0 };
    if (f.cambios) porSede[k].aplicar++; else porSede[k].revisar++;
  }
  console.table(porSede);
  console.log(cuenta);
  for (const f of informe.filter((x) => x.cambios).slice(0, 15)) console.log(`${f.sede} ${f.abonado}: ${f.cambios} ${f.resultado !== 'se aplicaría' ? `[${f.resultado}]` : ''}`);

  if (CSV) {
    const cols = Object.keys(informe[0] ?? { sede: '' });
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(CSV, [cols.join(','), ...informe.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\n'));
    console.log(`\ninforme: ${CSV} (${informe.length} abonados)`);
  }
  await my.end();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
