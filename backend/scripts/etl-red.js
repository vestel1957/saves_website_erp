/** ETL Red/ISP: vestel_dev (MariaDB) -> saves_vestel (Postgres). Idempotente. */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const MY = { host: '127.0.0.1', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev', dateStrings: true };
const log = (...a) => console.log(...a);
const dOnly = (s) => { const t = String(s || '').slice(0, 10); if (!t || t === '0000-00-00') return null; const d = new Date(t + 'T00:00:00Z'); return isNaN(d) ? null : d; };
const dTime = (s) => { const t = String(s || ''); if (!t || t.startsWith('0000-00-00')) return null; const d = new Date(t.replace(' ', 'T') + 'Z'); return isNaN(d) ? null : d; };
const bool = (v) => v === 1 || v === '1';
const intOrNull = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

async function insb(model, rows, chunk = 3000) {
  for (let i = 0; i < rows.length; i += chunk) await prisma[model].createMany({ data: rows.slice(i, i + chunk), skipDuplicates: true });
  return rows.length;
}

(async () => {
  const my = await mysql.createConnection(MY);
  log('Conectado. Limpiando tablas Red…');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "EquipmentTransferItem","EquipmentTransfer","Equipment","EquipmentWarehouse",
    "GenieacsConnection","IpUserMk","Port","Nap","Vlan","OltOnu","Olt","Mikrotik" RESTART IDENTITY CASCADE`);

  // mapas base
  const branch = new Map(); for (const b of await prisma.branch.findMany({ select: { id: true, legacyId: true } })) branch.set(b.legacyId, b.id);
  const sub = new Map(); for (const s of await prisma.subscriber.findMany({ select: { id: true, legacyId: true } })) sub.set(s.legacyId, s.id);
  const bid = (gid) => branch.get(Number(gid)) || null;

  // OJO con `sede` en naps/vlans/puertos: NO es customers_group (los clientes) sino
  // `almacen_equipos` (las bodegas) — así lo resuelve el legacy:
  //   Redes_model.php:250  join('almacen_equipos', 'almacen_equipos.id = naps.sede')
  // Los dos catálogos se parecen (Yopal es 2 en uno y 4 en el otro), y por leerlos con
  // bid() las 1.406 cajas quedaron cada una en la sede de al lado. Se arregló con
  // `prisma/migrate-sede-naps-almacen-2026-09.ts`; aquí se lee ya por bodega (rid()).
  // La sede de la bodega sale de su nombre, igual que en
  // `prisma/migrate-bodegas-equipos-sede-2026-07.ts`: "Almacen cabecera Yopal",
  // "CABECERA YOPAL" y "Yopal" son todas Yopal. "Depurados" no es una sede.
  const sedes = await prisma.branch.findMany({ select: { legacyId: true, name: true } });
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const sedeDeBodega = (nombre) => {
    const n = norm(nombre);
    if (n === 'depurados') return null;
    return sedes.find((x) => n.includes(norm(x.name)))?.legacyId ?? null;
  };

  // Mikrotik
  let [r] = await my.query('SELECT * FROM mikrotiks');
  await insb('mikrotik', r.map((x) => ({ legacyId: x.id, name: x.nombre, ip: x.ip, port: String(x.puerto), tech: x.tegnologia, branchId: bid(x.sede), sedeLegacy: x.sede, username: x.usuario, password: x.password, isDefault: bool(x.defecto), online: bool(x.estado_coneccion) })));
  log('Mikrotik', r.length);

  // Olt + mapa
  [r] = await my.query('SELECT * FROM olts');
  await insb('olt', r.map((x) => ({ legacyId: x.id, name: x.nombre, brand: x.marca, ip: x.ip, port: String(x.puerto), tech: x.tegnologia, branchId: bid(x.sede), sedeLegacy: x.sede, username: x.usuario, password: x.password, isDefault: bool(x.defecto), online: bool(x.estado_coneccion), defaultLineProfile: x.default_lineprofile, defaultSrvProfile: x.default_srvprofile, defaultVlan: x.default_vlan, defaultGemport: x.default_gemport, defaultUserVlan: x.default_user_vlan })));
  const olt = new Map(); for (const o of await prisma.olt.findMany({ select: { id: true, legacyId: true } })) olt.set(o.legacyId, o.id);
  log('Olt', r.length);

  // OltOnu
  [r] = await my.query('SELECT * FROM olt_onus');
  await insb('oltOnu', r.filter((x) => olt.has(x.olt_id)).map((x) => ({ legacyId: x.id, oltId: olt.get(x.olt_id), frame: x.frame || 0, slot: x.slot, port: x.port, ontId: x.ont_id, sn: x.sn, description: x.descripcion, runState: x.run_state, configState: x.config_state, matchState: x.match_state, rxPower: x.rx_power, syncState: x.estado_sync || 'presente', subscriberId: sub.get(x.id_cliente) || null, clientName: x.nombre_cliente, firstSeen: dTime(x.first_seen), lastSync: dTime(x.last_sync) })));
  log('OltOnu', r.length);

  // EquipmentWarehouse + mapa (por nombre, ya que equipos.almacen referencia id de almacen_equipos).
  // Va ANTES de vlans/naps/puertos porque su `sede` es el id de ESTA tabla, no el de
  // customers_group (ver `sedeRed` abajo).
  [r] = await my.query('SELECT * FROM almacen_equipos');
  await insb('equipmentWarehouse', r.map((x) => ({ legacyId: x.id, name: x.almacen, description: x.descripcion, branchLegacy: sedeDeBodega(x.almacen) })));
  const wh = new Map(); for (const w of await prisma.equipmentWarehouse.findMany({ select: { id: true, legacyId: true } })) wh.set(w.legacyId, w.id);
  // bodega (almacen_equipos.id) -> sede, para naps/vlans/puertos
  const sedeRed = new Map();
  for (const x of r) { const sl = sedeDeBodega(x.almacen); if (sl != null) sedeRed.set(Number(x.id), branch.get(sl) || null); }
  const rid = (sede) => sedeRed.get(Number(sede)) || null;
  log('EquipmentWarehouse', r.length);

  // Vlan + mapa
  [r] = await my.query('SELECT * FROM vlans');
  await insb('vlan', r.map((x) => ({ legacyId: x.idv, branchId: rid(x.sede), sedeLegacy: x.sede, vlan: x.vlan, olt: x.olt, tray: x.bandeja, oltPort: x.puertolt, detail: x.det_vlan || '' })));
  const vlan = new Map(); for (const v of await prisma.vlan.findMany({ select: { id: true, legacyId: true } })) vlan.set(v.legacyId, v.id);
  log('Vlan', r.length);

  // Nap + mapa
  [r] = await my.query('SELECT * FROM naps');
  await insb('nap', r.map((x) => ({ legacyId: x.idn, branchId: rid(x.sede), sedeLegacy: x.sede, vlanId: vlan.get(x.idvlan) || null, vlanLegacy: x.idvlan, name: x.nap, portCount: x.puertos, address: x.dir_nap, gpsLat: x.coor1, gpsLng: x.coor2 })));
  const nap = new Map(); for (const n of await prisma.nap.findMany({ select: { id: true, legacyId: true } })) nap.set(n.legacyId, n.id);
  log('Nap', r.length);

  // Port
  [r] = await my.query('SELECT * FROM puertos');
  await insb('port', r.map((x) => ({ legacyId: x.idp, sedeLegacy: x.sede, vlanLegacy: x.idvlan, napId: nap.get(x.idnap) || null, napLegacy: x.idnap, port: x.puerto, status: x.estado || '', subscriberId: sub.get(x.asignado) || null, assignedLegacy: x.asignado || 0, detail: x.detalle || '' })));
  log('Port', r.length);

  // IpUserMk
  [r] = await my.query('SELECT * FROM ips_users_mk');
  await insb('ipUserMk', r.map((x) => ({ legacyId: x.id, name: x.nombre, ipLocal: x.ip_local, ipRemote: x.ip_remota, tech: x.tegnologia, sedeLegacy: x.sede, isDefault: bool(x.defecto), profiles: x.perfiles || '' })));
  log('IpUserMk', r.length);

  // GenieacsConnection
  [r] = await my.query('SELECT * FROM genieacs_conections');
  await insb('genieacsConnection', r.map((x) => ({ legacyId: x.id_conexion, name: x.nombre, ipRemote: x.ip_remota, port: x.puerto, branchId: bid(x.sede), sedeLegacy: x.sede, comments: x.comentarios, updatedByUserId: x.id_user_actualiza })));
  log('GenieacsConnection', r.length);

  // Equipment + mapa
  [r] = await my.query('SELECT * FROM equipos');
  await insb('equipment', r.map((x) => ({ legacyId: x.id, code: x.codigo, supplierLegacy: x.proveedor, warehouseId: wh.get(x.almacen) || null, warehouseLegacy: x.almacen, mac: x.mac, serial: x.serial, arrival: dOnly(x.llegada), endDate: dOnly(x.final), brand: x.marca, installType: x.t_instalacion, port: x.puerto, vlan: x.vlan, nat: x.nat, subscriberId: sub.get(Number(x.asignado)) || null, assignedRaw: x.asignado, status: x.estado, observation: x.observacion, master: x.master, image: x.imagen, meters: x.metros, accessories: x.accesorios, genieacsId: x.id_genieacs })));
  const equip = new Map(); for (const e of await prisma.equipment.findMany({ select: { id: true, legacyId: true } })) equip.set(e.legacyId, e.id);
  log('Equipment', r.length);

  // EquipmentTransfer + mapa
  [r] = await my.query('SELECT * FROM transfer_equipos');
  await insb('equipmentTransfer', r.map((x) => ({ legacyId: x.teid, date: dTime(x.fecha) || new Date(0), fromWarehouse: x.almacen_origen, toWarehouse: x.almacen_destino, observations: x.observaciones, userId: x.id_usuario_que_transfiere })));
  const tr = new Map(); for (const t of await prisma.equipmentTransfer.findMany({ select: { id: true, legacyId: true } })) tr.set(t.legacyId, t.id);
  log('EquipmentTransfer', r.length);

  // EquipmentTransferItem
  [r] = await my.query('SELECT * FROM item_transfer_equipos');
  await insb('equipmentTransferItem', r.filter((x) => tr.has(x.id_transfer)).map((x) => ({ legacyId: x.id, transferId: tr.get(x.id_transfer), equipmentId: equip.get(x.id_equipo) || null, equipmentLegacy: x.id_equipo })));
  log('EquipmentTransferItem', r.length);

  await my.end(); await prisma.$disconnect();
  log('ETL RED COMPLETADO ✅');
})().catch((e) => { console.error('ETL RED FALLÓ:', e); process.exit(1); });
