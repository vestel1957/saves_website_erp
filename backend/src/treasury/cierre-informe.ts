import { PrismaService } from '../prisma/prisma.service';
import { rangoDia } from './cierre-legacy';
import { num } from '../common/money';

/**
 * Informe del cierre de caja — port de `views/reports/statement_list.php` del legacy.
 *
 * QUÉ SE REPLICA Y QUÉ NO
 * -----------------------
 * Se replica **la versión de pantalla** (`statement_list.php`), que es la que el personal
 * lee todos los días, con sus rarezas incluidas (el 40/60 del combo, la clasificación por
 * nombre de producto, el prorrateo y su reparto del residuo). Esas rarezas producen las
 * cifras a las que están acostumbrados.
 *
 * NO se replica el destrozo accidental del PDF: `sacar_pdf()` nunca asigna `$cuenta1..5`
 * ni `$texto_mes_*` (sólo los asigna `viewstatement()`), así que el PDF que sale hoy trae
 * **"Resumen por Banco" todo en ceros**, la fila "Transferencia" en 0 y los meses sin
 * etiqueta. Eso no es una regla de negocio, es una variable sin definir: copiarlo sería
 * copiar un fallo.
 *
 * Tampoco se replican: la división por cero de las ramas sin guarda, el `$cuenta3`
 * pisado (que tira la cuenta 8) ni el `$cuenta4` indefinido de `statements_para_pdf()`.
 */


/** Cuentas de banco que se consolidan en la caja (legacy: ids fijos). */
export const BANCOS = [
  { id: 6, nombre: 'BANCOLOMBIA TV' },
  { id: 7, nombre: 'BANCOLOMBIA TELECOMUNICACIONES' },
  { id: 8, nombre: 'BANCOLOMBIA CUENTA CORRIENTE' },
  { id: 23, nombre: 'WOMPI' },
];
const CAJA_VIRTUAL_ID = 11;
const CAJA_VIRTUAL = 'Caja Virtual';

/** `refer` normalizado: sin espacios y en minúsculas (legacy: `str_replace(" ","") + strtolower`). */
const norm = (s: string | null | undefined) => (s ?? '').replace(/ /g, '').toLowerCase();

type Fila = {
  id: string;
  type: string;
  category: string;
  method: string | null;
  credit: number;
  debit: number;
  note: string | null;
  invoice: { total: number; tax: number; invoiceDate: Date; items: { productName: string | null; subtotal: number }[] } | null;
};

type Bucket = { cantidad: number; monto: number };
const bucket = (): Bucket => ({ cantidad: 0, monto: 0 });

/**
 * Clasificación por NOMBRE de producto, en este orden (legacy, vista L36-131).
 * El `products` no se consulta nunca: todo es `strpos` sobre `invoice_items.product`.
 */
function clasificar(producto: string): 'internet' | 'reconexion' | 'afiliacion' | 'television' {
  const p = producto.toLowerCase();
  if (p.includes('mega')) return 'internet';
  if (p.includes('reconexi')) return 'reconexion';
  if (p.includes('afilia')) return 'afiliacion';
  if (p.includes('tele')) return 'television';
  // Catch-all del legacy: "Saldo anterior", "Nota Credito", "Punto Adicional",
  // "Traslado"... todo cae en afiliaciones y por tanto en TOTAL VENTAS.
  return 'afiliacion';
}

/**
 * Normalización del nombre del plan (legacy, vista L41-49). El orden importa y varios
 * `str_replace` son inertes (tras quitar la "v", "vs"/"vc" ya no existen). Se replica
 * porque de aquí salen las claves de los planes.
 */
function normalizarPlan(producto: string): string {
  let s = producto.toLowerCase();
  s = s.replace(/solo/g, '');
  s = s.replace(/v/g, '');
  s = s.replace(/dedicadas/g, '');
  s = s.replace(/d/g, '');
  s = s.replace(/ /g, '');
  return s;
}

/** "10megasf" -> 10. El legacy usa FILTER_SANITIZE_NUMBER_INT + (int). */
const megasDe = (clave: string): number => {
  const soloNumeros = clave.replace(/[^0-9-]/g, '');
  return parseInt(soloNumeros, 10) || 0;
};

export type InformeCierre = Awaited<ReturnType<typeof informeCierre>>;

/**
 * Calcula todos los bloques del informe de un cierre (caja + fecha).
 */
export async function informeCierre(prisma: PrismaService, cashAccountId: number, d: Date) {
  const cuenta = await prisma.cashAccount.findUnique({
    where: { legacyId: cashAccountId },
    select: { holder: true, accountNumber: true },
  });
  const holder = cuenta?.holder ?? '';

  const incluirFactura = {
    select: {
      total: true, tax: true, invoiceDate: true, branchRef: true,
      items: { select: { productName: true, subtotal: true } },
    },
  } as const;

  // 1. Los movimientos de la propia caja (todos los métodos, sin `no_mostrar`).
  const propias = await prisma.transaction.findMany({
    where: { cashAccountId, date: rangoDia(d), noShow: false },
    select: {
      id: true, type: true, category: true, method: true, credit: true, debit: true,
      note: true, status: true, invoice: incluirFactura,
    },
  });

  // 2. Consolidación de banco: un movimiento del banco es de ESTA caja si el `refer` de
  //    su factura coincide con el holder de la caja (sin espacios, case-insensitive).
  const deBanco = await prisma.transaction.findMany({
    where: { cashAccountId: { in: BANCOS.map((b) => b.id) }, date: rangoDia(d), noShow: false },
    select: {
      id: true, type: true, category: true, method: true, credit: true, debit: true,
      note: true, status: true, cashAccountId: true, invoice: incluirFactura,
    },
  });
  const bancoDeLaCaja = deBanco.filter((t) => norm(t.invoice?.branchRef) === norm(holder));

  // 3. Caso especial del legacy: si la caja ES "Caja Virtual", la cuenta 11 aporta
  //    SÓLO sus anuladas.
  const virtuales =
    holder === CAJA_VIRTUAL
      ? await prisma.transaction.findMany({
          where: { cashAccountId: CAJA_VIRTUAL_ID, date: rangoDia(d), noShow: false, status: 'ANULADA' },
          select: {
            id: true, type: true, category: true, method: true, credit: true, debit: true,
            note: true, status: true, invoice: incluirFactura,
          },
        })
      : [];

  const aFila = (t: any): Fila => ({
    id: t.id, type: t.type, category: t.category, method: t.method,
    credit: num(t.credit), debit: num(t.debit), note: t.note,
    invoice: t.invoice
      ? {
          total: num(t.invoice.total), tax: num(t.invoice.tax), invoiceDate: t.invoice.invoiceDate,
          items: t.invoice.items.map((i: any) => ({ productName: i.productName, subtotal: num(i.subtotal) })),
        }
      : null,
  });

  const todas = [...propias, ...bancoDeLaCaja, ...virtuales];
  const lista = todas.filter((t) => t.status !== 'ANULADA').map(aFila);
  const anuladas = todas.filter((t) => t.status === 'ANULADA').map(aFila);

  // ── Prorrateo (legacy, vista L27-174) ────────────────────────────────────────
  // Cada ítem de la factura recibe la parte del pago que le toca:
  //     valor_item = credit * item.subtotal / invoice.total
  // y el residuo de redondeo se reparte EN PARTES IGUALES entre los buckets tocados
  // (no a prorrata), y sólo si pasa de $1.
  const planes = new Map<string, Bucket>();
  const television = bucket();
  const reconexiones = bucket();
  const afiliaciones = new Map<string, Bucket>();
  /** IVA acumulado por la rama "tele", igual que el legacy. */
  let televisionIva = 0;
  let conIvaCantidad = 0;

  for (const f of lista) {
    const inv = f.invoice;
    if (!inv || Math.trunc(inv.total) === 0) continue;
    if (inv.tax !== 0) conIvaCantidad++; // legacy: cuenta TRANSACCIONES, no productos

    const tocados = new Map<string, Bucket>();
    let sumaItems = 0;

    for (const it of inv.items) {
      const producto = it.productName ?? '';
      let valorItem = Math.trunc(it.subtotal);
      if (f.credit !== 0 && valorItem !== 0) {
        const porcentaje = (valorItem * 100) / Math.trunc(inv.total);
        valorItem = (Math.trunc(f.credit) * porcentaje) / 100;
      }
      const tipo = clasificar(producto);

      if (tipo === 'internet') {
        const clave = normalizarPlan(producto);
        const b = planes.get(clave) ?? bucket();
        b.cantidad++; b.monto += valorItem;
        planes.set(clave, b);
        tocados.set(`plan:${clave}`, b);
      } else if (tipo === 'reconexion') {
        reconexiones.cantidad++; reconexiones.monto += valorItem;
        tocados.set('reconexiones', reconexiones);
      } else if (tipo === 'television') {
        television.cantidad++; television.monto += valorItem;
        tocados.set('television', television);
        // Quirk del legacy: el IVA prorrateado es el de la FACTURA entera, pero se suma
        // una vez POR CADA ítem "tele". Una factura con dos ítems tele lo cuenta doble.
        // Se replica: es lo que muestra la pantalla que usan a diario.
        televisionIva += (inv.tax * ((Math.trunc(f.credit) * 100) / Math.trunc(inv.total))) / 100;
      } else {
        const b = afiliaciones.get(producto) ?? bucket();
        b.cantidad++; b.monto += valorItem;
        afiliaciones.set(producto, b);
        tocados.set(`afi:${producto}`, b);
      }
      sumaItems += valorItem;
    }

    // Reparto del residuo entre los buckets tocados.
    const n = tocados.size;
    if (n > 0) {
      const diff = f.credit - sumaItems;
      if (Math.abs(diff) > 1) {
        const porCadaUno = diff / n;
        for (const b of tocados.values()) b.monto += porCadaUno;
      }
    }
  }

  // ── Bloque: Resumen por Banco ────────────────────────────────────────────────
  // (Lo que el PDF del legacy deja en ceros por las variables sin asignar.)
  const porBanco = BANCOS.map((b) => {
    const filas = bancoDeLaCaja.filter((t) => t.cashAccountId === b.id && t.status !== 'ANULADA');
    return { nombre: b.nombre, cantidad: filas.length, monto: filas.reduce((s, t) => s + num(t.credit), 0) };
  });
  const cajaVirtual = { nombre: CAJA_VIRTUAL, cantidad: 0, monto: 0 };

  // ── Bloque: Forma de pago ────────────────────────────────────────────────────
  // Efectivo: sólo `method='Cash'` y sólo dentro de facturas con total != 0 (legacy).
  const efectivo = bucket();
  for (const f of lista) {
    if (!f.invoice || Math.trunc(f.invoice.total) === 0) continue;
    if (f.method === 'Cash') { efectivo.cantidad++; efectivo.monto += f.credit; }
  }

  // Saldo anterior: la pata INCOME del arrastre más reciente hasta esa fecha.
  const saldoRow = await prisma.transaction.findFirst({
    where: {
      accountName: holder, type: 'INCOME', status: 'VIGENTE',
      note: { startsWith: 'Saldo ' }, date: { lte: d },
    },
    orderBy: { date: 'desc' },
    select: { credit: true },
  });
  const saldoAnterior = saldoRow ? num(saldoRow.credit) : 0;

  // ── Bloque: tipo de servicio (2ª pasada del legacy, clasificación más simple) ──
  // Aquí el `else` cae en INTERNET (no en afiliaciones): reconexiones, afiliaciones,
  // notas crédito y saldos cuentan como Internet.
  const tipoServicio = { Internet: bucket(), Television: bucket() };
  for (const f of lista) {
    const inv = f.invoice;
    if (!inv || Math.trunc(inv.total) === 0) continue;
    const tocados: Bucket[] = [];
    let suma = 0;
    for (const it of inv.items) {
      const p = (it.productName ?? '').toLowerCase();
      let valorItem = Math.trunc(it.subtotal);
      if (f.credit !== 0 && valorItem !== 0) {
        valorItem = (Math.trunc(f.credit) * ((valorItem * 100) / Math.trunc(inv.total))) / 100;
      }
      const b = p.includes('mega') ? tipoServicio.Internet : p.includes('tele') ? tipoServicio.Television : tipoServicio.Internet;
      b.cantidad++; b.monto += valorItem;
      tocados.push(b);
      suma += valorItem;
    }
    const diff = f.credit - suma;
    if (tocados.length && Math.abs(diff) > 1) {
      const cada = diff / tocados.length;
      for (const b of tocados) b.monto += cada;
    }
  }

  // ── Bloque: Resumen Cobranza ─────────────────────────────────────────────────
  // Ojo: "Base" cuenta TRANSACCIONES y "Excento" cuenta ÍTEMS. El legacy los suma igual
  // en el TOTAL pese a ser unidades distintas. Se replica.
  const montoConIva = television.monto - televisionIva;
  const montoIva = televisionIva;
  const cantidadSinIva = tipoServicio.Internet.cantidad;
  const montoSinIva = tipoServicio.Internet.monto + tipoServicio.Television.monto - (montoConIva + montoIva);
  const totalCobranza = montoSinIva + montoConIva + montoIva;

  // ── Bloque: Resumen por Servicios ────────────────────────────────────────────
  // Combo: reparto fijo 40% TV / 60% Internet, y la CANTIDAD se suma a AMBOS (el legacy
  // cuenta el combo dos veces en el TOTAL VENTAS). Se replica.
  const combo = afiliaciones.get('Afiliación Combo');
  if (combo) {
    const tv = afiliaciones.get('Afiliación Television') ?? bucket();
    tv.monto += (combo.monto * 40) / 100;
    tv.cantidad += combo.cantidad;
    afiliaciones.set('Afiliación Television', tv);
    const inet = afiliaciones.get('Afiliación Internet') ?? bucket();
    inet.monto += (combo.monto * 60) / 100;
    inet.cantidad += combo.cantidad;
    afiliaciones.set('Afiliación Internet', inet);
    afiliaciones.delete('Afiliación Combo');
  }

  const mensualidades = { cantidad: 0, monto: 0 };
  for (const b of planes.values()) { mensualidades.cantidad += b.cantidad; mensualidades.monto += b.monto; }
  // El legacy incluye Television en las mensualidades (arranca con esa clave).
  mensualidades.cantidad += television.cantidad;
  mensualidades.monto += television.monto;

  const ventas = { cantidad: 0, monto: 0 };
  for (const b of afiliaciones.values()) { ventas.cantidad += b.cantidad; ventas.monto += b.monto; }

  const planesOrdenados = [...planes.entries()]
    .map(([clave, b]) => ({ clave, megas: megasDe(clave), ...b }))
    .sort((a, b) => a.megas - b.megas);

  // ── Bloque: cargos cobrados por meses ────────────────────────────────────────
  // Cubetas por `invoices.invoicedate`: mes anterior / mes actual / resto.
  // El legacy usa `strtotime("-1 month")`, que en un día 31 desborda y rompe el corte;
  // aquí se toma el mes anterior de verdad (mismo resultado salvo los días 31).
  const inicioMesActual = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const finMesActual = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const inicioMesAnterior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const finMesAnterior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));

  const mesBucket = () => ({ cantidad: 0, monto: 0, Internet: bucket(), Television: bucket() });
  const meses = { actual: mesBucket(), anterior: mesBucket(), anteriores: mesBucket() };

  for (const f of lista) {
    const inv = f.invoice;
    if (!inv) continue;
    const fi = inv.invoiceDate;
    const destino =
      fi >= inicioMesAnterior && fi <= finMesAnterior ? meses.anterior
      : fi >= inicioMesActual && fi <= finMesActual ? meses.actual
      : meses.anteriores;

    // `monto` del bucket padre es el credit CRUDO (sin prorratear): en el legacy no
    // cuadra con Internet+Television, y así se muestra.
    destino.monto += f.credit;
    const total = Math.trunc(inv.total) === 0 ? 1 : Math.trunc(inv.total);
    for (const it of inv.items) {
      const p = (it.productName ?? '').toLowerCase();
      let valorItem = Math.trunc(it.subtotal);
      if (f.credit !== 0 && valorItem !== 0) {
        valorItem = (Math.trunc(f.credit) * ((valorItem * 100) / total)) / 100;
      }
      const b = p.includes('tele') ? destino.Television : destino.Internet;
      b.cantidad++; b.monto += valorItem;
    }
    destino.cantidad = destino.Internet.cantidad + destino.Television.cantidad;
  }

  // ── Bloque: Anulaciones ──────────────────────────────────────────────────────
  const DETALLES = ['Cobranza Efectiva', 'Anulado de Cierre', 'Anulado de otros Cierres'];
  const porAnulacion = new Map<string, Bucket>(DETALLES.map((k) => [k, bucket()]));
  if (anuladas.length) {
    const vs = await prisma.voiding.findMany({
      where: { transactionId: { in: anuladas.map((a) => a.id) } },
      select: { transactionId: true, detail: true },
    });
    const detallePorTx = new Map(vs.map((v) => [v.transactionId, v.detail]));
    for (const a of anuladas) {
      const det = detallePorTx.get(a.id);
      // El legacy descarta en silencio los `detalle` que no son uno de los tres.
      const b = det ? porAnulacion.get(det) : undefined;
      if (b) { b.cantidad++; b.monto += Math.trunc(a.credit); }
    }
  }

  // ── Bloque: Egresos ──────────────────────────────────────────────────────────
  // `cat == 'Compra'` -> Transacciones; el resto -> Pago Orden de Compra.
  // Transferencias: filas `type='TRANSFER'` cuya nota mencione la caja (legacy: substring).
  const ordenes = bucket();
  const transacciones = bucket();
  for (const f of lista) {
    if (f.type !== 'EXPENSE') continue;
    const b = f.category === 'Compra' ? transacciones : ordenes;
    b.cantidad++; b.monto += f.debit;
  }
  const traslados = bucket();
  for (const f of lista) {
    if (f.type !== 'TRANSFER') continue;
    if ((f.note ?? '').toLowerCase().includes(holder.toLowerCase())) {
      traslados.cantidad++; traslados.monto += f.debit;
    }
  }

  return {
    caja: { id: cashAccountId, holder, accountNumber: cuenta?.accountNumber ?? null },
    fecha: d,
    cobranza: {
      excento: { cantidad: cantidadSinIva, monto: montoSinIva },
      base: { cantidad: conIvaCantidad, monto: montoConIva },
      iva: { cantidad: conIvaCantidad, monto: montoIva },
      total: { cantidad: cantidadSinIva + conIvaCantidad, monto: totalCobranza },
    },
    porBanco,
    cajaVirtual,
    formaPago: {
      saldoAnterior: { cantidad: saldoAnterior === 0 ? 0 : 1, monto: saldoAnterior },
      efectivo,
      // El legacy suma aquí Caja Virtual + los 3 Bancolombia (sin WOMPI).
      transferencia: {
        cantidad: cajaVirtual.cantidad + porBanco.filter((b) => b.nombre !== 'WOMPI').reduce((s, b) => s + b.cantidad, 0),
        monto: cajaVirtual.monto + porBanco.filter((b) => b.nombre !== 'WOMPI').reduce((s, b) => s + b.monto, 0),
      },
      wompi: porBanco.find((b) => b.nombre === 'WOMPI') ?? bucket(),
    },
    servicios: {
      planes: planesOrdenados,
      television,
      mensualidades,
      reconexiones,
      afiliaciones: [...afiliaciones.entries()].map(([producto, b]) => ({ producto, ...b })),
      ventas,
      // El legacy los imprime en duro a 0.
      materiales: bucket(),
      otros: bucket(),
      total: {
        cantidad: mensualidades.cantidad + ventas.cantidad + reconexiones.cantidad,
        monto: mensualidades.monto + ventas.monto + reconexiones.monto,
      },
    },
    tipoServicio,
    meses,
    anulaciones: {
      anuladoDeCierre: {
        cantidad: (porAnulacion.get('Anulado de Cierre')!.cantidad + porAnulacion.get('Cobranza Efectiva')!.cantidad),
        monto: (porAnulacion.get('Anulado de Cierre')!.monto + porAnulacion.get('Cobranza Efectiva')!.monto),
      },
      anuladoDeOtrosCierres: porAnulacion.get('Anulado de otros Cierres')!,
      cobranzaEfectiva: {
        monto: totalCobranza + DETALLES.reduce((s, k) => s + porAnulacion.get(k)!.monto, 0),
      },
      cobradoNeto: totalCobranza,
    },
    egresos: {
      ordenes,
      traslados,
      transacciones,
      total: {
        cantidad: ordenes.cantidad + traslados.cantidad + transacciones.cantidad,
        monto: ordenes.monto + traslados.monto + transacciones.monto,
      },
    },
  };
}
