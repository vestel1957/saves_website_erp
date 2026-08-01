/**
 * Las clases de orden y sus detalles, tal como los usa el legacy.
 *
 * En `tickets` del legacy hay dos columnas y no una: `subject` dice QUÉ CLASE de
 * orden es —servicio (261.208), reclamo (59.170) o incidente (22)— y `detalle` el
 * trabajo concreto ('Corte Internet', 'Revision de Internet'). Aquí llegaron como
 * `Ticket.subject` y `Ticket.type`.
 *
 * El formulario de la web NO respetaba eso: pedía un "Asunto" de texto libre que
 * caía en `subject`, así que las órdenes nuevas escribían prosa donde el resto de
 * la base tiene una de tres palabras. Este catálogo existe para cerrar esa puerta.
 *
 * QUÉ SE INCLUYE. Los detalles que el legacy usó en los últimos 12 meses, en orden
 * de uso, sin las erratas ('Suspencion', 'Revision_de_television', 'Seleccine...')
 * ni los vacíos. Algunos nombres parecen cortados porque LO ESTÁN: `detalle` es
 * `varchar(50)` allá, y se dejan igual que en los datos históricos para que los
 * reportes sigan agrupando por el mismo texto.
 *
 * No es una lista cerrada para toda la API: el chatbot abre órdenes con tipos
 * propios ('PQR', 'Cambio de titular') y esos siguen siendo válidos. Lo que este
 * catálogo garantiza es lo que se ofrece en la web.
 */

export const CLASES_ORDEN = ['servicio', 'reclamo', 'incidente'] as const;
export type ClaseOrden = (typeof CLASES_ORDEN)[number];

export const ETIQUETA_CLASE: Record<ClaseOrden, string> = {
  servicio: 'Orden de servicio',
  reclamo: 'Orden de reclamo',
  incidente: 'Incidente',
};

/** Qué es cada clase, para que quien abre la orden elija bien. */
export const DESCRIPCION_CLASE: Record<ClaseOrden, string> = {
  servicio: 'Trabajo sobre el servicio: cortes, reconexiones, instalaciones, cambios de plan o de equipo.',
  reclamo: 'El cliente reporta que algo no funciona y hay que ir a revisar.',
  incidente: 'Falla o inconformidad que no es una visita de rutina (plataformas, intermitencias).',
};

export const DETALLES_POR_CLASE: Record<ClaseOrden, string[]> = {
  servicio: [
    'Corte Internet',
    'Reconexion Internet',
    'Reconexion Internet2',
    'Corte Television',
    'Reconexion Television',
    'Reconexion Television2',
    'Corte Combo',
    'Reconexion Combo',
    'Reconexion Combo2',
    'Instalacion',
    'Reinstalación',
    'Autenticacion',
    'Activacion',
    'Cambio de clave',
    'Cambio de equipo',
    'Traslado',
    'Traslado interno De Equipos Red en cliente final',
    'Migracion',
    'Subir megas',
    'Bajar megas',
    'Punto nuevo',
    'Toma Adicional',
    'Equipo adicional',
    'AgregarInternet',
    'AgregarTelevision',
    'Suspension Internet',
    'Suspension Television',
    'Suspension Combo',
    'Retiro voluntario',
    'Recuperación cable modem',
    'Mejoramiento y/o Mantenimiento Red Fibra Óptica',
    'Instalación y/o Mantenimiento de Equipos Activos d',
    'Revisión y/o Configuración De Equipos De Red Lan D',
    'Viabilidad y/o levantamiento técnico',
    'Veeduria',
    'Entrega De Servicio A Satisfacción',
    'Servicio Adicional',
  ],
  reclamo: [
    'Revision de Internet',
    'Revision de television',
    'Revision tv e internet',
    'Reinstalación',
    'Activacion',
    'Otros',
  ],
  incidente: [
    'Soporte Acceso A Plataformas y/o URL’s',
    'Inconformidad Por Intermitencia En El Servicio de',
  ],
};

/** Catálogo listo para el selector de la web. */
export function catalogoDeOrdenes() {
  return CLASES_ORDEN.map((clase) => ({
    clase,
    etiqueta: ETIQUETA_CLASE[clase],
    descripcion: DESCRIPCION_CLASE[clase],
    detalles: DETALLES_POR_CLASE[clase],
  }));
}

const normalizar = (s: string) => s.trim().toLowerCase();

export function esClaseOrden(v: unknown): v is ClaseOrden {
  return typeof v === 'string' && (CLASES_ORDEN as readonly string[]).includes(normalizar(v));
}

/**
 * La clase a la que pertenece un detalle. Sirve para las órdenes que llegan por
 * otros canales (el chatbot manda 'Revision de Internet' sin decir que es un
 * reclamo): se deduce del trabajo en vez de dejar la columna a medias.
 */
export function claseDeDetalle(detalle?: string | null): ClaseOrden | null {
  const d = normalizar(detalle ?? '');
  if (!d) return null;
  for (const clase of CLASES_ORDEN) {
    if (DETALLES_POR_CLASE[clase].some((x) => normalizar(x) === d)) return clase;
  }
  return null;
}

/**
 * Resuelve la clase con la que se guarda la orden.
 *
 * Prioridad: lo que mande el formulario (que solo puede ser una de las tres) → la
 * clase del detalle → 'servicio', que es el 81% de las órdenes de la casa.
 */
export function resolverClase(subject?: string | null, detalle?: string | null): ClaseOrden {
  if (esClaseOrden(subject)) return normalizar(subject!) as ClaseOrden;
  return claseDeDetalle(detalle) ?? 'servicio';
}
