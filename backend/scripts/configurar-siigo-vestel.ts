/**
 * Carga en la cuenta Siigo el mapeo DIAN REAL con el que Vestel factura hoy en el legacy.
 *
 * Los ids no son inventados: salen de los catálogos de Siigo de la empresa
 * (GET /v1/document-types, /cost-centers, /taxes, /payment-types, /users) y están
 * verificados contra facturas ya timbradas (p. ej. FV-3-192657, seller 945, cc 69).
 *
 *   npx tsx scripts/configurar-siigo-vestel.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Sedes: clave = Branch.legacyId (= customers.gid del legacy).
// Centros de costo de Siigo: YOPAL 69 (Y01-1), VILLANUEVA 167 (V01-1), MONTERREY 165 (M01-1).
// Las sedes sin centro propio caen al default (Yopal), igual que en el legacy.
const CENTROS_COSTO = { '2': 69, '3': 167, '4': 165, default: 69 };

// Ciudad DIAN del tercero por sede (el legacy la ramificaba con ifs sobre `customers.gid`).
const CIUDADES = {
  '2': { country_code: 'Co', state_code: '85', city_code: '85001' }, // Yopal
  '3': { country_code: 'Co', state_code: '85', city_code: '85440' }, // Villanueva
  '4': { country_code: 'Co', state_code: '85', city_code: '85162' }, // Monterrey
  '5': { country_code: 'Co', state_code: '86', city_code: '86001' }, // Mocoa
  default: { country_code: 'Co', state_code: '85', city_code: '85001' },
};

async function main() {
  // La cuenta que emite es la de Internet (VesgaTelecomunicaciones SAS): en el legacy el
  // documento siempre sale con el token de `config_facturacion_electronica` id=2.
  const emisora = await prisma.siigoAccount.findFirst({ where: { legacyId: 2 } });
  if (!emisora) throw new Error('No existe la cuenta Siigo legacyId=2 (Internet).');

  await prisma.siigoAccount.update({
    where: { id: emisora.id },
    data: {
      companyName: 'VesgaTelecomunicaciones SAS',
      documentId: 27274, // Factura electrónica de venta (FV código 3)
      creditNoteDocumentId: 10920, // Nota Crédito electrónica (NC código 1)
      sellerId: 945, // vendedor de la factura
      customerSellerId: 945, // el legacy creaba el tercero con el 282, hoy INACTIVO en Siigo
      ivaTaxId: 5869, // IVA 19%
      paymentCash: 2512, // Efectivo
      paymentCredIt: null, // el legacy vivo nunca factura a crédito
      contactEmail: 'vestelsas@gmail.com',
      costCenterByBranch: CENTROS_COSTO,
      cityByBranch: CIUDADES,
      active: true,
    },
  });

  // La cuenta de TV queda de vestigio: en el legacy su bloque está comentado y no emite.
  // Se desactiva para que nadie la elija por error.
  await prisma.siigoAccount.updateMany({
    where: { legacyId: 1 },
    data: { companyName: 'VesgaTelevision SAS (no emite)', active: false },
  });

  const fin = await prisma.siigoAccount.findMany({ orderBy: { legacyId: 'asc' } });
  for (const a of fin) {
    console.log(`#${a.legacyId} ${a.role} activa=${a.active} doc=${a.documentId} nc=${a.creditNoteDocumentId} seller=${a.sellerId} iva=${a.ivaTaxId} pago=${a.paymentCash}`);
  }
}

main().finally(() => prisma.$disconnect());
