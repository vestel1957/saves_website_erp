#!/usr/bin/env node
/**
 * Copia las fotos de perfil del legacy a `uploads/staff/photos/`.
 *
 * En el legacy la foto vivía en `userfiles/employee/<archivo>` y el nombre
 * quedaba guardado en `employee_profile.picture`, que la migración trajo tal
 * cual a `Staff.picture`. O sea: los nombres ya casan; lo único que faltaba era
 * mover los binarios. Se copian con el MISMO nombre para no tener que reescribir
 * la columna.
 *
 * Idempotente: lo ya copiado se salta. No borra nada del origen.
 *
 *   node scripts/import-fotos-empleados.js /ruta/al/legacy/userfiles/employee
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('node:fs');
const { basename, join } = require('node:path');

const origen = process.argv[2];
if (!origen) {
  console.error('Uso: node scripts/import-fotos-empleados.js <dir userfiles/employee>');
  process.exit(1);
}
if (!existsSync(origen)) {
  console.error(`No existe el directorio de origen: ${origen}`);
  process.exit(1);
}

const destino = join(process.cwd(), 'uploads', 'staff', 'photos');
mkdirSync(destino, { recursive: true });

// Sólo imágenes con nombre "sano": el mismo criterio con el que el backend
// decide si se atreve a servir el archivo (ver ProfileService.fotoSegura).
const EXTENSIONES = /\.(jpe?g|png|gif|webp)$/i;

let copiadas = 0;
let existentes = 0;
let saltadas = 0;

for (const entrada of readdirSync(origen)) {
  const nombre = basename(entrada);
  if (nombre !== entrada || !EXTENSIONES.test(nombre) || !/^[A-Za-z0-9._-]+$/.test(nombre)) {
    saltadas++;
    continue;
  }
  const src = join(origen, nombre);
  if (!statSync(src).isFile()) { saltadas++; continue; }
  const dst = join(destino, nombre);
  if (existsSync(dst)) { existentes++; continue; }
  copyFileSync(src, dst);
  copiadas++;
}

console.log(`Fotos copiadas: ${copiadas} · ya estaban: ${existentes} · omitidas: ${saltadas}`);
console.log(`Destino: ${destino}`);
