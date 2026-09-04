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

/**
 * Reconexión temporal del combo: se le devuelve internet y TV por un número de
 * días pactado y al vencer vuelve a ser cortable.
 *
 * Es el único detalle de este catálogo que NO viene del legacy —allá no existe—,
 * y el único que necesita un dato extra en la orden (`Ticket.graceDays`). Se
 * nombra en una constante porque hay tres sitios que tienen que reconocerlo sin
 * depender de cómo esté escrito: el formulario que pide los días, la cascada de
 * cierre que fija el plazo y la ficha del cliente que lo muestra.
 *
 * Sin tilde y sin "í" a propósito: `tickets.detalle` del legacy es `varchar(50)`
 * y el resto del catálogo tampoco las lleva ('Reconexion Internet'), así que los
 * reportes agrupan por el mismo texto.
 */
export const RECONEXION_COMBO_POR_DIAS = 'Reconexion Combo por dias';

/** ¿Este tipo de orden concede servicio por un plazo en días? */
export const esReconexionPorDias = (tipo?: string | null): boolean =>
  (tipo || '').trim().toLowerCase() === RECONEXION_COMBO_POR_DIAS.toLowerCase();

/** Tope de días que se pueden conceder de una vez. */
export const MAX_DIAS_GRACIA = 30;

/**
 * La baja del cliente: deja de ser abonado y se le recoge el equipo.
 *
 * Se nombra en una constante porque hay tres sitios que tienen que reconocerla sin
 * depender de cómo esté escrita: el catálogo de detalles, el formulario que pide el
 * motivo y la validación que lo exige al abrir la orden.
 */
export const RETIRO_VOLUNTARIO = 'Retiro voluntario';

/** ¿Esta orden es la baja voluntaria del cliente? */
export const esRetiroVoluntario = (tipo?: string | null): boolean =>
  (tipo || '').trim().toLowerCase() === RETIRO_VOLUNTARIO.toLowerCase();

/**
 * POR QUÉ se va el cliente. Es el único dato que la orden de retiro pide aparte, y
 * el que contesta la pregunta que se hace todos los meses en gerencia: "¿por qué
 * perdimos 40 clientes?".
 *
 * Es la misma lista del legacy (`views/quotes/newquote.php`, desplegable
 * `motretiro`) y se guarda en el mismo sitio: `tickets.problema` allá,
 * `Ticket.problem` aquí. Por eso los textos van EXACTOS —con "mal servicio" en
 * minúscula y "Economico" sin tilde—: en la base ya hay 1.914 retiros agrupados por
 * ese texto y cambiarle una letra parte el histórico en dos.
 *
 * El orden es el del legacy, que no es alfabético sino el de uso: las primeras son
 * las que se eligen a diario ("mal servicio", 720; "No necesita el servicio", 478;
 * "Traslado de municipio", 347) y las de abajo, las que casi no se usan.
 */
export const MOTIVOS_RETIRO = [
  'mal servicio',
  'Cambio de proveedor',
  'No necesita el servicio',
  'No tenemos cobertura',
  'Traslado de municipio',
  'Motivo personal',
  'Economico',
  'Cambio de municipio que no cuenta con cobertura',
  'Intermitencia constante del servicio',
  'Inconvenientes con la velocidad del servicio',
  'Falta de recursos economicos',
  'Requerimiento de television lineal',
  'Inconveniente con el funcionamiento de iptv',
  'Inconformidad con la parrilla de IPTV',
  'Servicios de valor agregado de otro operador',
  'Inconformidad con la tarifa',
  'Cambio de Residencia',
  'Ya no requiere el servicio',
  'Cesión del contrato',
  'Tiempo de respuesta de una solicitud de traslado',
] as const;

/**
 * El motivo TAL COMO se guarda, o null si no es uno de la lista.
 *
 * Compara sin distinguir mayúsculas ni espacios de más y devuelve el texto del
 * catálogo, no el que llegó: así lo que entra por el chatbot ('MAL SERVICIO') no
 * abre una tercera forma de escribir lo mismo en la columna por la que agrupan los
 * informes de retiros.
 */
export function motivoDeRetiroCanonico(v?: string | null): string | null {
  const m = (v || '').trim().toLowerCase();
  if (!m) return null;
  return MOTIVOS_RETIRO.find((x) => x.toLowerCase() === m) ?? null;
}

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
    RECONEXION_COMBO_POR_DIAS,
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
    RETIRO_VOLUNTARIO,
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

// ---------------------------------------------------------------------------
// Reconexión que ARRASTRA mes sin facturar (los tipos terminados en "2")
// ---------------------------------------------------------------------------

/**
 * Los tres tipos del legacy que terminan en "2" no son una errata ni un duplicado:
 * son la reconexión de quien venía cortado DESDE UN MES ANTERIOR, y por eso llevan
 * cobro. Mientras estuvo cortado nadie le facturó ese servicio, así que al volver
 * se le cobran los días que quedan del mes (ver `billing/prorrateo-reconexion.ts`).
 *
 * La reconexión SIN "2" es la del que se cortó este mismo mes: su mensualidad ya
 * está facturada y no se le cobra nada.
 *
 * El sufijo va pegado y sin espacio ('Reconexion Internet2') porque así está en las
 * 15.178 órdenes históricas del legacy y así agrupan sus informes.
 */
export const RECONEXIONES_CON_ARRASTRE = [
  'Reconexion Internet2',
  'Reconexion Television2',
  'Reconexion Combo2',
] as const;

/** 'Reconexion Internet' → 'Reconexion Internet2'. Si ya lo lleva, lo deja igual. */
export function tipoConArrastre(tipo: string): string {
  const t = (tipo || '').trim();
  const con = `${t}2`;
  if ((RECONEXIONES_CON_ARRASTRE as readonly string[]).includes(t)) return t;
  return (RECONEXIONES_CON_ARRASTRE as readonly string[]).includes(con) ? con : t;
}

/** ¿Este tipo de orden es de las que arrastran mes sin facturar (y por tanto cobran)? */
export function esReconexionConArrastre(tipo?: string | null): boolean {
  const t = (tipo || '').trim().toLowerCase();
  return (RECONEXIONES_CON_ARRASTRE as readonly string[]).some((x) => x.toLowerCase() === t);
}

/** Los dos servicios que se cortan y se devuelven por separado, en equipos distintos. */
export type ServicioDeOrden = 'INTERNET' | 'TV';

/**
 * QUÉ SERVICIO toca una orden, por su nombre.
 *
 * El nombre del detalle es lo único que dice si el trabajo es sobre el internet, la
 * televisión o los dos, y eso decide a qué equipo hay que hablarle: el internet vive
 * en el Mikrotik y la TV en el CPE (TR-069) o en el puerto CATV de la OLT. Son cajas
 * distintas: tocar una no hace nada en la otra.
 *
 * No es un matiz. La cascada de cierre trataba todas las órdenes igual —al cerrar
 * cualquier reconexión reconectaba el Mikrotik y nada más—, así que cerrar una
 * 'Reconexion Television' devolvía el internet (a veces a quien seguía debiendo) y
 * dejaba al cliente mirando una pantalla negra, y cerrar un 'Corte Television' le
 * cortaba el internet a alguien que solo debía perder la TV.
 *
 * Las genéricas ('Reconexion', 'Activacion', 'Retiro voluntario') piden los dos: se
 * resuelven aguas abajo contra lo que el abonado tenga contratado.
 */
export function serviciosDeOrden(tipo?: string | null): ServicioDeOrden[] {
  const t = normalizar(tipo ?? '');
  if (t.includes('combo')) return ['INTERNET', 'TV'];
  if (t.includes('televi')) return ['TV'];
  if (t.includes('internet')) return ['INTERNET'];
  return ['INTERNET', 'TV'];
}

/** Qué servicio(s) devuelve un tipo de reconexión: para saber qué prorratear. */
export function serviciosDeReconexion(tipo?: string | null): ServicioDeOrden[] {
  const t = normalizar(tipo ?? '');
  if (!t.startsWith('reconexion') && !t.startsWith('activacion')) return [];
  return serviciosDeOrden(tipo);
}

/**
 * ¿La orden es una reconexión?
 *
 * Se usa para NO exigir la firma de quien recibe al cerrarla: la reconexión se
 * hace desde el sistema (vuelve el internet y la TV al pagar) y casi nunca hay
 * alguien enfrente que firme el acta. Exigirla dejaba órdenes ya cumplidas sin
 * poder cerrarse. El resto de las órdenes sí la sigue pidiendo.
 *
 * Cubre las tres del legacy, sus variantes con arrastre ("...2"), la reconexión
 * por días y una 'Reconexion' a secas.
 */
export function esReconexion(tipo?: string | null): boolean {
  return normalizar(tipo ?? '').startsWith('reconexion');
}

/**
 * El TRASLADO de domicilio: el cliente se muda y hay que llevarle el servicio a la
 * casa nueva. Es el otro detalle del catálogo que necesita un dato que ninguno más
 * pide —la dirección destino— y el único que trae un cargo propio: el producto
 * 'Traslado' del catálogo, 30.000 sin IVA, como lo lleva facturando el legacy
 * (3.875 renglones).
 */
export const TRASLADO = 'Traslado';

/**
 * ¿Esta orden mueve al cliente de casa?
 *
 * A propósito NO cubre 'Traslado interno De Equipos Red en cliente final', que es
 * mover el equipo de sitio DENTRO de la misma vivienda: ese no cambia la dirección
 * ni se cobra como traslado. Por eso se compara el texto entero y no `includes`,
 * que es como lo mira la cascada de cierre (donde sí valen los dos, porque la nota
 * que deja sirve para ambos).
 */
export const esTraslado = (tipo?: string | null): boolean =>
  normalizar(tipo ?? '') === normalizar(TRASLADO);

/**
 * AGREGAR INTERNET: al cliente que hoy solo tiene televisión se le monta también el
 * internet (758 órdenes en el histórico del legacy).
 *
 * Va escrito sin espacio y sin tilde porque así está en `tickets.detalle` del
 * legacy —`varchar(50)`— y así agrupan sus informes; escribirlo "Agregar Internet"
 * partiría en dos el mismo trabajo.
 *
 * Es el segundo detalle del catálogo con cobro propio: se le factura un pago único
 * al abrir la orden (ver `billing/cargos-orden.ts`). El hermano
 * 'AgregarTelevision' NO se cobra por ahora: añadirlo es una entrada más en esa
 * lista el día que contabilidad lo pida.
 */
export const AGREGAR_INTERNET = 'AgregarInternet';

/** ¿Esta orden le monta internet a quien todavía no lo tiene? */
export const esAgregarInternet = (tipo?: string | null): boolean =>
  normalizar(tipo ?? '') === normalizar(AGREGAR_INTERNET);

/**
 * SUBIR / BAJAR MEGAS: el cliente se pasa a otro plan de internet.
 *
 * Son los dos detalles del catálogo que necesitan saber A CUÁNTO se pasa, y ese
 * dato no cabe en ninguna de las casillas heredadas: `detalle` dice qué se hace
 * ('Subir megas') pero no hasta dónde. El legacy lo aparca en su tabla
 * `temporales` (columna `internet`, atada por código de orden); aquí vive en
 * `Ticket.planToId` y sus copias.
 *
 * El PLAN es la velocidad: de él salen las megas, la tarifa de la próxima factura,
 * el perfil PPP del Mikrotik y el traffic-table de la OLT. Por eso la orden porta
 * un plan del catálogo y no un número suelto — un "400" escrito a mano no cambia
 * lo que se le cobra ni lo que la red le entrega.
 */
export const SUBIR_MEGAS = 'Subir megas';
export const BAJAR_MEGAS = 'Bajar megas';

/**
 * ¿Esta orden cambia la velocidad contratada?
 *
 * Con `includes('megas')` y no contra las dos constantes porque el legacy escribió
 * variantes ('SUBIR MEGAS', 'Subir megas ') y todas son el mismo trabajo para quien
 * la abrió. Ojo: 'Cambio de plan' NO entra —no está en el catálogo de la web y por
 * ahí pasan también cambios de televisión—; el día que se añada, se añade aquí.
 */
export function esCambioDeMegas(tipo?: string | null): boolean {
  return normalizar(tipo ?? '').includes('megas');
}

/**
 * Hacia dónde va el cambio: 'SUBIR', 'BAJAR' o `null` si la orden no es de megas.
 * Sirve para no dejar pasar el error de dedo de siempre: elegir un plan de 100
 * Megas en una orden que dice 'Subir megas'.
 */
export function sentidoDeMegas(tipo?: string | null): 'SUBIR' | 'BAJAR' | null {
  const t = normalizar(tipo ?? '');
  if (!t.includes('megas')) return null;
  if (t.includes('subir')) return 'SUBIR';
  if (t.includes('bajar')) return 'BAJAR';
  return null;
}

/**
 * ¿Esta orden es la salida del cliente: un retiro o una suspensión del servicio?
 *
 * Es lo que exige el paz y salvo desde 2026-08-28: el certificado sólo se expide
 * cuando la orden que da de baja el servicio ya está CERRADA. Un certificado
 * firmado con la orden de retiro abierta dice que no se le debe nada a alguien al
 * que todavía se le está prestando el servicio (y al que se le va a seguir
 * facturando).
 *
 * Se compara con `includes` y no contra el catálogo porque el legacy escribió las
 * dos formas —'Suspension Combo' (2.128 órdenes) y 'Suspencion Combo' (201), con
 * la errata que `DETALLES_POR_CLASE` no lista a propósito—, y ambas son la misma
 * orden para quien la abrió. 'retiro' cubre 'Retiro voluntario' (3.463).
 */
export function esOrdenDeRetiroOSuspension(tipo?: string | null): boolean {
  const t = normalizar(tipo ?? '');
  return t.includes('retiro') || t.includes('suspen');
}
