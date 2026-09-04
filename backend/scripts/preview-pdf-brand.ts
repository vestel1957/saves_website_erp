/* eslint-disable */
/**
 * Renderiza los PDF operativos con datos de prueba para revisarlos sin tener que
 * buscar un recibo real en el sistema. No toca la base de datos: arma los datos a
 * mano y llama a las MISMAS funciones que usa la API.
 *
 * Uso: cd backend && TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *        npx ts-node --transpile-only scripts/preview-pdf-brand.ts [carpeta]
 */
import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import { cashClosePdf, receiptPdf, serviceOrderPdf, purchaseOrderPdf } from '../src/common/pdf/pdf-docs';
import { invoicePdf } from '../src/billing/billing-pdf';
import { statementPdf, pazYSalvoPdf } from '../src/subscribers/subscriber-pdf';

const OUT = process.argv[2] || '/tmp/preview-pdf';
mkdirSync(OUT, { recursive: true });

/** pdfkit solo necesita un destino escribible; el tipo Response es de más. */
const salida = (nombre: string) => createWriteStream(join(OUT, nombre)) as any;

const B = (cantidad: number, monto: number) => ({ cantidad, monto });

receiptPdf(salida('1-recibo.pdf'), {
  number: '000482',
  date: new Date(),
  cashier: 'Luisa Ardila',
  method: 'Efectivo',
  subscriber: { name: 'Ana Lucia Perez Rojas', abonado: 10482, docNumber: 'CC 1.098.554.221' },
  items: [
    { tid: 84120, concept: 'Mensualidad Internet 300 Megas — julio 2026', amount: 79000 },
    { tid: 84121, concept: 'Television — julio 2026', amount: 25000 },
    { tid: 84122, concept: 'Reconexion de servicio', amount: 12000 },
  ],
  total: 116000,
});

invoicePdf(salida('2-factura.pdf'), {
  tid: 84120, kind: 'Venta', status: 'PENDIENTE',
  date: new Date(), dueDate: new Date(Date.now() + 6048e5),
  period: 'julio de 2026',
  subtotal: 87395, tax: 16605, discount: 0, total: 104000, paid: 25000, balance: 79000,
  paymentMethod: 'Efectivo',
  subscriber: {
    name: 'Ana Lucia Perez Rojas', abonado: 10482, docType: 'CC', docNumber: '1.098.554.221',
    email: 'cliente@ejemplo.com', phone: '320 555 1234', branch: 'Yopal',
  },
  items: [
    { product: 'Plan Internet 300 Megas', description: 'Mensualidad julio 2026', qty: 1, price: 66387, taxRate: 19, subtotal: 66387, taxTotal: 12613 },
    { product: 'Television', description: 'Mensualidad julio 2026', qty: 1, price: 21008, taxRate: 19, subtotal: 21008, taxTotal: 3992 },
  ],
  payments: [{ date: new Date(), amount: 25000, method: 'Efectivo', status: 'APLICADO' }],
});

serviceOrderPdf(salida('3-orden-servicio.pdf'), {
  code: '319534', type: 'servicio', subject: 'Reconexion Television',
  status: 'FINALIZADA', priority: 'Media',
  created: new Date(), finalDate: new Date(),
  technician: 'Luiz Barrera',
  generadaPor: 'Sonia Marcela Rojas',
  traslado: null,
  problem: 'El cliente reporta que la television no da senal desde el corte por mora. Se verifica el puerto CATV en la ONT y se restablece el servicio.',
  section: 'Se deja funcionando y se explica al cliente la fecha de pago.',
  subscriber: {
    name: 'Marta Elena Ruiz Duarte', doc: 'CC 63.552.114', abonado: 10482, phone: '320 555 1234',
    address: 'Calle 7 Sur # 22-18', barrio: 'Centro', branch: 'Villanueva',
    services: 'Internet 300 Megas + Television', debt: 79000,
  },
  equipment: [{ mac: 'AC:67:B2:11:04:9E', installType: 'Fibra', port: 3, vlan: 120, nat: 1, serial: 'HWTC8A2B41C7' }],
  materials: [
    { name: 'Conector rapido SC/APC', qty: 2, price: 3200, total: 6400 },
    { name: 'Patchcord 3 m SC/APC', qty: 1, price: 8500, total: 8500 },
  ],
  threads: [
    { message: 'Se agenda visita para la tarde.', date: new Date(), hasPhoto: false },
    { message: 'Servicio restablecido, cliente conforme.', date: new Date(), hasPhoto: true },
  ],
  signature: { name: 'Marta Elena Ruiz Duarte', cc: '63.552.114', rel: 'Titular' },
});

purchaseOrderPdf(salida('4-orden-compra.pdf'), {
  tid: 1042, kind: 'compra', status: 'APROBADA',
  date: new Date(), dueDate: new Date(Date.now() + 12096e5),
  branchRef: 'Yopal', categoryRef: 'Material de red',
  notes: 'Entrega en bodega principal. El proveedor debe adjuntar certificado de calidad del cable ADSS.',
  supplier: { name: 'DISTRIBUIDORA DE FIBRA OPTICA S.A.S', nit: '900.221.554-3', phone: '(607) 645 22 10' },
  items: [
    { product: 'Cable ADSS fibra optica 12 hilos (rollo 2 km)', qty: 4, price: 1850000, taxRate: 19, subtotal: 7400000, taxTotal: 1406000 },
    { product: 'Conector rapido SC/APC', qty: 200, price: 3200, taxRate: 19, subtotal: 640000, taxTotal: 121600 },
    { product: 'NAP 8 puertos exterior IP65', qty: 12, price: 145000, taxRate: 19, subtotal: 1740000, taxTotal: 330600 },
  ],
  noteLines: [{ type: 'Descuento comercial', description: 'Volumen', amount: -180000 }],
  subtotal: 9780000, tax: 1858200, total: 11458200, paid: 0, balance: 11458200,
  createdByName: 'Jhon Vesga', firstBy: 'Carolina Vesga', secondBy: 'Gerencia',
});

// El contrato y su anexo se pintan con la vista del legacy (mPDF), no con este
// kit: para verlos, `php contrato-php/render.php contrato datos.json salida.pdf`.

const cero = B(0, 0);
cashClosePdf(salida('6-cierre-caja.pdf'), {
  informe: {
    cobranza: { excento: B(12, 300000), base: B(40, 2800000), iva: B(0, 532000), total: B(52, 3632000) },
    porBanco: [{ nombre: 'Bancolombia', cantidad: 14, monto: 1120000 }, { nombre: 'Davivienda', cantidad: 6, monto: 480000 }],
    cajaVirtual: { nombre: 'Efecty', cantidad: 3, monto: 231000 },
    formaPago: { saldoAnterior: cero, efectivo: B(32, 2032000), transferencia: B(20, 1600000), wompi: cero },
    servicios: {
      planes: [{ clave: 'p300', megas: 300, cantidad: 30, monto: 2310000 }, { clave: 'p600', megas: 600, cantidad: 8, monto: 880000 }],
      television: B(14, 350000), mensualidades: B(52, 3540000), reconexiones: B(4, 48000),
      afiliaciones: [{ producto: 'Afiliacion Internet', cantidad: 2, monto: 120000 }],
      ventas: B(2, 90000), materiales: B(1, 24000), otros: cero, total: B(61, 3822000),
    },
    tipoServicio: { Internet: B(38, 3190000), Television: B(14, 350000) },
    meses: {
      actual: { cantidad: 40, monto: 2900000, Internet: B(30, 2500000), Television: B(10, 400000) },
      anterior: { cantidad: 9, monto: 560000, Internet: B(6, 420000), Television: B(3, 140000) },
      anteriores: { cantidad: 3, monto: 172000, Internet: B(2, 120000), Television: B(1, 52000) },
    },
    anulaciones: {
      anuladoDeCierre: B(1, 77000), anuladoDeOtrosCierres: cero,
      cobranzaEfectiva: { monto: 3555000 }, cobradoNeto: 3555000,
    },
    egresos: { ordenes: B(2, 340000), traslados: B(1, 500000), transacciones: B(3, 96000), total: B(6, 936000) },
  },
  cashAccountName: 'Caja Principal Yopal',
  date: new Date(), userName: 'Luisa Ardila', proximoDiaHabil: new Date(Date.now() + 864e5),
  arrastre: 200000, ventas: 2032000, egresos: 936000, transferencias: 0,
  noEfectivo: 1600000, excedente: 1296000, descuadrado: true, efectivoHoy: 1290000,
  porCategoria: [
    { category: 'Recaudo de facturas', type: 'INCOME', n: 52, total: 3632000 },
    { category: 'Pago orden de compra', type: 'EXPENSE', n: 2, total: 340000 },
  ],
  movimientos: [
    { date: new Date(), note: 'Pago factura #84120', payer: 'Ana Lucia Perez Rojas', category: 'Recaudo', method: 'Efectivo', type: 'INCOME', amount: 79000, firma: 79000 },
    { date: new Date(), note: 'Compra de conectores', payer: 'Ferreteria El Tornillo', category: 'Materiales', method: 'Efectivo', type: 'EXPENSE', amount: 96000, firma: -96000 },
    { date: new Date(), note: 'Pago factura #84121', payer: 'Carlos Andres Mendez Silva', category: 'Recaudo', method: 'Bank', type: 'INCOME', amount: 104000, firma: 104000 },
  ],
});

const estado = {
  subscriber: {
    name: 'Ana Lucia Perez Rojas', abonado: 10482, docType: 'CC', docNumber: '1.098.554.221',
    addressLine: 'Calle 12 # 8-45, Centro', branch: 'Yopal',
  },
  totalCharges: 1248000, totalPayments: 1169000, balance: 79000, pazysalvo: false,
  movements: [
    { date: new Date(Date.now() - 5184e6), concept: 'Factura #83110 — mayo 2026', debit: 104000, credit: 0, balance: 104000 },
    { date: new Date(Date.now() - 4752e6), concept: 'Pago en caja', debit: 0, credit: 104000, balance: 0 },
    { date: new Date(), concept: 'Factura #84120 — julio 2026', debit: 104000, credit: 25000, balance: 79000 },
  ],
};
statementPdf(salida('7-estado-cuenta.pdf'), estado);
pazYSalvoPdf(salida('8-paz-y-salvo.pdf'), { ...estado, balance: 0, pazysalvo: true });

console.log(`PDFs de muestra en ${OUT}`);
