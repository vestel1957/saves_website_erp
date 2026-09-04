/**
 * Dota de MATERIAL la bodega personal del técnico de prueba.
 *
 *   npx ts-node prisma/seed-material-tecnico-prueba.ts
 *
 * Sin esto el perfil de técnico entra a /inventario/bodegas y ve su bodega vacía, y
 * el modal de "material consumido" de una orden no tiene nada que descontar: el
 * recorrido de campo se corta justo donde empieza a ser interesante.
 *
 * El surtido NO es inventado. Cada renglón se copia de un material que ya existe en
 * el catálogo real (mismo `code`, mismo nombre, mismo precio, misma categoría), y
 * son los que de verdad carga un técnico: los que más se repiten en las 35 bodegas
 * personales. Así el perfil de prueba enseña lo que enseña el sistema de verdad y no
 * una maqueta con nombres de mentira.
 *
 * Ojo con el modelo: `Material` NO es un catálogo compartido con existencias por
 * bodega — es UNA FILA POR BODEGA (herencia del legacy). Por eso aquí se CREAN filas
 * nuevas en la bodega del técnico en vez de "moverle" stock a nadie: no se le quita
 * material a ninguna bodega real.
 *
 * Lo suyo, cuando esto sea trabajo de verdad y no una prueba, es que la cajera se lo
 * entregue por un traspaso con su acta (ver /inventario/traspasos). Esto es el atajo
 * para dejar el perfil listo, no el camino normal.
 *
 * Idempotente: si el renglón ya está en su bodega, sólo se le repone la cantidad.
 *
 * Para deshacerlo:
 *   DELETE FROM "Material" WHERE "warehouseId" =
 *     (SELECT id FROM "MaterialWarehouse" WHERE "technicianRef" = 'prueba.tecnico');
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TECNICO_REF = 'prueba.tecnico';

/**
 * El equipo de un técnico para un día de calle: fibra y coaxial por metros,
 * conectores a puñados, y las piezas caras de una en una.
 */
const KIT: { code: string; qty: number }[] = [
  { code: '03100101', qty: 400 }, // Fibra Drop 1 Hilo (metros)
  { code: '03030104', qty: 150 }, // Cable Coaxial Rg6
  { code: '03160105', qty: 60 },  // Herraje de Retención
  { code: '03010109', qty: 50 },  // Amarres Plásticos
  { code: '03080107', qty: 100 }, // Conectores Rg6 Compresión (el legacy también lo llama "PIN 11")
  { code: 'F005', qty: 30 },      // Conector RJ45
  { code: '03080106', qty: 15 },  // Conector Mecánico SC/APC
  { code: '03080109', qty: 10 },  // Conector Mecánico Tipo Caimán
  { code: '03290102', qty: 6 },   // Uniones F-81
  { code: '03230106', qty: 5 },   // Spliter x3 vías Indoor
  { code: '03230105', qty: 5 },   // Spliter x2 vías Indoor
  { code: '03260101', qty: 4 },   // Tap Dc 6
  { code: '03040303', qty: 2 },   // Caja NAP 1:8
  { code: 'Bestcom', qty: 2 },    // ONU Dual Band (para el cambio de equipo)
  { code: 'EQU-008', qty: 1 },    // ONU ZTE con CATV WIFI 6
];

async function main() {
  const bodega = await prisma.materialWarehouse.findFirst({ where: { technicianRef: TECNICO_REF } });
  if (!bodega) throw new Error(`No existe la bodega de "${TECNICO_REF}". Corre antes prisma/seed-tecnico-prueba.ts.`);

  console.log(`📦 ${bodega.title}\n`);
  let creados = 0, repuestos = 0, sinFuente: string[] = [];

  for (const linea of KIT) {
    // Se copia de una bodega CUALQUIERA menos la suya: lo que interesa es la ficha
    // del producto (nombre, precio, categoría), no de dónde sale.
    const fuente = await prisma.material.findFirst({
      where: { code: linea.code, warehouseId: { not: bodega.id } },
      orderBy: { qty: 'desc' },
    });
    if (!fuente) { sinFuente.push(linea.code); continue; }

    const ya = await prisma.material.findFirst({ where: { warehouseId: bodega.id, code: linea.code } });
    if (ya) {
      await prisma.material.update({ where: { id: ya.id }, data: { qty: linea.qty } });
      repuestos++;
      console.log(`   · ${fuente.name.padEnd(38).slice(0, 38)} ${String(linea.qty).padStart(4)}  (repuesto)`);
    } else {
      await prisma.material.create({
        data: {
          warehouseId: bodega.id, name: fuente.name, code: fuente.code,
          categoryId: fuente.categoryId, categoryLegacy: fuente.categoryLegacy,
          price: fuente.price, cost: fuente.cost, taxRate: fuente.taxRate, discRate: fuente.discRate,
          alert: fuente.alert, serviceType: fuente.serviceType, tvOrNet: fuente.tvOrNet,
          branchRef: fuente.branchRef, description: fuente.description,
          qty: linea.qty,
          // `legacyId` y `warehouseLegacy` se quedan en null A PROPÓSITO: esta fila no
          // existe en el legacy y no debe casar con ninguna de allá cuando el sync
          // compare por `legacyId`.
        },
      });
      creados++;
      console.log(`   + ${fuente.name.padEnd(38).slice(0, 38)} ${String(linea.qty).padStart(4)}`);
    }
  }

  const total = await prisma.material.aggregate({
    where: { warehouseId: bodega.id }, _count: true, _sum: { qty: true },
  });
  console.log(`\n✅ ${creados} renglón(es) nuevo(s), ${repuestos} repuesto(s).`);
  console.log(`   La bodega queda con ${total._count} renglones y ${total._sum.qty} unidades.`);
  if (sinFuente.length) console.log(`\n⚠️  Sin fuente en el catálogo (no se crearon): ${sinFuente.join(', ')}`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
