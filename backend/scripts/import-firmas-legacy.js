/**
 * Trae al stack nuevo las firmas y huellas de contrato que el legacy guardaba en
 * disco (`assets/firmas_digitales`, `assets/huellas_digitales`).
 *
 * OJO con lo que hay realmente en esa carpeta: de los 7.258 PNG, solo los que se
 * llaman `<customers.id>.png` son firmas DE CONTRATO (175). Los 7.083 `orden_*.png`
 * son firmas de recibido de una ORDEN DE SERVICIO —el legacy las guarda en la misma
 * carpeta con `type=orden` y el número es `tickets.codigo`, no un cliente—. Este
 * script importa solo las de contrato: meter las de órdenes como firma del contrato
 * pondría en un documento legal una firma que se dio para otra cosa.
 *
 * El flag `customers.firma_digital` NO se toca en los que no tienen archivo: hay
 * 7.873 marcados y solo 175 PNG, así que el flag miente y corregirlo aquí lo
 * devolvería al legacy por el writeback. La ficha lo muestra como "firmado en el
 * legacy, sin archivo".
 *
 * Idempotente: vuelve a copiar solo lo que falte.
 *
 *   node scripts/import-firmas-legacy.js [--dry-run] [--src=/ruta/al/legacy]
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const SRC = (args.find((a) => a.startsWith('--src=')) || '').split('=')[1]
  || '/var/www/vhosts/saves.com.co/httpdocs/saves-vestel';
const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'subscribers');

const DIR_FIRMAS = path.join(SRC, 'assets', 'firmas_digitales');
const DIR_HUELLAS = path.join(SRC, 'assets', 'huellas_digitales');

/** Un PNG de verdad empieza por \x89PNG\r\n\x1a\n. */
function esPng(abs) {
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  return buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

(async () => {
  for (const d of [DIR_FIRMAS, DIR_HUELLAS]) {
    if (!fs.existsSync(d)) {
      console.error(`No existe ${d}. Pasa --src=/ruta/al/legacy`);
      process.exit(1);
    }
  }

  // legacyId → id de Subscriber
  const subs = await p.subscriber.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true, signaturePath: true, fingerprintPath: true },
  });
  const porLegacy = new Map(subs.map((s) => [s.legacyId, s]));

  const trabajos = [];

  for (const f of fs.readdirSync(DIR_FIRMAS)) {
    const m = /^(\d+)\.png$/.exec(f);
    if (!m) continue; // orden_*.png → firma de orden de servicio, no de contrato
    trabajos.push({ tipo: 'firma', legacyId: Number(m[1]), origen: path.join(DIR_FIRMAS, f), destino: 'firma-legacy.png' });
  }
  for (const f of fs.readdirSync(DIR_HUELLAS)) {
    const m = /^Huella_CUS_(\d+)\.png$/.exec(f);
    if (!m) continue;
    trabajos.push({ tipo: 'huella', legacyId: Number(m[1]), origen: path.join(DIR_HUELLAS, f), destino: 'huella-legacy.png' });
  }

  const res = { firma: 0, huella: 0, yaEstaban: 0, sinCliente: [], noPng: [] };

  for (const t of trabajos) {
    const sub = porLegacy.get(t.legacyId);
    if (!sub) { res.sinCliente.push(`${t.tipo}:${t.legacyId}`); continue; }
    if (!esPng(t.origen)) { res.noPng.push(t.origen); continue; }

    const abs = path.join(UPLOAD_ROOT, sub.id, t.destino);
    const yaRegistrado = t.tipo === 'firma' ? sub.signaturePath === t.destino : sub.fingerprintPath === t.destino;
    if (yaRegistrado && fs.existsSync(abs)) { res.yaEstaban++; continue; }

    if (!DRY) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(t.origen, abs);
      const cuando = fs.statSync(t.origen).mtime;
      await p.subscriber.update({
        where: { id: sub.id },
        data: t.tipo === 'firma'
          ? { signaturePath: t.destino, signatureAt: cuando, signatureBy: 'Importado del legacy', digitalSignature: true }
          : { fingerprintPath: t.destino, fingerprintAt: cuando },
      });
    }
    res[t.tipo]++;
  }

  // Cuántos siguen con el flag del legacy pero sin archivo (los que "firmaron" allá
  // y cuyo PNG no existe en ninguna parte).
  const flagSinArchivo = await p.subscriber.count({ where: { digitalSignature: true, signaturePath: null } });

  console.log(`${DRY ? '[SECO] ' : ''}Firmas importadas: ${res.firma} · Huellas: ${res.huella} · ya estaban: ${res.yaEstaban}`);
  if (res.sinCliente.length) console.log(`  ⚠ ${res.sinCliente.length} archivos sin cliente en PG: ${res.sinCliente.slice(0, 10).join(', ')}${res.sinCliente.length > 10 ? '…' : ''}`);
  if (res.noPng.length) console.log(`  ⚠ ${res.noPng.length} archivos que no son PNG (omitidos)`);
  console.log(`  ${flagSinArchivo} abonados marcados como firmados en el legacy SIN archivo de firma.`);

  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
