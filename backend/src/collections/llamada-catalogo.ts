/**
 * El formulario de llamadas del legacy (`/llamadas/index?id=<cliente>`), tal cual.
 *
 * Allá son tres desplegables ENCADENADOS: el "tipo de atención" decide qué
 * "tipos de respuesta" existen, y la respuesta decide qué "detalles". La cascada
 * vivía suelta en el JavaScript de la vista (`views/llamadas/clist.php`,
 * funciones `change` y `change2`), sin nada detrás que la hiciera cumplir.
 *
 * Se trae aquí, al servidor, por dos razones:
 *
 *  1. Es lo que hace utilizable la bitácora. 110.426 llamadas históricas están
 *     escritas con EXACTAMENTE estas palabras; si el formulario nuevo deja meter
 *     texto libre o etiquetas parecidas ("Acuerdo pago", "acuerdo de Pago"), los
 *     informes de cartera dejan de agrupar y la cifra de acuerdos se parte.
 *  2. La pantalla ya no es la única puerta: el chatbot y la API pueden registrar
 *     llamadas, y el desplegable no los vigila.
 *
 * Los valores se dejan con la ortografía del legacy —'Presencial', 'whatsapp',
 * 'Para Recuperacion' sin tilde, 'sin Contestar' en minúscula— porque son los que
 * están en `llamadas.tllamada/trespuesta/drespuesta` y por los que agrupan los
 * informes. Lo que se mira en pantalla va aparte, en `label`.
 */

/** Detalle que marca un compromiso de pago (fija COMPROMISO + fecha en el cliente). */
export const ACUERDO_DE_PAGO = 'Acuerdo de Pago';

/** Detalle que dispara la revisión de un descuento (en el legacy abría una tarea). */
export const SOLICITUD_DESCUENTO = 'Solicitud de descuento';

/** Tipo+respuesta donde el detalle NO es una lista: se arma con lo que se vendió. */
export const VENTA = { tipo: 'Para Venta', respuesta: 'Venta Contestada' } as const;

export interface OpcionAtencion {
  value: string;
  label: string;
}

/** Primer desplegable: cómo se atendió al cliente. */
export const TIPOS_ATENCION: OpcionAtencion[] = [
  { value: 'Presencial', label: 'Presencial' },
  { value: 'whatsapp', label: 'Por whatsapp' },
  { value: 'Para Venta', label: 'Para Venta' },
  { value: 'Control de Calidad', label: 'Control de Calidad' },
  { value: 'Para Recuperacion', label: 'Para Recuperacion' },
  { value: 'Recibida', label: 'Llamada Recibida' },
  { value: 'Suspensión y Retiro', label: 'Suspensión y Retiro' },
];

/** Segundo desplegable, por tipo de atención (legacy `change()`). */
export const RESPUESTAS_POR_TIPO: Record<string, string[]> = {
  'Para Venta': ['Venta Contestada', 'sin Contestar'],
  'Control de Calidad': ['Control Contestado', 'sin Contestar'],
  Presencial: ['Reclamo', 'Estado de cuenta', 'Actualizar Datos', 'Pqr', 'Otros'],
  whatsapp: ['Reclamo', 'Estado de cuenta', 'Actualizar Datos', 'Pqr', 'Otros'],
  'Para Recuperacion': ['Recuperacion Contestada', 'sin Contestar', 'Mensaje'],
  Recibida: ['Contestada', 'sin Contestar', 'Reclamo', 'Estado de cuenta', 'Actualizar Datos', 'Pqr', 'Otros'],
  'Suspensión y Retiro': ['Suspensión Temporal', 'Retiro Voluntario'],
};

/**
 * Tercer desplegable, por tipo de respuesta (legacy `change2()`).
 *
 * OJO con las dos formas de escribir el acuerdo: bajo 'Recuperacion Contestada'
 * el legacy pone 'Acuerdo de Pago' y bajo 'Contestada' 'Acuerdo de pago', con
 * "pago" en minúscula. Y su formulario sólo pedía fecha de vencimiento para la
 * primera, así que los 114 acuerdos tomados desde una llamada RECIBIDA se
 * guardaron sin compromiso. Aquí se escribe una sola vez (ver `esAcuerdo`).
 */
export const DETALLES_POR_RESPUESTA: Record<string, string[]> = {
  'Control Contestado': ['Excelente', 'Bueno', 'Regular', 'Malo'],
  'Recuperacion Contestada': [ACUERDO_DE_PAGO, 'Numero equivocado', 'Cliente inconforme', 'Informado', 'No va a pagar', 'Va a pagar'],
  Contestada: [ACUERDO_DE_PAGO, 'Cliente inconforme', 'Informado', 'No va a pagar', 'Va a pagar', SOLICITUD_DESCUENTO],
  'sin Contestar': ['Correo de Voz', 'Numero no esta en uso', 'Timbra pero no contestan'],
  Reclamo: ['Mal servicio', 'Mala atencion', SOLICITUD_DESCUENTO, 'Otros'],
  'Estado de cuenta': ['Valor Incorrecto', 'No aparece pago', 'Otros'],
  'Actualizar Datos': ['De cuenta', 'Personales', 'Direccion', 'Otros'],
  Otros: ['Otros'],
  Mensaje: ['Mensaje de texto', 'Mensaje de Whatsapp', 'Otros'],
  'Suspensión Temporal': ['Suspensión por dos meses', 'Continua con el servicio', 'Llamada para activar'],
  'Retiro Voluntario': ['Mal servicio', 'Cobertura', 'Cambio Municipio', 'No lo necesita', 'Economía', 'Ya Tiene Otro Servicio', 'Continua con el servicio', 'Llamada para activar', 'Motivo personal'],
  Pqr: ['Peticion', 'Queja', 'Reclamo'],
};

/**
 * ¿Este detalle es un acuerdo de pago?
 *
 * Sin distinguir mayúsculas ni tildes: el legacy escribe 'Acuerdo de Pago' y
 * 'Acuerdo de pago' según por dónde se entre, y las dos cosas son lo mismo para
 * cartera. Lo que se GUARDA siempre se normaliza a `ACUERDO_DE_PAGO`.
 */
export const esAcuerdo = (detalle?: string | null): boolean =>
  (detalle || '').trim().toLowerCase() === ACUERDO_DE_PAGO.toLowerCase();

/** Texto con el que se guarda el detalle (unifica las dos grafías del acuerdo). */
export const normalizarDetalle = (detalle: string): string =>
  esAcuerdo(detalle) ? ACUERDO_DE_PAGO : detalle.trim();

/** ¿El detalle pide que alguien revise un descuento? */
export const esSolicitudDescuento = (detalle?: string | null): boolean =>
  (detalle || '').trim().toLowerCase() === SOLICITUD_DESCUENTO.toLowerCase();

/** ¿La pareja tipo+respuesta es la venta, donde el detalle se arma con el plan? */
export const esVentaContestada = (tipo?: string | null, respuesta?: string | null): boolean =>
  (tipo || '').trim() === VENTA.tipo && (respuesta || '').trim() === VENTA.respuesta;

/**
 * Comprueba que tipo → respuesta → detalle sea un camino que el legacy permite.
 * Devuelve el motivo del rechazo, o `null` si la combinación es válida.
 *
 * La venta contestada es la excepción: allá el detalle se compone con lo que se
 * le vendió ('Tv', '100 Megas F-26', 'Tv+100 Megas F-26'), así que no hay lista
 * contra la cual contrastar y sólo se exige que venga algo.
 */
export function motivoInvalido(tipo?: string | null, respuesta?: string | null, detalle?: string | null): string | null {
  const t = (tipo || '').trim();
  const r = (respuesta || '').trim();
  const d = (detalle || '').trim();
  if (!t) return 'Falta el tipo de atención.';
  const respuestas = RESPUESTAS_POR_TIPO[t];
  if (!respuestas) return `Tipo de atención desconocido: “${t}”.`;
  if (!r) return 'Falta el tipo de respuesta.';
  if (!respuestas.includes(r)) return `“${r}” no es un tipo de respuesta de “${t}”.`;
  if (esVentaContestada(t, r)) {
    return d ? null : 'Indique qué se vendió (TV y/o plan de internet).';
  }
  const detalles = DETALLES_POR_RESPUESTA[r];
  if (!detalles) return `“${r}” no tiene detalles definidos.`;
  if (!d) return 'Falta el detalle de la respuesta.';
  if (!detalles.some((x) => x.toLowerCase() === d.toLowerCase())) return `“${d}” no es un detalle de “${r}”.`;
  return null;
}
