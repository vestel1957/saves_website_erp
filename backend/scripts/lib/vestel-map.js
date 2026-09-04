/**
 * Mapeo compartido legacy (MySQL admin_vestel) ↔ nuevo (Prisma saves_vestel).
 * Lo usan `sync-legacy-vivo.js` (legacy→nuevo) y `writeback-legacy.js` (nuevo→legacy):
 * una sola fuente de reglas para que las dos direcciones nunca se desalineen.
 * Las reglas de ida son las mismas del ETL histórico (`etl-vestel.js`).
 * Los diccionarios inversos usan los textos EXACTOS observados en la BD viva
 * (SELECT DISTINCT del 2026-07-27): estados en Title Case, invoices.status en
 * minúscula, tipo_factura 'Nota Credito' sin tilde, etc.
 */

// ---------- normalización ----------
const norm = (s) => (s == null ? '' : String(s).trim());
const bool = (v) => v === 1 || v === '1' || v === true;
const dOnly = (s) => { const t = norm(s).slice(0, 10); if (!t || t === '0000-00-00') return null;
  const d = new Date(t + 'T00:00:00Z'); return isNaN(d) ? null : d; };
const dTime = (s) => { const t = norm(s); if (!t || t.startsWith('0000-00-00')) return null;
  const d = new Date(t.replace(' ', 'T') + 'Z'); return isNaN(d) ? null : d; };
const money = (v) => (v == null || v === '' ? 0 : Number(v));
const cleanEmail = (e) => { const s = norm(e); return !s || s.toUpperCase() === 'NULL' ? null : s; };
// inversas de dOnly/dTime (las fechas PG están en UTC porque la ida les añadió 'Z')
const toD = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const toDT = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : null);

// ---------- diccionarios legacy→enum ----------
const SUB_STATUS = { activo:'ACTIVO', cartera:'CARTERA', compromiso:'COMPROMISO', cortado:'CORTADO',
  depurado:'DEPURADO', evento:'EVENTO', exonerado:'EXONERADO', instalar:'INSTALAR',
  'por retirar':'POR_RETIRAR', reportado:'REPORTADO', retirado:'RETIRADO', suspendido:'SUSPENDIDO', inactivo:'INACTIVO' };
const subStatus = (s) => SUB_STATUS[norm(s).toLowerCase()] || null;
const RON = { ...SUB_STATUS, anulado:'ANULADO', 'dado de baja':'DADO_DE_BAJA' };
const ron = (s) => RON[norm(s).toLowerCase()] || null;
const INV_STATUS = { paid:'PAID', due:'DUE', partial:'PARTIAL', canceled:'CANCELED' };
const invStatus = (s) => INV_STATUS[norm(s).toLowerCase()] || 'DUE';
const KIND = { recurrente:'RECURRENTE', fija:'FIJA', 'nota credito':'NOTA_CREDITO', 'nota debito':'NOTA_DEBITO' };
const invKind = (s) => KIND[norm(s).toLowerCase()] || 'RECURRENTE';
const SVC_STATUS = { cortado:'CORTADO', suspendido:'SUSPENDIDO' };
const svcStatus = (s) => SVC_STATUS[norm(s).toLowerCase()] || null;
const TX_TYPE = { income:'INCOME', expense:'EXPENSE', transfer:'TRANSFER' };
const txType = (s) => TX_TYPE[norm(s).toLowerCase()] || 'INCOME';
const txStatus = (s) => (norm(s).toLowerCase() === 'anulada' ? 'ANULADA' : 'VIGENTE');
const TECH = { GPON:'GPON', EPON:'EPON', EOC:'EOC', RADIO:'RADIO', FIBRA:'FIBRA' };
const tech = (s) => TECH[norm(s).toUpperCase()] || null;
const RET = { 'retefuente servicios':'RETEFUENTE_SERVICIOS', compras:'COMPRAS',
  'personas no declarantes':'PERSONAS_NO_DECLARANTES', reteiva:'RETEIVA' };
const ret = (s) => RET[norm(s).toLowerCase()] || null;
const EI_TYPE = { facturada:'FACTURADA', error:'ERROR', actualizada:'ACTUALIZADA' };
const eiType = (s) => EI_TYPE[norm(s).toLowerCase()] || 'FACTURADA';
const payMethod = (s) => { const t = norm(s).toLowerCase(); return t === 'credito' ? 'CREDITO' : t === 'efectivo' ? 'EFECTIVO' : null; };

// ---------- diccionarios enum→legacy (textos exactos de la BD viva) ----------
const SUB_STATUS_INV = { ACTIVO:'Activo', CARTERA:'Cartera', COMPROMISO:'Compromiso', CORTADO:'Cortado',
  DEPURADO:'Depurado', EVENTO:'Evento', EXONERADO:'Exonerado', INSTALAR:'Instalar',
  POR_RETIRAR:'Por retirar', REPORTADO:'Reportado', RETIRADO:'Retirado', SUSPENDIDO:'Suspendido', INACTIVO:'Inactivo' };
const RON_INV = { ...SUB_STATUS_INV, ANULADO:'Anulado', DADO_DE_BAJA:'Dado de Baja' };
const INV_STATUS_INV = { PAID:'paid', DUE:'due', PARTIAL:'partial', CANCELED:'canceled' };
const KIND_INV = { RECURRENTE:'Recurrente', FIJA:'Fija', NOTA_CREDITO:'Nota Credito', NOTA_DEBITO:'Nota Debito' };
const SVC_STATUS_INV = { CORTADO:'Cortado', SUSPENDIDO:'Suspendido' };
const TX_TYPE_INV = { INCOME:'Income', EXPENSE:'Expense', TRANSFER:'Transfer' };
const TICKET_STATUS_INV = { REALIZANDO:'Realizando', RESUELTO:'Resuelto', ANULADA:'Anulada', PENDIENTE:'Pendiente' };
const RET_INV = { RETEFUENTE_SERVICIOS:'Retefuente Servicios', COMPRAS:'Compras',
  PERSONAS_NO_DECLARANTES:'Personas no declarantes', RETEIVA:'Reteiva' };
const PAY_INV = { CREDITO:'credito', EFECTIVO:'efectivo' };
const inv = (dict) => (v) => (v == null ? null : dict[v] ?? null);

// ---------- filas legacy → data Prisma ----------
const mapCustomer = (r) => ({
  legacyId: r.id, abonado: Number(r.abonado) || 0, suscripcion: norm(r.suscripcion) || null,
  firstName: r.name, secondName: r.dosnombre, lastName1: r.unoapellido, lastName2: r.dosapellido,
  companyName: r.company, customerType: r.tipo_cliente, docType: r.tipo_documento, docNumber: r.documento,
  birthDate: dOnly(r.nacimiento), phone1: r.celular, phone2: r.celular2, email: cleanEmail(r.email),
  contractDate: dOnly(r.f_contrato), entryDate: dOnly(r.f_ingreso), estrato: r.estrato, clausula: r.clausula || null,
  departmentRef: norm(r.departamento) || null, cityRef: norm(r.ciudad) || null, localityRef: norm(r.localidad) || null,
  neighborhood: norm(r.barrio) || null, addressLine: r.dirsuscriptor,
  nomenclature: { nomenclatura: r.nomenclatura, numero1: r.numero1, adicionauno: r.adicionauno,
    numero2: r.numero2, adicional2: r.adicional2, numero3: r.numero3, residencia: r.residencia,
    referencia: r.referencia, divicion: r.divicion, divnum1: r.divnum1, divicion2: r.divicion2, divnum2: r.divnum2 },
  gpsLat: norm(r.coor1) || null, gpsLng: norm(r.coor2) || null,
  pppUsername: r.name_s, pppPassword: r.contra, pppService: r.servicio, pppProfile: r.perfil,
  ipLocal: r.Iplocal, ipRemote: r.Ipremota, netComment: r.comentario, macEquipo: r.macequipo, macOnt: r.mac_ont,
  installTech: tech(r.tegnologia_instalacion),
  status: subStatus(r.usu_estado), previousStatus: subStatus(r.ultimo_estado),
  statusChangedAt: dTime(r.fecha_cambio), statusGenDate: dOnly(r.fecha_genera_estado_user),
  balance: money(r.balance), debitCache: money(r.debit), creditCache: money(r.credit),
  eInvoice: bool(r.facturar_electronicamente), eInvoiceTv: bool(r.f_elec_tv),
  eInvoiceInternet: bool(r.f_elec_internet), eInvoicePuntos: bool(r.f_elec_puntos),
  digitalSignature: bool(r.firma_digital), picture: r.picture,
});

const mapInvoice = (r, sid) => ({
  legacyId: r.id, tid: r.tid, subscriberId: sid, issuerUserId: r.eid || null,
  invoiceDate: dOnly(r.invoicedate) || new Date(0), dueDate: dOnly(r.invoiceduedate) || new Date(0),
  subtotal: money(r.subtotal), shipping: money(r.shipping), discount: money(r.discount),
  tax: money(r.tax), total: money(r.total), paidAmount: money(r.pamnt),
  status: invStatus(r.status), ron: ron(r.ron), paymentMethod: r.pmethod, itemsCount: r.items || 0,
  taxEnabled: norm(r.taxstatus) === 'yes', discEnabled: bool(r.discstatus), discountFormat: r.format_discount,
  branchRef: r.refer, serviceTv: r.television, serviceCombo: r.combo, puntos: r.puntos,
  estadoTv: svcStatus(r.estado_tv), estadoCombo: svcStatus(r.estado_combo),
  streamingStandard: r.streaming_standard || 0, streamingPremium: r.streaming_premium || 0,
  streamingPremiumPlus: r.streaming_premium_plus || 0, streamingDiamante: r.streaming_diamante || 0,
  term: r.term || null, rec: norm(r.rec) || null, reconnectFlag: norm(r.rec) === '1',
  currencyRef: r.multi || null, kind: invKind(r.tipo_factura),
  promo: r.promo, promo2: r.promo2, promoModifiedDate: dOnly(r.fecha_modifica_promo),
  promo2ModifiedDate: dOnly(r.fecha_modifica_promo2), retentionType: ret(r.tipo_retencion),
  eInvoiceFlag: r.facturacion_electronica, eInvoiceGenDate: dOnly(r.fecha_f_electronica_generada),
  eInvoiceServices: r.servicios_facturados_electronicamente, eInvoicePayMethod: payMethod(r.metodo_pago_f_e),
  notes: r.notes,
});

const mapItem = (r, iid) => ({
  legacyId: r.id, invoiceId: iid, productId: r.pid, productName: r.product, description: r.product_des,
  qty: r.qty || 0, price: money(r.price), taxRate: money(r.tax), discount: money(r.discount),
  subtotal: money(r.subtotal), taxTotal: money(r.totaltax), discountTotal: money(r.totaldiscount),
  taxRemoved: r.tax_removed, retentionType: ret(r.tipo_retencion), createdByUserId: r.id_usuario_crea,
  createdAt: dTime(r.fecha_creacion) || new Date(),
});

/**
 * `transactions` del legacy → Transaction.
 *
 * OJO con `tid`: allá NO siempre es una factura. En los pagos de una orden de compra
 * (`cat = 'Purchase'`, la misma regla por la que su pantalla busca el comprobante en
 * `meta_data` type 4) `tid` es el número de la ORDEN, y casarlo a ciegas contra
 * `invoices.tid` colgaba el egreso de la factura de un cliente que casualmente tenía
 * ese mismo número: 766 de los 777 pagos de compra estaban así. Por eso el enlace
 * llega resuelto desde fuera —`oid` = orden— y quien lo resuelve decide cuál de los
 * dos toca (ver `syncTransactions`).
 */
const mapTx = (r, sid, iid, oid) => ({
  legacyId: r.id, cashAccountId: r.acid, accountName: r.account, type: txType(r.type), category: norm(r.cat),
  debit: money(r.debit), credit: money(r.credit), payerName: r.payer,
  subscriberId: sid || null, method: r.method, date: dOnly(r.date) || new Date(0),
  invoiceId: iid || null, supplyOrderId: oid || null, issuerUserId: r.eid || null, note: r.note,
  ext: bool(r.ext), bankName: r.nombre_banco, bankId: r.id_banco, status: txStatus(r.estado),
  noShow: bool(r.no_mostrar), payuOrderId: r.id_orden_payu,
});

/** ¿Este movimiento del legacy es el pago de una orden de compra (y no de una factura)? */
const esPagoDeCompra = (r) => norm(r.cat) === 'Purchase';

// ---------- filas Prisma → columnas legacy (vuelta) ----------
/** Subscriber PG → columnas de `customers`. `gid` = Branch.legacyId (sede). */
const invCustomer = (s, gid) => ({
  abonado: s.abonado, suscripcion: s.suscripcion ?? '', name: s.firstName ?? '', dosnombre: s.secondName ?? '',
  unoapellido: s.lastName1 ?? '', dosapellido: s.lastName2 ?? '', company: s.companyName ?? '',
  tipo_cliente: s.customerType ?? '', tipo_documento: s.docType ?? '', documento: s.docNumber ?? '',
  nacimiento: toD(s.birthDate), celular: s.phone1 ?? '', celular2: s.phone2 ?? '', email: s.email ?? '',
  f_contrato: toD(s.contractDate), f_ingreso: toD(s.entryDate), estrato: s.estrato ?? '', clausula: s.clausula ?? 0,
  departamento: s.departmentRef ?? '', ciudad: s.cityRef ?? '', localidad: s.localityRef ?? '', barrio: s.neighborhood ?? '',
  dirsuscriptor: s.addressLine ?? '',
  nomenclatura: s.nomenclature?.nomenclatura ?? '', numero1: s.nomenclature?.numero1 ?? '',
  adicionauno: s.nomenclature?.adicionauno ?? '', numero2: s.nomenclature?.numero2 ?? '',
  adicional2: s.nomenclature?.adicional2 ?? '', numero3: s.nomenclature?.numero3 ?? '',
  residencia: s.nomenclature?.residencia ?? '', referencia: s.nomenclature?.referencia ?? '',
  divicion: s.nomenclature?.divicion ?? '', divnum1: s.nomenclature?.divnum1 ?? '',
  divicion2: s.nomenclature?.divicion2 ?? '', divnum2: s.nomenclature?.divnum2 ?? '',
  coor1: s.gpsLat ?? '', coor2: s.gpsLng ?? '',
  name_s: s.pppUsername ?? '', contra: s.pppPassword ?? '', servicio: s.pppService ?? '', perfil: s.pppProfile ?? '',
  Iplocal: s.ipLocal ?? '', Ipremota: s.ipRemote ?? '', comentario: s.netComment ?? '',
  macequipo: s.macEquipo ?? '', mac_ont: s.macOnt ?? '', tegnologia_instalacion: s.installTech ?? '',
  usu_estado: inv(SUB_STATUS_INV)(s.status) ?? '', ultimo_estado: inv(SUB_STATUS_INV)(s.previousStatus) ?? '',
  fecha_cambio: toDT(s.statusChangedAt), fecha_genera_estado_user: toD(s.statusGenDate),
  balance: Number(s.balance ?? 0), debit: Number(s.debitCache ?? 0), credit: Number(s.creditCache ?? 0),
  facturar_electronicamente: s.eInvoice ? 1 : 0, f_elec_tv: s.eInvoiceTv ? 1 : 0,
  f_elec_internet: s.eInvoiceInternet ? 1 : 0, f_elec_puntos: s.eInvoicePuntos ? 1 : 0,
  firma_digital: s.digitalSignature ? 1 : 0, picture: s.picture ?? '',
  ...(gid != null ? { gid } : {}),
});

/** Campo Prisma → columnas legacy que ese campo alimenta (para UPDATE selectivo). */
const CUSTOMER_FIELD2COLS = {
  abonado: ['abonado'], suscripcion: ['suscripcion'], firstName: ['name'], secondName: ['dosnombre'],
  lastName1: ['unoapellido'], lastName2: ['dosapellido'], companyName: ['company'], customerType: ['tipo_cliente'],
  docType: ['tipo_documento'], docNumber: ['documento'], birthDate: ['nacimiento'], phone1: ['celular'],
  phone2: ['celular2'], email: ['email'], contractDate: ['f_contrato'], entryDate: ['f_ingreso'],
  estrato: ['estrato'], clausula: ['clausula'], departmentRef: ['departamento'], cityRef: ['ciudad'],
  localityRef: ['localidad'], neighborhood: ['barrio'], addressLine: ['dirsuscriptor'],
  nomenclature: ['nomenclatura','numero1','adicionauno','numero2','adicional2','numero3','residencia','referencia','divicion','divnum1','divicion2','divnum2'],
  gpsLat: ['coor1'], gpsLng: ['coor2'], pppUsername: ['name_s'], pppPassword: ['contra'],
  pppService: ['servicio'], pppProfile: ['perfil'], ipLocal: ['Iplocal'], ipRemote: ['Ipremota'],
  netComment: ['comentario'], macEquipo: ['macequipo'], macOnt: ['mac_ont'], installTech: ['tegnologia_instalacion'],
  status: ['usu_estado'], previousStatus: ['ultimo_estado'], statusChangedAt: ['fecha_cambio'],
  statusGenDate: ['fecha_genera_estado_user'], balance: ['balance'], debitCache: ['debit'], creditCache: ['credit'],
  eInvoice: ['facturar_electronicamente'], eInvoiceTv: ['f_elec_tv'], eInvoiceInternet: ['f_elec_internet'],
  eInvoicePuntos: ['f_elec_puntos'], digitalSignature: ['firma_digital'], picture: ['picture'],
};

/** SubInvoice PG → columnas de `invoices`. `csd` = Subscriber.legacyId. */
const invInvoice = (f, csd) => ({
  tid: f.tid, csd, eid: f.issuerUserId ?? 0,
  invoicedate: toD(f.invoiceDate), invoiceduedate: toD(f.dueDate),
  subtotal: Number(f.subtotal ?? 0), shipping: Number(f.shipping ?? 0), discount: Number(f.discount ?? 0),
  tax: Number(f.tax ?? 0), total: Number(f.total ?? 0), pamnt: Number(f.paidAmount ?? 0),
  status: inv(INV_STATUS_INV)(f.status) ?? 'due', ron: inv(RON_INV)(f.ron), pmethod: f.paymentMethod ?? '',
  items: f.itemsCount ?? 0, taxstatus: f.taxEnabled ? 'yes' : 'no', discstatus: f.discEnabled ? 1 : 0,
  format_discount: f.discountFormat ?? '', refer: f.branchRef ?? '',
  television: f.serviceTv ?? '', combo: f.serviceCombo ?? '', puntos: f.puntos ?? 0,
  estado_tv: inv(SVC_STATUS_INV)(f.estadoTv), estado_combo: inv(SVC_STATUS_INV)(f.estadoCombo),
  streaming_standard: f.streamingStandard ?? 0, streaming_premium: f.streamingPremium ?? 0,
  streaming_premium_plus: f.streamingPremiumPlus ?? 0, streaming_diamante: f.streamingDiamante ?? 0,
  term: f.term ?? 0, rec: f.rec ?? '', multi: f.currencyRef ?? 0, tipo_factura: inv(KIND_INV)(f.kind) ?? 'Fija',
  promo: f.promo, promo2: f.promo2, fecha_modifica_promo: toD(f.promoModifiedDate),
  fecha_modifica_promo2: toD(f.promo2ModifiedDate), tipo_retencion: inv(RET_INV)(f.retentionType),
  facturacion_electronica: f.eInvoiceFlag ?? '', fecha_f_electronica_generada: toD(f.eInvoiceGenDate),
  servicios_facturados_electronicamente: f.eInvoiceServices ?? '', metodo_pago_f_e: inv(PAY_INV)(f.eInvoicePayMethod),
  notes: f.notes ?? '',
});

/** SubInvoiceItem PG → columnas de `invoice_items`. `tid` = tid de su factura. */
const invItem = (it, tid) => ({
  tid, pid: it.productId ?? 0, product: it.productName ?? '', product_des: it.description ?? '',
  qty: Number(it.qty ?? 0), price: Number(it.price ?? 0), tax: Number(it.taxRate ?? 0),
  discount: Number(it.discount ?? 0), subtotal: Number(it.subtotal ?? 0), totaltax: Number(it.taxTotal ?? 0),
  totaldiscount: Number(it.discountTotal ?? 0), tax_removed: it.taxRemoved ?? '',
  tipo_retencion: inv(RET_INV)(it.retentionType), id_usuario_crea: it.createdByUserId ?? 0,
  fecha_creacion: toDT(it.createdAt),
});

/**
 * Comprobante de un movimiento, para el legacy.
 *
 * Allá `transactions` no tiene columna de adjunto NI pantalla que lo muestre (20
 * columnas, ninguna es un fichero), así que el comprobante que se sube aquí no puede
 * "reflejarse" tal cual: se le entrega como un ENLACE metido dentro de `note`, que es
 * el único campo libre que sus vistas sí pintan (views/transactions/view.php).
 *
 * El enlace apunta a la ruta pública `/api/treasury/comprobante/:archivo`: quien lo
 * abre está trabajando en el legacy y no tiene sesión en este sistema. El nombre en
 * disco es un UUID v4 sorteado al subir, así que la URL no se adivina.
 */
const BASE_PUBLICA = (process.env.PUBLIC_BASE_URL || 'https://app.saves.com.co').replace(/\/+$/, '');
const NOTE_MAX = 255; // `transactions.note` allá es varchar(255)

const urlComprobante = (attach) => `${BASE_PUBLICA}/api/treasury/comprobante/${attach}`;

/** ¿La nota que hay en el legacy ya lleva el enlace de ESTE comprobante? */
const tieneComprobante = (note, attach) => !!attach && String(note ?? '').includes(urlComprobante(attach));

/**
 * Nota para el legacy con el enlace pegado al final.
 *
 * Si no cabe en los 255 se recorta el TEXTO, nunca el enlace: media URL no abre nada,
 * mientras que un texto recortado sigue diciendo de qué es el movimiento.
 */
const notaConComprobante = (note, attach) => {
  const base = String(note ?? '').trim();
  if (!attach) return base.slice(0, NOTE_MAX);
  const cola = ` | Comprobante: ${urlComprobante(attach)}`;
  if (cola.length >= NOTE_MAX) return base.slice(0, NOTE_MAX); // enlace absurdamente largo: mejor la nota sola
  return (base.slice(0, NOTE_MAX - cola.length).trim() + cola).slice(0, NOTE_MAX);
};

/** Transaction PG → columnas de `transactions`. */
const invTx = (t, payerid, tid) => ({
  acid: t.cashAccountId ?? 0, account: t.accountName ?? '', type: inv(TX_TYPE_INV)(t.type) ?? 'Income',
  cat: t.category ?? '', debit: Number(t.debit ?? 0), credit: Number(t.credit ?? 0),
  payer: t.payerName ?? '', payerid: payerid ?? 0, method: t.method ?? '', date: toD(t.date),
  tid: tid ?? 0, eid: t.issuerUserId ?? 0, note: notaConComprobante(t.note, t.attach), ext: t.ext ? 1 : 0,
  nombre_banco: t.bankName ?? '', id_banco: t.bankId ?? 0,
  estado: t.status === 'ANULADA' ? 'Anulada' : null, no_mostrar: t.noShow ? 1 : 0,
  id_orden_payu: t.payuOrderId ?? '',
});

/**
 * Orden de servicio (PG) → fila de `tickets` del legacy.
 *
 * `cid`, `subject`, `detalle`, `problema`, `section` y `asignado` son NOT NULL allá,
 * de ahí los `?? ''`. Los textos se recortan a lo que aguanta cada columna: el legacy
 * es varchar corto (detalle 50, problema 150) y un texto de más aborta el INSERT
 * entero — perder la cola de un texto es preferible a perder la orden.
 *
 * `asignacion_movil` va en 0: las cuadrillas se retiraron del sistema nuevo y allá la
 * columna sigue existiendo.
 *
 * OJO con `asignado`: allá NO es un nombre para leer, es el IDENTIFICADOR por el que el
 * técnico encuentra su trabajo. El legacy compara `asignado` contra el `username` de
 * `aauth_users` con igualdad exacta (`Ticket_model::get_ticfiltrado`, y el `where_in`
 * de los listados), así que empujar el nombre de pila —que es lo que guarda
 * `Ticket.assigned`, texto libre heredado— deja la orden EN el legacy pero INVISIBLE
 * para quien tiene que atenderla: 51 órdenes quedaron así. Por eso manda el username
 * del staff resuelto (`assignedStaff.username`) y sólo cae al texto libre cuando no hay
 * staff detrás —órdenes viejas importadas, donde ese texto ya ES el username de allá.
 */
const corta = (v, n) => { const t = norm(v); return t.length > n ? t.slice(0, n) : t; };
const invTicket = (t, cid) => ({
  codigo: t.code ?? 0, subject: corta(t.subject, 255), detalle: corta(t.type, 50),
  created: toD(t.created), cid, col: t.col ?? null,
  status: inv(TICKET_STATUS_INV)(t.status) ?? 'Pendiente',
  problema: corta(t.problem, 150), section: corta(t.section, 1500),
  fecha_final: toD(t.finalDate), id_invoice: t.invoiceLegacy ?? null, id_factura: t.invoiceBillLegacy ?? null,
  asignado: corta(t.assignedStaff?.username || t.assigned, 50), par: t.par ?? null, asignacion_movil: 0,
  nombre_firma: t.signatureName ?? null, cc_firma: t.signatureCc ?? null,
  parentesco_firma: t.signatureRel ?? null,
});

// ---------- inventario: PG → legacy ----------
/**
 * El inventario baja del legacy desde el 2026-08-25 pero nunca subía: lo que se movía
 * aquí —una devolución de equipo, el material que gasta un técnico, una orden de compra
 * aprobada— el legacy no lo veía jamás. Estos mapeos son el camino de vuelta.
 *
 * Ojo con los NOT NULL sin `default` de estas tablas (`equipos` los tiene casi todos, y
 * `purchase` arrastra `eid`/`a2id`/`discstatus`/`term`): MySQL en modo estricto rechaza
 * el INSERT entero si falta uno, así que aquí se les da valor explícito aunque en Nexus
 * el concepto no exista.
 */

/** Los únicos valores que acepta `purchase.status` (es un ENUM allá). */
const PURCHASE_STATUS = new Set(['pendiente', 'cancelado', 'abonado', 'recibido',
  'recibido parcial', 'finalizado', 'anulado', 'aprobado']);
/** Ídem `products.tipo_servicio` y `products.pertence_a_tv_o_net`. */
const SERVICE_TYPE = new Set(['Fijo', 'Recurrente']);
const TV_O_NET = new Set(['Tv', 'Internet']);
/** Ídem `tipo_retencion`, compartido por `purchase` y `purchase_items`. */
const RETENCION = new Set(['Retefuente Servicios', 'Compras', 'Personas no declarantes', 'Reteiva']);
/** Un valor fuera del ENUM tumba la fila entera: se manda NULL antes que romper. */
const enumOnly = (conjunto) => (v) => (conjunto.has(norm(v)) ? norm(v) : null);
const entero = (v) => Math.round(num(v));

/** Material PG → columnas de `products`. `pcat`/`warehouse` van con el legacyId de allá. */
const invMaterial = (m) => ({
  pcat: m.categoryLegacy ?? 1, warehouse: m.warehouseLegacy ?? 1, sede: m.branchRef ?? 0,
  product_name: corta(m.name, 50) || 'Material', product_code: corta(m.code, 255),
  product_price: entero(m.price), fproduct_price: entero(m.cost),
  taxrate: entero(m.taxRate), disrate: entero(m.discRate),
  qty: entero(m.qty), product_des: norm(m.description), alert: m.alert ?? 0,
  tipo_servicio: enumOnly(SERVICE_TYPE)(m.serviceType),
  pertence_a_tv_o_net: enumOnly(TV_O_NET)(m.tvOrNet),
});

/**
 * Equipment PG → columnas de `equipos`.
 *
 * `llegada` y `final` son DATE NOT NULL allá y aquí pueden venir vacías (un equipo dado
 * de alta en Nexus no siempre tiene fecha de llegada). Se rellenan con la fecha de hoy:
 * inventarse un 0000-00-00 rompería cualquier consulta por rango del legacy.
 */
const invEquipo = (e, hoy) => ({
  codigo: e.code ?? 0, proveedor: e.supplierLegacy ?? 0, almacen: e.warehouseLegacy ?? 0,
  mac: corta(e.mac, 100), serial: corta(e.serial, 100),
  llegada: toD(e.arrival) || hoy, final: toD(e.endDate) || hoy,
  marca: corta(e.brand, 20), t_instalacion: corta(e.installType, 10),
  puerto: e.port ?? null, vlan: e.vlan ?? null, nat: e.nat ?? null,
  asignado: corta(e.assignedRaw, 50), estado: corta(e.status, 16) || 'Bodega',
  observacion: corta(e.observation, 200), master: corta(e.master, 150),
  imagen: corta(e.image, 100), metros: e.meters ?? null, accesorios: corta(e.accessories, 20),
  id_genieacs: corta(e.genieacsId, 500),
});

/** SupplyOrder PG → columnas de `purchase`. `csd` = Supplier.legacyId. */
const invOrden = (o, csd, hoy) => ({
  tid: o.tid, csd: csd ?? 0,
  invoicedate: toD(o.orderDate) || hoy, invoiceduedate: toD(o.dueDate) || toD(o.orderDate) || hoy,
  subtotal: num(o.subtotal), shipping: num(o.shipping), discount: num(o.discount),
  tax: num(o.tax), total: num(o.total), pamnt: num(o.paidAmount),
  status: enumOnly(PURCHASE_STATUS)(o.status) || 'pendiente',
  idcat: corta(o.categoryRef, 50), notes: corta(o.notes, 255), refer: corta(o.branchRef, 20),
  items: o.itemsCount ?? 0, almacen_seleccionado: o.warehouseRef ?? null,
  recibe: o.receivedBy ?? 0, fcha_recibido: toDT(o.receivedAt),
  tipo_retencion: enumOnly(RETENCION)(o.retentionType), retencion: num(o.retention),
  // Sin equivalente en Nexus, pero NOT NULL allá: el emisor y los dos aprobadores del
  // flujo del legacy, el descuento por línea y el plazo. Cero es su "sin valor".
  eid: 0, aid: 0, a2id: 0, discstatus: 0, term: 0,
});

/** SupplyOrderItem PG → columnas de `purchase_items`. El puente es el `tid` de la orden. */
const invOrdenItem = (it, tid) => ({
  tid, pid: it.materialLegacy ?? 0, product: corta(it.product, 255),
  qty: entero(it.qty), price: num(it.price), tax: num(it.taxRate), discount: num(it.discount),
  subtotal: num(it.subtotal), totaltax: num(it.taxTotal), totaldiscount: num(it.discountTotal),
  product_des: norm(it.description), qty_en_almacen: entero(it.receivedQty),
  tipo_retencion: null,
});

// ---------- comparación (misma en ambas direcciones) ----------
const num = (v) => (v == null ? 0 : Number(String(v)));
const stableJson = (o) => JSON.stringify(o, o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort() : undefined);
// '' y null son equivalentes entre mundos: MySQL guarda '' donde Prisma guarda null
// (el writeback escribe `?? ''`). Sin esto, cada fila empujada re-aparece como "cambiada".
const blank = (v) => v == null || v === '';
const emptyishObj = (o) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.values(o).every((v) => v == null || v === '' || v === 0);
function sameVal(a, b) {
  if (blank(a) && blank(b)) return true;
  if ((a == null && emptyishObj(b)) || (b == null && emptyishObj(a))) return true;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : a == null ? null : new Date(a).getTime();
    const tb = b instanceof Date ? b.getTime() : b == null ? null : new Date(b).getTime();
    return ta === tb;
  }
  if (typeof a === 'number' || typeof b === 'number') return num(a) === num(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'object' || typeof b === 'object') return stableJson(a) === stableJson(b); // Json (jsonb reordena claves)
  return String(a) === String(b);
}
// Decimal de Prisma llega como objeto: compararlo numéricamente
const MONEY_KEYS = new Set(['balance','debitCache','creditCache','subtotal','shipping','discount','tax','total','paidAmount','debit','credit','price','taxRate','taxTotal','discountTotal','qty','cost','discRate']);

/**
 * ¿La única diferencia es que el legacy perdió la Ñ (o una tilde) y nosotros la
 * tenemos? Entonces NO es un cambio: es la misma persona con el nombre bien
 * escrito de este lado.
 *
 * El legacy guarda 'PATI?O' con un signo de interrogación de verdad (0x3F), daño
 * de hace años que se reparó aquí con `scripts/reparar-caracteres.ts`. Sin esta
 * excepción, la comparación campo a campo de `syncCustomers` vería 'PATI?O' ≠
 * 'PATIÑO' y devolvería el '?' en la siguiente pasada — cada 15 minutos, para
 * siempre. Solo se ignora en esa dirección: si el legacy cambia el apellido de
 * verdad, sigue mandando él.
 */
const soloCaracterPerdido = (legacy, nuestro) => {
  if (typeof legacy !== 'string' || typeof nuestro !== 'string') return false;
  if (!legacy.includes('?') || legacy.length !== nuestro.length) return false;
  for (let i = 0; i < legacy.length; i++) {
    if (legacy[i] === nuestro[i]) continue;
    // El legacy tiene '?' donde nosotros tenemos una letra especial: eso y nada más.
    if (legacy[i] !== '?' || !/[ÑñÁÉÍÓÚÜáéíóúü]/.test(nuestro[i])) return false;
  }
  return true;
};

const diffKeys = (mapped, pg) => Object.keys(mapped).filter((k) => {
  if (MONEY_KEYS.has(k)) return num(mapped[k]) !== num(pg[k]);
  if (sameVal(mapped[k], pg[k])) return false;
  return !soloCaracterPerdido(mapped[k], pg[k]);
});

module.exports = {
  norm, bool, dOnly, dTime, money, cleanEmail, toD, toDT,
  subStatus, ron, invStatus, invKind, svcStatus, txType, txStatus, tech, ret, eiType, payMethod,
  SUB_STATUS_INV, RON_INV, INV_STATUS_INV, KIND_INV, SVC_STATUS_INV, TX_TYPE_INV, RET_INV, PAY_INV, inv,
  mapCustomer, mapInvoice, mapItem, mapTx, esPagoDeCompra,
  invCustomer, CUSTOMER_FIELD2COLS, invInvoice, invItem, invTx, invTicket, TICKET_STATUS_INV,
  invMaterial, invEquipo, invOrden, invOrdenItem,
  urlComprobante, tieneComprobante, notaConComprobante, NOTE_MAX,
  num, stableJson, sameVal, MONEY_KEYS, diffKeys,
};
