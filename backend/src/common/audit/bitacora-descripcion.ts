/**
 * Traduce una fila de la bitácora a lenguaje llano.
 *
 * La bitácora guarda la petición cruda (`POST /treasury/collect` + el cuerpo), que
 * dice QUÉ endpoint se llamó pero no QUÉ HIZO el funcionario. Aquí se convierte
 * ese par (acción, cuerpo) en una frase — "Recibió un pago de $73.150 en efectivo"
 * — más el campo por el que se puede enlazar al registro afectado y un desglose
 * legible del cuerpo para el detalle.
 *
 * Todo es derivado: no se toca lo guardado (la bitácora es append-only) y las
 * filas viejas se leen igual de bien que las nuevas.
 */

export type CampoDetalle = { etiqueta: string; valor: string };

/** Tipos de registro a los que puede apuntar una fila (para resolver el nombre). */
export type RefTipo =
  | 'abonado' | 'orden' | 'factura' | 'empleado' | 'usuario' | 'plan'
  | 'material' | 'bodega-material' | 'bodega-equipos' | 'tarea' | 'movimiento'
  | 'promocion' | 'compra' | 'acta' | 'equipo';

export type Referencia = { tipo: RefTipo; id: string };

export type Descripcion = {
  /** Frase en pasado, sujeto implícito = el usuario de la fila. */
  frase: string;
  /** Registro afectado, cuando se puede señalar uno. */
  ref?: Referencia;
};

type Cuerpo = Record<string, any>;

// ---------------------------------------------------------------------------
//  Formateo
// ---------------------------------------------------------------------------

const MONEDA = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

function dinero(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? MONEDA.format(n).replace(/\s/g, ' ') : '—';
}

function txt(v: unknown, max = 90): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Entrecomilla un texto libre para meterlo dentro de la frase. */
function cita(v: unknown, max = 90): string {
  const s = txt(v, max);
  return s ? `: “${s}”` : '';
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Descripciones de los ítems de una factura/nota, para meterlas en la frase. */
function conceptos(items: unknown, max = 3): string {
  if (!Array.isArray(items)) return '';
  const nombres = items.map((i: any) => txt(i?.description ?? i?.productName, 30)).filter(Boolean);
  if (!nombres.length) return '';
  return nombres.slice(0, max).join(', ') + (nombres.length > max ? `, +${nombres.length - max}` : '');
}

function cuantos(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function fecha(v: unknown): string {
  const s = txt(v, 30);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function mes(anio: unknown, m: unknown): string {
  const i = Number(m) - 1;
  return i >= 0 && i < 12 ? `${MES[i]} de ${anio}` : txt(`${anio ?? ''} ${m ?? ''}`);
}

// --- Diccionarios de valores ---------------------------------------------

const METODO_PAGO: Record<string, string> = {
  Cash: 'efectivo', Bank: 'consignación', Card: 'tarjeta', Cheque: 'cheque',
  Balance: 'saldo a favor', WOMPI: 'Wompi', PAYU: 'PayU',
};

const ESTADO_ORDEN: Record<string, string> = {
  PENDIENTE: 'pendiente', REALIZANDO: 'en proceso', RESUELTO: 'resuelta', ANULADA: 'anulada',
};

const ESTADO_ABONADO: Record<string, string> = {
  ACTIVO: 'activo', CARTERA: 'cartera', COMPROMISO: 'compromiso', CORTADO: 'cortado',
  SUSPENDIDO: 'suspendido', RETIRADO: 'retirado', INACTIVO: 'inactivo', EXONERADO: 'exonerado',
  REPORTADO: 'reportado', DEPURADO: 'depurado', INSTALAR: 'por instalar', EVENTO: 'evento',
};

const ESTADO_TAREA: Record<string, string> = { DUE: 'pendiente', DOING: 'en curso', DONE: 'hecha', CANCELED: 'anulada' };

function dic(mapa: Record<string, string>, v: unknown, porDefecto = ''): string {
  const k = v === null || v === undefined ? '' : String(v);
  return mapa[k] ?? (k || porDefecto);
}

// ---------------------------------------------------------------------------
//  Etiquetas del desglose (modal de detalle)
// ---------------------------------------------------------------------------

const ETIQUETA: Record<string, string> = {
  amount: 'Monto', total: 'Total', subtotal: 'Subtotal', price: 'Precio', tax: 'IVA',
  discount: 'Descuento', base: 'Base', method: 'Método de pago', pmethod: 'Método de pago',
  date: 'Fecha', dueDate: 'Vence', invoiceDate: 'Fecha de factura', fecha: 'Fecha', time: 'Hora',
  note: 'Nota', notes: 'Notas', observations: 'Observaciones', reason: 'Motivo', motivo: 'Motivo',
  comment: 'Comentario', mensaje: 'Mensaje', description: 'Descripción',
  status: 'Estado', estado: 'Estado', priority: 'Prioridad', category: 'Categoría',
  name: 'Nombre', fullName: 'Nombre', firstName: 'Nombres', lastName1: 'Apellidos',
  email: 'Correo', phone: 'Teléfono', phone1: 'Celular', phone2: 'Celular alterno',
  docType: 'Tipo de documento', docNumber: 'Documento', address: 'Dirección',
  subject: 'Clase', type: 'Detalle', section: 'Descripción del caso', problem: 'Falla',
  assigned: 'Asignado a', staffId: 'Técnico', ticketId: 'Orden', subscriberId: 'Abonado',
  invoiceIds: 'Facturas', planIds: 'Planes', items: 'Ítems', qty: 'Cantidad',
  branchId: 'Sede', cashAccountId: 'Caja', accountName: 'Cuenta', supplierId: 'Beneficiario',
  fromWarehouseId: 'Bodega origen', toWarehouseId: 'Bodega destino', warehouseId: 'Bodega',
  materialId: 'Material', planId: 'Plan', sn: 'Serial (SN)', serial: 'Serial', mac: 'MAC',
  ip: 'IP', ipLocal: 'IP local', ipRemote: 'IP fija', reconectar: 'Reconectar servicio',
  lat: 'Latitud', lng: 'Longitud', accuracyM: 'Precisión GPS (m)', kind: 'Tipo',
  megas: 'Megas', pppProfile: 'Perfil PPP', taxRate: 'IVA %', active: 'Activo',
  roleKeys: 'Roles', overrides: 'Permisos propios', activos: 'Permisos activos',
  usuario: 'Usuario', creada: 'Creada', summary: 'Resumen', via: 'Canal', tramite: 'Trámite',
};

/** Claves que no aportan nada al humano (ids internos repetidos, ruido técnico). */
const OCULTAR = new Set(['password', 'passwordHash', 'token', 'firma', 'signature', 'photo', 'foto', 'file', 'base64', 'dataUrl', 'image']);

function pareceBinario(s: string): boolean {
  return s.length > 300 || /^data:[a-z/+-]+;base64,/i.test(s) || /^[A-Za-z0-9+/=]{200,}$/.test(s);
}

function valorLegible(clave: string, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  // Los enums se traducen también en el desglose: quien lee la bitácora no tiene
  // por qué saber que `Cash` es efectivo o que `RESUELTO` es una orden cerrada.
  if (typeof v === 'string') {
    if (/^(method|pmethod)$/.test(clave) && METODO_PAGO[v]) return METODO_PAGO[v];
    if (/^(status|estado)$/.test(clave) && (ESTADO_ORDEN[v] || ESTADO_ABONADO[v] || ESTADO_TAREA[v])) {
      return ESTADO_ORDEN[v] ?? ESTADO_ABONADO[v] ?? ESTADO_TAREA[v];
    }
  }
  if (typeof v === 'number') return /amount|total|price|subtotal|tax|discount|base|saldo/i.test(clave) ? dinero(v) : String(v);
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return txt(v.join(', '), 160);
    return plural(v.length, 'elemento', 'elementos');
  }
  if (typeof v === 'object') return txt(JSON.stringify(v), 160);
  const s = String(v);
  if (pareceBinario(s)) return '(archivo)';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return fecha(s);
  return txt(s, 240);
}

/** Desglose del cuerpo de la petición, ya en castellano y sin base64. */
export function desglosar(cuerpo: unknown): CampoDetalle[] {
  if (!cuerpo || typeof cuerpo !== 'object') return [];
  const b = cuerpo as Cuerpo;
  const campos: CampoDetalle[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (OCULTAR.has(k)) continue;
    const valor = valorLegible(k, v);
    if (valor === null) continue;
    campos.push({ etiqueta: ETIQUETA[k] ?? k, valor });
    if (campos.length >= 24) break;
  }
  return campos;
}

// ---------------------------------------------------------------------------
//  Reglas: (método, ruta) -> frase
// ---------------------------------------------------------------------------

type Salida = string | { frase: string; ref?: Referencia };
type Regla = { metodo: string; re: RegExp; fn: (b: Cuerpo, p: string[]) => Salida | null };

function compilar(patron: string): RegExp {
  const cuerpo = patron
    .split('/')
    .map((s) => (s.startsWith(':') ? '([^/]+)' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${cuerpo}$`);
}

const R: Regla[] = [];
/** Registra una regla. Tanto el método como la ruta admiten alternativas con `|`. */
function r(metodo: string, patron: string, fn: (b: Cuerpo, p: string[]) => Salida | null) {
  for (const m of metodo.split('|')) for (const ruta of patron.split('|')) R.push({ metodo: m, re: compilar(ruta), fn });
}

/**
 * Marca dentro de la frase un nombre que hay que ir a buscar a la base
 * (`@{empleado:cmx…|un técnico}`). `resolverReferencias` los sustituye por el
 * nombre real en una sola consulta por tipo; si el registro ya no existe, queda
 * el texto de respaldo. Sin esto la frase diría "Agendó una orden" y el nombre
 * del técnico —lo que se quiere leer— se quedaría en el id del cuerpo.
 */
export const NOMBRE_PENDIENTE = /@\{([a-z-]+):([^|}]+)\|([^}]*)\}/g;
function nombre(tipo: RefTipo, id: unknown, respaldo: string): string {
  return id && typeof id === 'string' ? `@{${tipo}:${id}|${respaldo}}` : respaldo;
}

const abonado = (id?: string): Referencia | undefined => (id ? { tipo: 'abonado', id } : undefined);
const orden = (id?: string): Referencia | undefined => (id ? { tipo: 'orden', id } : undefined);
const factura = (id?: string): Referencia | undefined => (id ? { tipo: 'factura', id } : undefined);

// --- Sesión y cuentas ------------------------------------------------------

r('POST', 'auth/logout', () => 'Cerró la sesión');
r('POST', 'auth/password/forgot', (b) => `Pidió el código para recuperar la contraseña de ${txt(b.email) || 'una cuenta'}`);
r('POST', 'auth/password/forgot/check', () => 'Verificó el código de recuperación de contraseña');
r('POST', 'auth/password/forgot/reset', () => 'Restableció la contraseña con el código de recuperación');
r('POST', 'auth/users', (b) => `Creó el usuario ${txt(b.email ?? b.name)}`);
r('PATCH', 'auth/users/:id/active', (b) => (b.active === false ? 'Inhabilitó un usuario' : 'Habilitó un usuario'));
r('PATCH', 'auth/users/:id/roles', (b) => `Cambió los roles de un usuario${b.roleKeys ? ` a ${txt(Array.isArray(b.roleKeys) ? b.roleKeys.join(', ') : b.roleKeys)}` : ''}`);
r('PATCH', 'auth/users/:id/screens', () => 'Ajustó las pantallas visibles de un usuario');
r('PATCH', 'auth/users/:id', (b) => `Editó la cuenta de un usuario${b.email ? ` (${txt(b.email)})` : ''}`);
r('POST', 'auth/users/:id/password', () => 'Cambió la contraseña de otro usuario');
r('POST', 'auth/users/:id/password/code', () => 'Envió el código para cambiar la contraseña de un usuario');
r('POST', 'auth/roles', (b) => `Creó el rol “${txt(b.name ?? b.key)}”`);
r('PATCH', 'auth/roles/:id', (b) => `Editó el rol${b.name ? ` “${txt(b.name)}”` : ''}`);
r('DELETE', 'auth/roles/:id', () => 'Eliminó un rol');
r('POST', 'portal/login', () => 'Un cliente entró al portal de pagos');
r('POST', 'portal/pay', (b) => `Un cliente pagó ${dinero(b.amount ?? b.monto)} por el portal`);

r('PATCH', 'profile', (b) => `Actualizó su perfil (${Object.keys(b).map((k) => (ETIQUETA[k] ?? k).toLowerCase()).slice(0, 5).join(', ') || 'datos personales'})`);
r('POST', 'profile/password', () => 'Cambió su contraseña');
r('POST', 'profile/password/code', () => 'Pidió el código para cambiar su contraseña');
r('POST', 'profile/photo', () => 'Cambió su foto de perfil');
r('DELETE', 'profile/photo', () => 'Quitó su foto de perfil');
r('PUT', 'profile/signature/phone', (b) => `Puso ${txt(b.phone ?? b.telefono)} como teléfono para firmar`);
r('DELETE', 'profile/signature/phone', () => 'Quitó su teléfono de firma');
r('POST', 'profile/signature/test', () => 'Se envió un código de firma de prueba');
r('POST', 'profile/signature/verify', () => 'Verificó su código de firma');

// --- Tesorería y cobranza --------------------------------------------------

r('POST', 'treasury/collect', (b) => {
  const n = cuantos(b.invoiceIds);
  const met = dic(METODO_PAGO, b.method, 'sin método');
  const partes = [`Recibió un pago de ${dinero(b.amount)} en ${met}`];
  if (n) partes.push(`por ${plural(n, 'factura', 'facturas')}`);
  if (b.reconectar) partes.push('y reconectó el servicio');
  if (b.adelantado || b.pagarSiguiente) partes.push('(incluye el mes siguiente)');
  return { frase: partes.join(' '), ref: abonado(b.subscriberId) };
});
r('POST', 'treasury/expenses', (b) => `Registró un egreso de ${dinero(b.amount)}${b.category ? ` en ${txt(b.category)}` : ''}${cita(b.note, 60)}`);
r('POST', 'treasury/income', (b) => `Registró un ingreso de ${dinero(b.amount)}${cita(b.note, 60)}`);
r('POST', 'treasury/transfer', (b) => `Trasladó ${dinero(b.amount)} entre cajas${cita(b.note, 50)}`);
r('POST', 'treasury/cash-open', (b) => `Abrió la caja del ${fecha(b.date)}${b.base ? ` con base ${dinero(b.base)}` : ''}`);
r('POST', 'treasury/cash-close', (b) => `Cerró la caja del ${fecha(b.date)}`);
r('POST', 'treasury/transactions/:id/attach', () => ({ frase: 'Adjuntó el comprobante de un movimiento' }));
r('POST', 'treasury/transactions/:id/void', (b, p) => ({ frase: `Anuló un movimiento${cita(b.reason ?? b.motivo, 70)}`, ref: { tipo: 'movimiento', id: p[0] } }));
r('PATCH', 'treasury/transactions/:id', (b, p) => ({ frase: `Corrigió un movimiento de caja${b.amount ? ` (${dinero(b.amount)})` : ''}`, ref: { tipo: 'movimiento', id: p[0] } }));
r('POST', 'treasury/beneficiaries', (b) => `Creó el beneficiario “${txt(b.name ?? b.title)}”`);
r('PATCH|DELETE', 'treasury/beneficiaries/:id', () => 'Editó un beneficiario');
r('POST', 'collections', (b) => ({ frase: `Registró una gestión de cobranza${cita(b.notes ?? b.note, 110)}`, ref: abonado(b.subscriberId) }));
r('POST', 'payment-imports/upload', () => 'Subió un archivo de pagos para cargar');
r('POST', 'payment-imports/:id/process', () => 'Aplicó un cargue de pagos por Excel');
r('POST', 'treasury/fixed-payments|treasury/pagos-fijos', (b) => `Programó un pago fijo de ${dinero(b.amount)}`);

// --- Facturación -----------------------------------------------------------

r('POST', 'billing/invoices', (b) => {
  const items = conceptos(b.items);
  return { frase: `Emitió una factura${b.total ? ` por ${dinero(b.total)}` : ''}${items ? ` (${items})` : ''}`, ref: abonado(b.subscriberId) };
});
r('PATCH', 'billing/invoices/:id', (b, p) => {
  const items = Array.isArray(b.items) ? b.items.map((i: any) => txt(i.description ?? i.productName, 30)).filter(Boolean) : [];
  return { frase: `Editó la factura${items.length ? ` (${items.slice(0, 3).join(', ')})` : ''}${cita(b.notes, 70)}`, ref: factura(p[0]) };
});
r('POST', 'billing/invoices/generate', (b) => {
  const cuando = b.month ?? b.mes ? ` de ${mes(b.year ?? b.anio, b.month ?? b.mes)}` : ' mensual';
  return `Lanzó la corrida de facturación${cuando}${b.dryRun ? ' (simulacro, sin emitir)' : ''}`;
});
r('POST', 'billing/invoices/:id/notes', (b, p) => ({ frase: `Añadió un concepto a la factura${cita(b.description, 60)}`, ref: factura(p[0]) }));
r('POST', 'billing/invoices/:id/servicio', (_b, p) => ({ frase: 'Asignó el servicio de la factura', ref: factura(p[0]) }));
r('POST', 'billing/invoices/:id/whatsapp', (_b, p) => ({ frase: 'Envió la factura por WhatsApp', ref: factura(p[0]) }));
r('POST', 'billing/notes', (b) => {
  const tipo = String(b.type ?? b.kind ?? '').toUpperCase();
  const suma = Array.isArray(b.items) ? b.items.reduce((t: number, i: any) => t + (Number(i.amount) || 0), 0) : Number(b.total) || 0;
  return `Creó una nota ${tipo === 'CREDITO' ? 'crédito' : tipo === 'DEBITO' ? 'débito' : 'contable'}${suma ? ` por ${dinero(suma)}` : ''}${cuantos(b.items) > 1 ? ` sobre ${plural(cuantos(b.items), 'factura', 'facturas')}` : ''}${cita(b.description, 80)}`;
});
r('DELETE', 'subscribers/:id/invoices/:f', (_b, p) => ({ frase: 'Eliminó una factura del abonado', ref: abonado(p[0]) }));
r('PATCH', 'subscribers/:id/invoices/:f', (_b, p) => ({ frase: 'Editó una factura del abonado', ref: factura(p[1]) }));

// --- Soporte / órdenes -----------------------------------------------------

r('POST', 'support/tickets', (b) => ({
  frase: `Abrió una orden de ${txt(b.type ?? b.subject, 40)}${b.subject && b.type ? ` (${txt(b.subject, 24)})` : ''}${b.section ? ` — ${txt(b.section, 60)}` : ''}`,
  ref: abonado(b.subscriberId),
}));
r('POST', 'support/tickets/:id/status', (b, p) => ({
  frase: `Pasó la orden a ${dic(ESTADO_ORDEN, b.status, 'otro estado')}${b.lat ? ' desde el sitio' : ''}${cita(b.solucion ?? b.note, 70)}`,
  ref: orden(p[0]),
}));
r('POST', 'support/tickets/:id/assign', (b, p) => {
  const quien = txt(b.assigned ?? b.staffName) || (b.staffId ? nombre('empleado', b.staffId, '') : '');
  return { frase: quien ? `Asignó la orden a ${quien}` : 'Quitó el técnico asignado a la orden', ref: orden(p[0]) };
});
r('POST', 'support/tickets/:id/attach', (_b, p) => ({ frase: 'Subió una foto a la orden', ref: orden(p[0]) }));
r('POST', 'support/tickets/:id/signature', (_b, p) => ({ frase: 'Guardó la firma del cliente en la orden', ref: orden(p[0]) }));
r('POST', 'support/tickets/:id/thread', (b, p) => ({ frase: `Comentó en la orden${cita(b.message ?? b.text ?? b.mensaje, 110)}`, ref: orden(p[0]) }));
r('POST', 'support/tickets/:id/materials', (b, p) => ({ frase: `Descontó material en la orden (${plural(cuantos(b.items) || 1, 'ítem', 'ítems')})`, ref: orden(p[0]) }));
r('POST', 'support/tickets/:id/equipment', (_b, p) => ({ frase: 'Instaló un equipo desde la orden', ref: orden(p[0]) }));
r('POST', 'support/tickets/:id/priority', (b, p) => ({ frase: `Cambió la prioridad de la orden a ${txt(b.priority)}`, ref: orden(p[0]) }));
r('POST', 'support/tickets/:id/onu/autenticar', (_b, p) => ({ frase: 'Autenticó la ONU desde la orden', ref: orden(p[0]) }));
r('PATCH', 'support/tickets/:id', (b, p) => ({
  frase: `Corrigió la orden (${Object.keys(b).map((k) => (ETIQUETA[k] ?? k).toLowerCase()).slice(0, 4).join(', ') || 'datos'})`,
  ref: orden(p[0]),
}));
r('POST', 'support/agenda/mover', (b) => {
  if (!b.staffId && !b.fecha) return { frase: 'Quitó una orden de la agenda', ref: orden(b.ticketId) };
  const quien = b.staffId ? ` a ${nombre('empleado', b.staffId, 'un técnico')}` : '';
  const cuando = b.fecha ? ` para el ${fecha(b.fecha)}` : '';
  return { frase: `Agendó una orden${quien}${cuando}`, ref: orden(b.ticketId) };
});
r('POST', 'support/agenda/mover-lote', (b) => `Agendó ${plural(cuantos(b.ticketIds ?? b.ids), 'orden', 'órdenes')}${b.staffId ? ` a ${nombre('empleado', b.staffId, 'un técnico')}` : ''}${b.fecha ? ` para el ${fecha(b.fecha)}` : ''}`);
r('POST', 'support/agenda/recorrido', () => 'Calculó el recorrido sugerido de la agenda');
r('POST', 'support/mi-agenda/no-atendida|support/mi-turno/no-atendida', (b) => `Marcó una visita como no atendida${cita(b.motivo ?? b.reason, 70)}`);
r('POST', 'support/subscribers/:id/equipment', (_b, p) => ({ frase: 'Asignó un equipo al abonado', ref: abonado(p[0]) }));
r('PUT', 'support/order-scores', () => 'Cambió el puntaje por tipo de orden');
r('POST', 'support/office-ips', (b) => `Actualizó las IPs de oficina (${cuantos(b.ips)})`);

// --- Abonados --------------------------------------------------------------

r('POST', 'subscribers', (b) => ({
  frase: `Dio de alta al abonado ${txt([b.firstName, b.lastName1, b.lastName2].filter(Boolean).join(' ') || b.companyName, 50)}${cuantos(b.planIds) ? ` con ${plural(cuantos(b.planIds), 'plan', 'planes')}` : ''}`,
}));
r('PATCH', 'subscribers/:id/status', (b, p) => ({
  frase: `Cambió el estado del abonado a ${dic(ESTADO_ABONADO, b.status)}${cita(b.note ?? b.motivo, 100)}`,
  ref: abonado(p[0]),
}));
r('PATCH', 'subscribers/:id', (b, p) => ({
  frase: `Editó la ficha del abonado (${Object.keys(b).map((k) => (ETIQUETA[k] ?? k).toLowerCase()).slice(0, 5).join(', ') || 'datos'})`,
  ref: abonado(p[0]),
}));
r('POST', 'subscribers/:id/plans', (b, p) => {
  // La misma llamada cambia planes y da de baja servicios ("No" en el selector): la
  // bitácora tiene que decir cuál de las dos cosas pasó, que no es lo mismo.
  const partes = [
    cuantos(b.planIds) ? plural(cuantos(b.planIds), 'plan', 'planes') : null,
    cuantos(b.remove) ? `${plural(cuantos(b.remove), 'servicio', 'servicios')} de baja: ${(b.remove as string[]).join(', ').toLowerCase()}` : null,
  ].filter(Boolean);
  return { frase: `Cambió los servicios contratados del abonado${partes.length ? ` (${partes.join('; ')})` : ''}`, ref: abonado(p[0]) };
});
r('POST', 'subscribers/:id/files', (b, p) => ({ frase: `Subió un documento del abonado${b.tipo || b.docType ? ` (${txt(b.tipo ?? b.docType, 30)})` : ''}`, ref: abonado(p[0]) }));
r('DELETE', 'subscribers/:id/files/:f', (_b, p) => ({ frase: 'Borró un documento del abonado', ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/notes', (b, p) => ({ frase: `Escribió una nota en la ficha${cita(b.note ?? b.text ?? b.nota, 110)}`, ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/house-photo', (_b, p) => ({ frase: 'Subió la foto de la vivienda', ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/carta-retiro', (_b, p) => ({ frase: 'Cargó la carta de retiro del abonado', ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/firma', (_b, p) => ({ frase: 'Registró la firma del cliente', ref: abonado(p[0]) }));
r('DELETE', 'subscribers/:id/firma', (_b, p) => ({ frase: 'Borró la firma del cliente', ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/huella', (_b, p) => ({ frase: 'Registró la huella del cliente', ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/puntos', (b, p) => ({ frase: `Ajustó los puntos adicionales de TV${b.puntos !== undefined ? ` a ${txt(b.puntos)}` : ''}`, ref: abonado(p[0]) }));
r('POST', 'subscribers/:id/equipment/:e/return', (_b, p) => ({ frase: 'Recibió el equipo devuelto por el abonado', ref: abonado(p[0]) }));
r('POST', 'subscribers/bulk/reconnect', (b) => {
  const n = cuantos(b.ids ?? b.subscriberIds);
  return `Reconectó ${n ? plural(n, 'abonado', 'abonados') : 'abonados'} en lote${b.status ? ` (los deja en ${dic(ESTADO_ABONADO, b.status)})` : ''}`;
});
r('POST', 'subscribers/check-duplicates', (b) => `Comprobó si ${txt(b.docNumber ?? b.email ?? 'el cliente', 30)} ya estaba registrado`);
r('POST', 'online-payments/clave/:id', (_b, p) => ({ frase: 'Cambió la clave del portal de pagos del cliente', ref: abonado(p[0]) }));
r('POST', 'my-promotions/:id/apply', () => 'Aplicó una promoción');

// --- Mapa / geo ------------------------------------------------------------

r('PUT', 'geo/subscribers/:id/location', (_b, p) => ({ frase: 'Ubicó al abonado en el mapa', ref: abonado(p[0]) }));
r('POST', 'geo/route', () => 'Calculó una ruta en el mapa');
r('POST', 'geo/ping', () => 'Reportó su ubicación (app del técnico)');

// --- Red: OLT, Mikrotik, GenieACS -----------------------------------------

r('POST', 'network/olt/:id/onu/provision', (b) => `Autenticó una ONU en la OLT${b.sn ? ` (SN ${txt(b.sn, 24)})` : ''}`);
r('POST', 'network/olt/:id/onu/delete', (b) => `Dio de baja una ONU de la OLT${b.sn ? ` (SN ${txt(b.sn, 24)})` : ''}`);
r('POST', 'network/olt/:id/onu/reboot', () => 'Reinició una ONU');
r('POST', 'network/olt/:id/onu/detail', () => 'Consultó el detalle de una ONU');
r('POST', 'network/olt/:id/onu/optical', () => 'Consultó la señal óptica de una ONU');
r('POST', 'network/olt/:id/onu/catv-state', () => 'Consultó el estado del puerto de TV de una ONU');
r('POST', 'network/olt/:id/onu/catv', (b) => `${b.enable === false ? 'Apagó' : 'Encendió'} el puerto de TV de una ONU`);
r('POST', 'network/olt/:id/onus', () => 'Consultó las ONUs de la OLT');
r('POST', 'network/olt/:id/test', () => 'Probó la conexión con la OLT');
r('POST', 'network/olt/:id/sync', () => 'Sincronizó las ONUs de la OLT');
r('POST', 'network/olt/auto-link', () => 'Enlazó ONUs con sus abonados automáticamente');
r('POST', 'network/olt/onus/:id/link', () => 'Enlazó una ONU con su abonado');
r('POST', 'network/olt/olts', (b) => `Registró la OLT “${txt(b.name)}”`);
r('PATCH', 'network/olt/olts/:id', (b) => `Editó la OLT${b.name ? ` “${txt(b.name)}”` : ''}`);
r('POST', 'network/olt/plan-profiles', () => 'Definió el perfil de OLT de un plan');
r('POST', 'network/olt/plan-profiles/lote', () => 'Definió perfiles de OLT en lote');
r('DELETE', 'network/olt/plan-profiles/:id', () => 'Quitó el perfil de OLT de un plan');
r('POST', 'network/mikrotik/:id/test|network/mikrotiks/:id/test', () => 'Probó la conexión con el Mikrotik');
r('PATCH', 'network/mikrotik/routers/:id', (b) => `Editó un router Mikrotik${b.name ? ` (${txt(b.name)})` : ''}`);
r('DELETE', 'network/mikrotik/routers/:id', () => 'Eliminó un router Mikrotik');
r('POST', 'network/mikrotik/routers/:id/default', () => 'Marcó un Mikrotik como predeterminado');
r('POST', 'network/genieacs/cut-tv', () => 'Cortó la TV por TR-069');
r('POST', 'network/genieacs/restore-tv', () => 'Restableció la TV por TR-069');
r('POST', 'network/genieacs/wifi', () => 'Cambió la clave del WiFi por TR-069');
r('POST', 'network/genieacs/install-provision', () => 'Aprovisionó un equipo por TR-069');
r('PATCH', 'network/genieacs/servers/:id', () => 'Editó la conexión con GenieACS');
r('POST', 'network/genieacs/servers/:id/test', () => 'Probó la conexión con GenieACS');
r('POST', 'network/naps', (b) => `Creó la NAP “${txt(b.name ?? b.code)}”`);
r('PATCH', 'network/naps/:id', () => 'Editó una NAP');
r('POST', 'network/vlans', (b) => `Creó la VLAN ${txt(b.vlan ?? b.vlanId ?? b.name, 20)}${b.detail ? ` (${txt(b.detail, 40)})` : ''}${b.olt ? ` en la OLT ${txt(b.olt, 24)}` : ''}`);
r('POST', 'network/equipment', (b) => `Registró un equipo${b.serial ? ` (serial ${txt(b.serial, 24)})` : ''}`);
r('POST', 'network/transfers', (b) => `Creó una transferencia de equipos (${plural(cuantos(b.items ?? b.equipmentIds), 'equipo', 'equipos')})`);
r('POST', 'network/transfers/:id/approve', () => 'Aprobó una transferencia de equipos');
r('POST', 'network/transfers/:id/otp', () => 'Pidió el código para firmar una transferencia');
r('POST', 'network/transfers/:id/receive', () => 'Firmó el recibido de una transferencia de equipos');
r('POST', 'network/transfers/:id/sign-out', () => 'Firmó la salida de una transferencia de equipos');

// --- Inventario ------------------------------------------------------------

r('POST', 'inventory/transfer', (b) => {
  const de = nombre('bodega-material', b.fromWarehouseId, 'otra bodega');
  const a = nombre('bodega-material', b.toWarehouseId, 'otra bodega');
  return `Traspasó material (${plural(cuantos(b.items), 'ítem', 'ítems')}) de ${de} a ${a}`;
});
r('POST', 'inventory/actas/:id/receive', (_b, p) => ({ frase: 'Firmó el recibido de un acta de material', ref: { tipo: 'acta', id: p[0] } }));
r('POST', 'inventory/actas/:id/items/:i/receive', (_b, p) => ({ frase: 'Recibió un ítem de un acta de material', ref: { tipo: 'acta', id: p[0] } }));
r('POST', 'inventory/actas/:id/otp', (_b, p) => ({ frase: 'Pidió el código para firmar un acta', ref: { tipo: 'acta', id: p[0] } }));
r('POST', 'inventory/actas/:id/send', (_b, p) => ({ frase: 'Envió un acta de material', ref: { tipo: 'acta', id: p[0] } }));
r('POST', 'inventory/materials', (b) => `Creó el material “${txt(b.name)}”`);
r('PATCH', 'inventory/materials/:id', (b, p) => ({ frase: `Editó un material${b.name ? ` (${txt(b.name)})` : ''}`, ref: { tipo: 'material', id: p[0] } }));
r('DELETE', 'inventory/materials/:id', () => 'Eliminó un material');
r('POST', 'inventory/warehouses', (b) => `Creó la bodega “${txt(b.title ?? b.name)}”`);
r('PATCH', 'inventory/warehouses/:id', () => 'Editó una bodega');
r('DELETE', 'inventory/warehouses/:id', () => 'Eliminó una bodega');
r('POST', 'inventory/alerts/run', () => 'Revisó las alertas de stock');
r('POST', 'inventory/alerts/read-all', () => 'Marcó como leídas las alertas de stock');
r('POST', 'data/import/equipment', () => 'Importó equipos desde un archivo');

// --- Compras ---------------------------------------------------------------

r('POST', 'orders', (b) => `Creó una orden de compra${b.total ? ` por ${dinero(b.total)}` : ''}`);
r('PATCH', 'orders/:id', (_b, p) => ({ frase: 'Editó una orden de compra', ref: { tipo: 'compra', id: p[0] } }));
r('DELETE', 'orders/:id', () => 'Eliminó una orden de compra');
r('POST', 'orders/:id/approve', (_b, p) => ({ frase: 'Aprobó una orden de compra', ref: { tipo: 'compra', id: p[0] } }));
r('POST', 'orders/:id/approve/otp', () => 'Pidió el código para aprobar una compra');
r('POST', 'orders/:id/cancel', (b, p) => ({ frase: `Anuló una orden de compra${cita(b.reason ?? b.motivo, 60)}`, ref: { tipo: 'compra', id: p[0] } }));
r('POST', 'orders/:id/pay', (b, p) => ({ frase: `Registró el pago de una orden de compra${b.amount ? ` (${dinero(b.amount)})` : ''}`, ref: { tipo: 'compra', id: p[0] } }));
r('POST', 'orders/:id/files', (_b, p) => ({ frase: 'Adjuntó un archivo a una orden de compra', ref: { tipo: 'compra', id: p[0] } }));
r('POST', 'orders/categories', (b) => `Creó la categoría de compras “${txt(b.name)}”`);
r('PATCH|DELETE', 'orders/categories/:id', () => 'Cambió una categoría de compras');
r('POST', 'orders/suppliers', (b) => `Creó el proveedor “${txt(b.name)}”`);
r('PATCH', 'orders/suppliers/:id', () => 'Editó un proveedor');
r('POST', 'payments/orders', () => 'Generó un pago de compras');
r('POST', 'payments/webhook/wompi', () => 'Wompi confirmó un pago');

// --- Planes, promociones, catálogo ----------------------------------------

r('POST', 'plans', (b) => `Creó el plan “${txt(b.name)}”${b.price ? ` (${dinero(b.price)})` : ''}`);
r('PATCH', 'plans/:id', (b, p) => {
  const soloVisibilidad = Object.keys(b).length === 1 && b.active !== undefined;
  const frase = soloVisibilidad
    ? `${b.active ? 'Mostró' : 'Ocultó'} un plan en el catálogo`
    : `Editó un plan${b.name ? ` “${txt(b.name)}”` : ''}${b.price !== undefined ? ` — precio ${dinero(b.price)}` : ''}`;
  return { frase, ref: { tipo: 'plan', id: p[0] } };
});
r('DELETE', 'plans/:id', () => 'Eliminó un plan');
r('POST', 'plan-bundles', (b) => `Creó el combo “${txt(b.name)}”`);
r('PATCH', 'plan-bundles/:id', (b) => `Editó un combo${b.name ? ` “${txt(b.name)}”` : ''}`);
r('DELETE', 'plan-bundles/:id', () => 'Eliminó un combo');
r('POST', 'promotions', (b) => `Creó la promoción “${txt(b.name)}”`);
r('PUT', 'promotions/:id', (b, p) => ({ frase: `Editó la promoción${b.name ? ` “${txt(b.name)}”` : ''}`, ref: { tipo: 'promocion', id: p[0] } }));
r('DELETE', 'promotions/:id', () => 'Eliminó una promoción');
r('POST', 'promotions/audience', () => 'Calculó el público de una promoción');
r('DELETE', 'promotions/templates/:id', () => 'Eliminó una plantilla de promoción');
r('POST', 'clausulas', (b) => `Creó la cláusula de permanencia “${txt(b.nombre ?? b.name)}”${b.meses ? ` (${plural(Number(b.meses), 'mes', 'meses')})` : ''}`);
r('DELETE', 'clausulas/:id', () => 'Eliminó una cláusula de permanencia');
r('POST', 'config/categories', (b) => `Creó la categoría “${txt(b.name)}”`);
r('PATCH|DELETE', 'config/categories/:id', () => 'Cambió una categoría');
r('PUT', 'settings', () => 'Cambió los ajustes del sistema');
r('PUT', 'settings/goals', () => 'Cambió las metas del tablero');
r('PUT', 'responsibilities/call-center', () => 'Cambió los responsables del call center');
r('POST', 'extras/documents', (b) => `Subió un documento${b.name ? ` “${txt(b.name)}”` : ''}`);

// --- Tareas y proyectos ----------------------------------------------------

r('POST', 'tasks', (b) => `Creó la tarea${cita(b.name ?? b.title, 80)}`);
r('PATCH', 'tasks/:id', (b, p) => ({
  frase: b.status ? `Pasó una tarea a ${dic(ESTADO_TAREA, b.status)}` : 'Editó una tarea',
  ref: { tipo: 'tarea', id: p[0] },
}));
r('DELETE', 'tasks/:id', () => 'Eliminó una tarea');
r('POST', 'projects', (b) => `Creó el proyecto “${txt(b.name)}”`);
r('PATCH', 'projects/:id', (b) => `Editó un proyecto${b.name ? ` “${txt(b.name)}”` : ''}${b.progress !== undefined ? ` (avance ${txt(b.progress)}%)` : ''}`);
r('DELETE', 'projects/:id', () => 'Eliminó un proyecto');
r('POST', 'projects/:id/milestones', (b) => `Creó un hito de proyecto${cita(b.name ?? b.title, 60)}`);
r('PATCH', 'projects/milestones/:id', () => 'Editó un hito de proyecto');
r('DELETE', 'projects/milestones/:id', () => 'Eliminó un hito de proyecto');

// --- Personal --------------------------------------------------------------

r('POST', 'staff', (b) => `Creó la ficha de ${txt(b.name)}`);
r('PATCH', 'staff/:id', (b, p) => ({ frase: `Editó la ficha de un empleado${b.name ? ` (${txt(b.name)})` : ''}`, ref: { tipo: 'empleado', id: p[0] } }));
r('POST', 'staff/:id/account', (b, p) => ({ frase: `Creó el acceso al sistema de un empleado${b.email ? ` (${txt(b.email)})` : ''}`, ref: { tipo: 'empleado', id: p[0] } }));
r('POST', 'staff/:id/account/password', (_b, p) => ({ frase: 'Cambió la contraseña de un empleado', ref: { tipo: 'empleado', id: p[0] } }));
r('PATCH', 'staff/:id/account/active', (b, p) => ({ frase: b.active === false ? 'Inhabilitó el acceso de un empleado' : 'Habilitó el acceso de un empleado', ref: { tipo: 'empleado', id: p[0] } }));
r('PATCH', 'staff/:id/permissions', (_b, p) => ({ frase: 'Cambió los permisos de un empleado', ref: { tipo: 'empleado', id: p[0] } }));
r('PATCH', 'staff/:id/roles', (_b, p) => ({ frase: 'Cambió los roles de un empleado', ref: { tipo: 'empleado', id: p[0] } }));
r('POST', 'staff/:id/documents', (_b, p) => ({ frase: 'Subió un documento de un empleado', ref: { tipo: 'empleado', id: p[0] } }));
r('DELETE', 'staff/:id/documents/:d', (_b, p) => ({ frase: 'Borró un documento de un empleado', ref: { tipo: 'empleado', id: p[0] } }));

// --- Facturación electrónica y contabilidad -------------------------------

r('POST', 'einvoice/emit/:id', (_b, p) => ({ frase: 'Timbró una factura electrónica', ref: factura(p[0]) }));
r('POST', 'einvoice/emit-branch/:id', () => 'Timbró las facturas electrónicas de una sede');
r('POST', 'einvoice/eflags-bulk|einvoice/branches/:id/eflags-bulk', () => 'Cambió en lote quién recibe factura electrónica');
r('PATCH', 'einvoice/subscribers/:id/eflags', (_b, p) => ({ frase: 'Cambió la facturación electrónica del abonado', ref: abonado(p[0]) }));
r('PATCH', 'einvoice/accounts/:id', () => 'Editó la cuenta de facturación electrónica');
r('POST', 'einvoice/accounts/:id/test', () => 'Probó la conexión con Siigo');
r('POST', 'accounting/periods', (b) => `Abrió el periodo contable ${mes(b.year ?? b.anio, b.month ?? b.mes)}`);
r('POST', 'accounting/periods/:id/close', () => 'Cerró un periodo contable');
r('POST', 'accounting/periods/:id/reopen', () => 'Reabrió un periodo contable');

// --- PlayHub ---------------------------------------------------------------

r('POST', 'playhub/subscribers/:id/subscribe', (_b, p) => ({ frase: 'Activó PlayHub al abonado', ref: abonado(p[0]) }));
r('POST', 'playhub/subscribers/:id/unsubscribe', (_b, p) => ({ frase: 'Desactivó PlayHub al abonado', ref: abonado(p[0]) }));
r('POST', 'playhub/subscribers/:id/sync-customer|playhub/subscribers/:id/sync-local', (_b, p) => ({ frase: 'Sincronizó PlayHub con el abonado', ref: abonado(p[0]) }));
r('POST', 'playhub/sync-all', () => 'Sincronizó PlayHub con todos los abonados');

// --- WhatsApp, chatbot, avisos --------------------------------------------

r('POST', 'whatsapp/conversaciones/:tel/leido', (_b, p) => `Marcó como leído el chat de ${p[0]}`);
r('POST', 'whatsapp/conversaciones/:tel/asignar', (_b, p) => `Tomó el chat de ${p[0]} (el bot se calla)`);
r('POST', 'whatsapp/conversaciones/:tel/devolver-bot', (_b, p) => `Devolvió al bot el chat de ${p[0]}`);
r('POST', 'whatsapp/conversaciones/:tel/resolver', (_b, p) => `Cerró el chat de ${p[0]}`);
r('POST', 'whatsapp/conversaciones/:tel/responder', (b, p) => `Respondió por WhatsApp a ${p[0]}${cita(b.mensaje ?? b.text, 90)}`);
r('POST', 'admin/whatsapp/test', (b) => `Envió un WhatsApp de prueba${b.to || b.telefono ? ` a ${txt(b.to ?? b.telefono, 20)}` : ''}`);
r('PUT', 'admin/chatbot/allowlist', () => 'Cambió la lista de números permitidos del chatbot');
r('DELETE', 'admin/chatbot/vinculos/:id', () => 'Quitó un vínculo de WhatsApp con un abonado');
r('POST', 'chatbot/web', (b) => `Escribió al asistente${cita(b.message ?? b.mensaje, 90)}`);
r('POST', 'search/ai', (b) => `Buscó con lenguaje natural${cita(b.q ?? b.query ?? b.texto, 80)}`);
r('POST', 'notifications/:id/read', () => 'Leyó un aviso');
r('POST', 'notifications/read-all', () => 'Marcó todos los avisos como leídos');
r('POST', 'admin/api-keys', (b) => `Creó una llave de API${b.name ? ` “${txt(b.name)}”` : ''}`);
r('POST', 'admin/api-keys/:id/revoke', () => 'Revocó una llave de API');
r('POST', 'cron/run/:tarea', (_b, p) => `Ejecutó a mano la tarea programada “${p[0]}”`);

// ---------------------------------------------------------------------------
//  Acciones que no son peticiones HTTP (las escriben los servicios)
// ---------------------------------------------------------------------------

const SUELTAS: Record<string, (b: Cuerpo, entityId: string | null) => Salida> = {
  LOGIN: () => 'Inició sesión',
  LOGIN_FAILED: (b) => `Falló al iniciar sesión${b.email ? ` (${txt(b.email)})` : ''}`,
  PASSWORD_FORGOT: (b) => `Pidió recuperar la contraseña${b.email ? ` de ${txt(b.email)}` : ''}`,
  PASSWORD_FORGOT_RESET: () => 'Restableció su contraseña con el código enviado',
  PASSWORD_FORGOT_UNKNOWN: (b) => `Pidió recuperar la contraseña de un correo que no existe${b.email ? ` (${txt(b.email)})` : ''}`,
  PORTAL_PASSWORD: (b, id) => ({
    frase: `${b.creada ? 'Creó' : 'Cambió'} la clave del portal de pagos del cliente${b.usuario ? ` (usuario ${txt(b.usuario, 20)})` : ''}`,
    ref: abonado(id ?? undefined),
  }),
  UPDATE: (b, id) => ({ frase: `Editó la factura${b.total ? ` (total ${dinero(b.total)})` : ''}`, ref: factura(id ?? undefined) }),
  VOID: (b, id) => ({ frase: `Anuló la factura${cita(b.reason, 100)}`, ref: factura(id ?? undefined) }),
  'profile.update': () => 'Actualizó sus datos de perfil',
  'profile.password': () => 'Cambió su contraseña',
  'profile.photo': () => 'Cambió su foto de perfil',
  'profile.photo.delete': () => 'Quitó su foto de perfil',
  'staff.update': (b, id) => ({ frase: `Editó la ficha de ${txt(b.name) || 'un empleado'}`, ref: id ? { tipo: 'empleado', id } : undefined }),
  'reports.pdf.whatsapp': (b) => `Envió por WhatsApp el reporte ${txt(b.reporte ?? b.summary, 80)}`,
  'support.ticket.create': (b) => `El chatbot abrió una orden${b.summary ? `: ${txt(b.summary, 110)}` : ''}`,
};

// ---------------------------------------------------------------------------
//  Entrada pública
// ---------------------------------------------------------------------------

/** Verbo de respaldo cuando ninguna regla encaja. */
const VERBO: Record<string, string> = { POST: 'Registró', PATCH: 'Modificó', PUT: 'Modificó', DELETE: 'Eliminó' };

/** Módulos → nombre humano, para la frase de respaldo. */
const MODULO: Record<string, string> = {
  subscribers: 'abonados', billing: 'facturación', treasury: 'tesorería', support: 'soporte',
  inventory: 'inventario', network: 'red', orders: 'compras', staff: 'personal', auth: 'usuarios',
  plans: 'planes', promotions: 'promociones', tasks: 'tareas', geo: 'mapa', einvoice: 'facturación electrónica',
  accounting: 'contabilidad', playhub: 'PlayHub', whatsapp: 'WhatsApp', collections: 'cobranza',
  notifications: 'avisos', admin: 'administración', profile: 'perfil', reports: 'reportes',
  'plan-bundles': 'combos', 'payment-imports': 'cargue de pagos', 'online-payments': 'pagos en línea',
  projects: 'proyectos', settings: 'ajustes', config: 'configuración', extras: 'documentos',
};

/** Deja la frase legible sin ir a la base: cada nombre pendiente cae a su respaldo. */
export function fraseSinNombres(frase: string): string {
  return frase.replace(NOMBRE_PENDIENTE, (_m, _t, _id, respaldo) => respaldo);
}

export function describir(entrada: {
  action: string;
  entity: string;
  entityId: string | null;
  after?: unknown;
  before?: unknown;
}): Descripcion {
  const cuerpo: Cuerpo = entrada.after && typeof entrada.after === 'object' ? (entrada.after as Cuerpo) : {};

  // Acciones escritas por los servicios (no son un verbo HTTP).
  const suelta = SUELTAS[entrada.action];
  if (suelta) return normalizar(suelta(cuerpo, entrada.entityId));

  // Filas que ya vienen redactadas por el servicio que las escribió (staff.service
  // guarda "Actualizó los permisos"): se dejan tal cual, no se les pone verbo encima.
  if (!/^[A-Z]+ \//.test(entrada.action) && /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+ /.test(entrada.action)) {
    const ref = entrada.entity === 'staff-access' && entrada.entityId ? { tipo: 'empleado' as RefTipo, id: entrada.entityId } : undefined;
    return { frase: entrada.action, ref };
  }

  const esp = entrada.action.indexOf(' ');
  const metodo = esp > 0 ? entrada.action.slice(0, esp) : entrada.action;
  const ruta = (esp > 0 ? entrada.action.slice(esp + 1) : '').replace(/^\/+/, '').split('?')[0].replace(/\/+$/, '');

  if (ruta) {
    for (const regla of R) {
      if (regla.metodo !== metodo) continue;
      const m = regla.re.exec(ruta);
      if (!m) continue;
      const salida = regla.fn(cuerpo, m.slice(1));
      if (salida) return normalizar(salida);
    }
  }

  // Respaldo: aunque no haya regla, que la fila diga algo en castellano.
  if (typeof cuerpo.summary === 'string') return { frase: txt(cuerpo.summary, 140) };
  // Filas antiguas sin ruta (el interceptor viejo guardaba sólo el método).
  if (!ruta) {
    if (entrada.entity === 'login') return { frase: 'Inició sesión' };
    return { frase: `${VERBO[metodo] ?? 'Hizo'} un cambio en ${MODULO[entrada.entity] ?? entrada.entity}` };
  }
  const seg = ruta.split('/').filter(Boolean);
  const donde = MODULO[seg[0]] ?? (seg[0] || entrada.entity);
  const verbo = VERBO[metodo] ?? 'Hizo un cambio en';
  const que = seg.slice(1).filter((s) => !/^c[a-z0-9]{20,}$/.test(s) && !/^\d+$/.test(s)).join(' / ');
  return { frase: `${verbo} un cambio en ${donde}${que ? ` (${que})` : ''}` };
}

function normalizar(s: Salida): Descripcion {
  return typeof s === 'string' ? { frase: s } : s;
}
