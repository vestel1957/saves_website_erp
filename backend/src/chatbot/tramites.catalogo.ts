/**
 * El conocimiento comercial y de trámites que SAM —el bot viejo de Vestel, en
 * `SAM-VESTEL/PROMPT_SAM_DEFINITIVO.md`— llevaba escrito DENTRO de su prompt.
 *
 * Aquí vive como datos, no como texto de sistema, por tres razones:
 *
 *  1. **El prompt no crece.** SAM metía 567 líneas de precios, apps y flujos en cada
 *     llamada al modelo. Eso se paga en tokens en TODOS los mensajes, incluido el
 *     "hola". Como datos, el modelo lo pide con una herramienta solo cuando hace falta.
 *  2. **Lo que se puede verificar, se verifica.** Los campos obligatorios de cada
 *     trámite son una lista que el servidor comprueba antes de crear la orden; en el
 *     prompt eran una sugerencia que el modelo cumplía casi siempre.
 *  3. **Un solo sitio para cambiar un precio.** Cuando suba el traslado, se cambia
 *     aquí y no en una frase perdida a mitad de un prompt.
 *
 * Aquí viven TAMBIÉN los planes y sus precios (`PLANES_COMERCIALES`), y eso merece una
 * explicación porque va contra la regla de "los datos salen de la BD": la tabla `Plan`
 * del ERP no contiene la oferta 2026 que la empresa publica. Ver la nota de ese bloque.
 */

/** Contacto para cancelaciones. SAM remitía aquí y no la gestionaba él. */
export const WHATSAPP_CANCELACIONES = '3233069990';

/** Portal donde el abonado consulta y paga (heredado del CRM legacy). */
export const PORTAL_CLIENTE = 'https://vestel.com.co/crm/user/login';

/**
 * EL CATÁLOGO COMERCIAL 2026 — lo único que el bot cotiza.
 *
 * Sale del archivo oficial de la empresa: «TARIFAS PRECIOS 2026 + APPS VESGA
 * TELECOMUNICACIONES.xlsx» (cargado el 2026-07-30). Es la fuente de verdad de cara al
 * cliente y no se mezcla con nada más, por decisión explícita del negocio.
 *
 * Por qué NO sale de la tabla `Plan` como el resto del ERP: ahí hay 72 planes activos
 * heredados del sistema viejo —tarifas repetidas, de otras ciudades y cosas como "1
 * Mega por $20.000"— y ninguno corresponde a esta oferta. La familia que más se le
 * parece (`600Megas26F` $83.500) cotiza distinto a lo publicado ($100.000), así que
 * curar planes de la BD habría hecho que el bot dijera una cifra y la fuerza comercial
 * otra. Mientras el ERP no se alinee, manda este archivo.
 *
 * Si algún día se eligen planes en Configuración → Agente de WhatsApp, ESOS mandan
 * (ver `PublicoToolset.planes`). Es la única vía por la que el bot dejaría de cotizar
 * esta lista, y es un acto deliberado de un administrador.
 */
export interface PlanComercial {
  nombre: string;
  precio: number;
  /** Para quién es: hogar o negocio. */
  segmento: 'residencial' | 'comercial';
  /** Qué incluye, tal como lo describe la hoja de tarifas. */
  incluye: string;
}

export const PLANES_COMERCIALES: PlanComercial[] = [
  // ── Familiares (FTTH), Internet + TV ──────────────────────────────────────
  { nombre: 'Internet 300 Megas + TV + 1 app Standard o Premium', precio: 85_000, segmento: 'residencial', incluye: 'Fibra al hogar con velocidad simétrica, TV y una app a elegir' },
  { nombre: 'Internet 600 Megas + TV + 1 app Premium Plus', precio: 110_000, segmento: 'residencial', incluye: 'Fibra simétrica, TV y todas las apps Premium Plus incluidas' },
  { nombre: 'Internet 900 Megas + TV + 1 app Diamante', precio: 140_000, segmento: 'residencial', incluye: 'Fibra simétrica, TV y todas las apps Diamante incluidas' },
  // ── Familiares, solo internet ─────────────────────────────────────────────
  { nombre: 'Internet 300 Megas (solo internet)', precio: 75_000, segmento: 'residencial', incluye: 'ONU 5G Dualband' },
  { nombre: 'Internet 600 Megas (solo internet)', precio: 100_000, segmento: 'residencial', incluye: 'Simetría 100% de carga y descarga' },
  { nombre: 'Internet 900 Megas (solo internet)', precio: 130_000, segmento: 'residencial', incluye: 'Simetría 100% de carga y descarga' },
  // ── Comercial, Internet + TV ──────────────────────────────────────────────
  { nombre: 'Internet 300 Megas + TV + 1 app Standard o Premium (comercial)', precio: 125_000, segmento: 'comercial', incluye: 'Red intranet hasta 3 puntos · simetría 100%' },
  { nombre: 'Internet 600 Megas + TV + app Premium Plus (comercial)', precio: 150_000, segmento: 'comercial', incluye: 'Red intranet hasta 3 puntos · pauta comercial en Canal 6 de 40 segundos' },
  { nombre: 'Internet 900 Megas + TV + app Diamante (comercial)', precio: 210_000, segmento: 'comercial', incluye: 'Red intranet hasta 3 puntos · ONU 5G Dualband más robusta' },
  // ── Comercial, solo internet ──────────────────────────────────────────────
  { nombre: 'Internet 300 Megas comercial (solo internet)', precio: 115_000, segmento: 'comercial', incluye: 'Simetría 100% de carga y descarga · red intranet hasta 3 puntos' },
  { nombre: 'Internet 600 Megas comercial (solo internet)', precio: 140_000, segmento: 'comercial', incluye: 'Pauta comercial en Canal 6 de 40 segundos' },
  { nombre: 'Internet 900 Megas comercial (solo internet)', precio: 200_000, segmento: 'comercial', incluye: 'ONU 5G Dualband más robusta' },
];

/**
 * Los enlaces dedicados punto a punto NO se cotizan por chat (decisión del negocio,
 * 2026-07-30): van de $800.000 a $4.000.000 al mes, dependen de permanencia y de un
 * levantamiento técnico, y los cierra un asesor comercial. Por eso sus precios no
 * están en `PLANES_COMERCIALES`: lo que el bot no tiene, no lo puede soltar por
 * equivocación.
 */
export const NOTA_DEDICADO =
  'Los enlaces dedicados punto a punto para empresas los cotiza un asesor comercial, no por este chat: ' +
  'dependen de la capacidad, la permanencia y un levantamiento técnico. NO des precios ni rangos. ' +
  'Cuéntale que un asesor lo contacta y pásalo con hablar_con_humano.';

/** Servicio adicional suelto de la hoja de tarifas. */
export const IP_PUBLICA_FIJA = 125_000;

/**
 * Costo de la afiliación según la permanencia que acepte el cliente. Sale de la tabla
 * "COSTO DE AFILIACION" de la hoja.
 *
 * OJO con la columna "Cláusula" del archivo (Familiar $256.000, Streaming $333.000,
 * Dedicado $1.350.000): la hoja no dice si es el valor sin permanencia o la penalidad
 * por retirarse antes. Como no está claro, el bot NO la menciona — decirle a un cliente
 * un número mal explicado es peor que no dárselo. Si preguntan por permanencia o
 * penalidades, se pasa a un asesor.
 */
export const AFILIACION: Array<{ tipo: string; doceMeses: number; seisMeses: number | null }> = [
  { tipo: 'Plan familiar', doceMeses: 70_000, seisMeses: 120_000 },
  { tipo: 'Plan con streaming (TV + apps)', doceMeses: 85_000, seisMeses: 135_000 },
  { tipo: 'Enlace dedicado', doceMeses: 300_000, seisMeses: null },
];

/**
 * Lo que cuesta una app suelta, fuera de los combos. Es la respuesta a "¿y cuánto me
 * cobran por la app cuando se acaben los 2 meses?", que SAM no sabía contestar: su
 * guion decía "¿le cuento cuánto sería?" y no tenía el número.
 */
export const APPS_SUELTAS: Array<{ plan: string; precio: number }> = [
  { plan: 'Plan 1', precio: 6_800 },
  { plan: 'Plan 2', precio: 14_000 },
  { plan: 'Plan 3', precio: 22_500 },
  { plan: 'Plan 4', precio: 35_000 },
];

/**
 * Niveles de apps de entretenimiento por plan.
 *
 * No están en la BD (la tabla `Plan` solo tiene nombre, megas y precio), así que es
 * el único sitio donde constan. Los nombres de las apps son los que SAM le decía al
 * cliente.
 */
export const APPS_POR_NIVEL: Record<string, { label: string; apps: string[]; permanente: boolean }> = {
  standard: {
    label: 'Área Standard (planes básicos)',
    apps: ['Cindie (películas)', 'Atresplayer (películas)', 'Play Kids (infantil)', 'Kaspersky — 1 licencia'],
    permanente: false,
  },
  premium: {
    label: 'Área Premium (plan familiar de 300 megas + TV)',
    apps: ['Disney+ con anuncios', 'DGO Ultralight', 'Kaspersky — 5 licencias', 'SURA'],
    permanente: false,
  },
  'premium-plus': {
    label: 'Área Premium Plus (plan familiar de 600 megas + TV)',
    apps: [
      'Disney+ Standard', 'DGO Ultralight + Amazon Prime', 'DGO Flex',
      'Quema Diaria', 'Zen (meditación)', 'Hot Go (contenido para adultos)',
    ],
    permanente: true,
  },
  diamante: {
    label: 'Área Diamante (plan familiar de 900 megas + TV)',
    apps: [
      'Disney+ Premium', 'DGO + Win Más', 'DGO Ultralight + Win Más',
      'DGO Flex + Amazon Prime', 'Kaspersky Plus — 5 licencias',
    ],
    permanente: true,
  },
};

/**
 * La regla que más consultas generaba en SAM: qué pasa cuando se acaban los 2 meses
 * de la app regalada en los niveles Standard y Premium.
 */
export const REGLA_DOS_MESES =
  'En Standard y Premium el cliente elige UNA app del catálogo gratis por 2 meses. Al terminar tiene dos ' +
  'opciones: subir a Premium Plus o Diamante (donde las apps vienen incluidas de forma permanente y sin costo ' +
  'extra), o quedarse en su plan pagando un costo adicional por la app que eligió. ' +
  'En Premium Plus y Diamante NO aplica: todas las apps van incluidas siempre. ' +
  'Si preguntan cuánto costaría seguir con la app suelta, los valores por app fuera de los combos son: ' +
  APPS_SUELTAS.map((a) => `${a.plan} $${a.precio.toLocaleString('es-CO')}`).join(' · ') +
  ' al mes (depende de la app; si no sabes cuál le corresponde, dilo y ofrécele confirmarlo con un asesor).';

/** Temas de información comercial que el bot puede consultar y explicar. */
export const INFO_COMERCIAL: Record<string, { titulo: string; texto: string }> = {
  afiliacion: {
    titulo: 'Afiliación / instalación nueva',
    texto:
      'El costo depende de la permanencia que acepte el cliente: ' +
      AFILIACION.map((a) => `${a.tipo} — 12 meses de permanencia $${a.doceMeses.toLocaleString('es-CO')}` +
        (a.seisMeses ? `, 6 meses $${a.seisMeses.toLocaleString('es-CO')}` : '')).join(' · ') +
      '. Requisitos: cédula en físico y un recibo de servicio público de la vivienda. ' +
      'Si preguntan por cláusulas o penalidades de permanencia, NO improvises: pásalo a un asesor con ' +
      'hablar_con_humano. Si quiere avanzar, registra la solicitud con registrar_solicitud (tipo afiliacion).',
  },
  ip_publica: {
    titulo: 'IP pública fija',
    texto: `Servicio adicional: $${IP_PUBLICA_FIJA.toLocaleString('es-CO')} al mes.`,
  },
  dedicado: {
    titulo: 'Internet dedicado punto a punto (empresas)',
    texto: NOTA_DEDICADO,
  },
  pronto_pago: {
    titulo: 'Descuento por pronto pago',
    texto:
      'Es la única promoción permanente: 5% de descuento si paga dentro de los primeros 5 días del mes. ' +
      'Solo aplica al mes en curso, NO a facturas atrasadas.',
  },
  horarios: {
    titulo: 'Horarios de atención',
    texto:
      'Por este chat: 24 horas, todos los días. ' +
      'Atención presencial en oficina y visitas de técnicos: lunes a sábado de 8:00 a.m. a 12:00 m. y de ' +
      '2:00 p.m. a 5:30 p.m. Domingos y festivos no hay atención.',
  },
  pagos: {
    titulo: 'Cómo pagar y consultar el estado de cuenta',
    texto:
      `Puede pagar y consultar en el portal: ${PORTAL_CLIENTE}. ` +
      'El usuario es su código de abonado (el número que aparece en la factura) y la contraseña es su número de ' +
      'cédula. También puede pagar en cualquiera de las oficinas.',
  },
  mora: {
    titulo: 'Mora y corte del servicio',
    texto:
      'Si no se paga a tiempo el servicio se corta, pero NO se cobra reconexión: al registrarse el pago el ' +
      'servicio vuelve. Si no alcanza a pagar antes de la fecha de corte se puede hacer un acuerdo de pago para ' +
      'la fecha del mes que el cliente elija. Un acuerdo de pago lo cuadra una persona: pásalo con hablar_con_humano.',
  },
  cuotas: {
    titulo: 'Cuotas / financiación',
    texto:
      'No se manejan cuotas: la factura es fija mensual. Lo que sí se puede es un acuerdo de pago para cancelar ' +
      'a fin de mes o en la fecha que el cliente elija dentro del mes correspondiente.',
  },
  cancelacion: {
    titulo: 'Cancelación del servicio',
    texto:
      `La cancelación no se tramita por este chat: el cliente debe escribir al WhatsApp ${WHATSAPP_CANCELACIONES}. ` +
      'Dale ese número y no le abras ninguna orden.',
  },
  cobertura: {
    titulo: 'Cobertura',
    texto:
      'No hay un mapa de cobertura consultable: se valida caso por caso. Registra la consulta con ' +
      'registrar_solicitud (tipo cobertura) con la dirección o el barrio y un teléfono, y un asesor confirma.',
  },
};

/** Un dato que hay que tener capturado antes de poder registrar el trámite. */
export interface CampoTramite {
  /** Clave dentro del objeto `datos` de `registrar_solicitud`. */
  nombre: string;
  /** Cómo pedírselo al cliente (se le devuelve al modelo tal cual si falta). */
  pregunta: string;
  obligatorio: boolean;
}

export interface TramiteDef {
  label: string;
  /**
   * Tipo de orden del ERP. Se reutiliza el vocabulario que YA existe en la tabla
   * `Ticket` (`Revision de Internet`, `Traslado`, `Cambio de clave`…) para que estas
   * órdenes caigan en los mismos listados, filtros y reportes que usa el equipo. Y
   * porque el tipo manda: `applyCloseCascade` decide por su texto qué pasa al cerrar
   * (una orden de `Suspension …` suspende de verdad al abonado). Inventar tipos
   * nuevos aquí habría dejado las órdenes del bot fuera de esa maquinaria.
   */
  ticketType: string;
  /**
   * Variantes de `ticketType` según los servicios del abonado. Solo la suspensión
   * las necesita: el ERP tiene una por servicio y el cierre de cada una corta lo suyo.
   */
  ticketTypePorServicio?: { internet: string; tv: string; combo: string };
  /** false = lo puede pedir alguien que todavía no es cliente (va sin abonado). */
  requiereAbonado: boolean;
  /**
   * true = exige acceso PLENO a la cuenta (ser el titular, estar autorizado por él, o
   * haber confirmado el código que se le manda a su celular).
   *
   * Se reserva para lo que MODIFICA el servicio: cambiar la clave del WiFi, el plan, la
   * dirección o el titular. Quien entró con la validación básica acertó documento,
   * nombre y teléfono — tres datos que están impresos en la factura que cualquiera
   * puede ver—, y eso alcanza para reportar una avería, no para mudarle el internet a
   * otra dirección. Mismo criterio que `EXIGEN_ACCESO_PLENO` en el toolset de clientes.
   */
  exigeAccesoPleno?: boolean;
  campos: CampoTramite[];
  /** Prioridad de la orden en el ERP. */
  prioridad: 'Baja' | 'Media' | 'Alta' | 'Urgente';
  /** Costo y tiempos, si el trámite los tiene. */
  costo?: string;
  tiempo?: string;
  /** Qué debe explicarle el bot al cliente. Es el guion de SAM, resumido. */
  guion: string;
  /**
   * Cargo al que se avisa cuando la solicitud llega SIN abonado (un interesado). Con
   * abonado no hace falta: `createTicket` ya avisa a soporte técnico de toda orden
   * que nace sin técnico asignado.
   */
  cargo?: string;
}

/**
 * Los trámites de SAM, con el mismo alcance que tenían sus 18 flujos.
 *
 * Faltan a propósito dos de su lista: el CORTE por mora (lo diagnostica de verdad
 * `estado_de_mi_servicio`, que mira el estado del abonado y su deuda real, así que no
 * hace falta abrir nada) y la CANCELACIÓN (ver INFO_COMERCIAL.cancelacion: se remite,
 * no se tramita).
 */
export const TRAMITES: Record<string, TramiteDef> = {
  falla_internet: {
    label: 'Falla de internet',
    ticketType: 'Revision de Internet',
    requiereAbonado: true,
    prioridad: 'Media',
    campos: [
      { nombre: 'descripcion', pregunta: '¿Me puede especificar la falla, por favor?', obligatorio: true },
      {
        nombre: 'bombillo_rojo',
        // La pregunta de SAM, y la única de su guion que aporta un dato que el ERP no
        // puede mirar solo: un LED rojo en la ONT es fibra cortada o sin señal óptica
        // (va técnico), mientras que sin LED rojo suele ser cosa del router o del wifi.
        pregunta: '¿De casualidad al equipo le alumbra algún bombillo rojo?',
        obligatorio: true,
      },
    ],
    guion:
      'Se genera una orden de revisión para que el área de sistemas verifique primero. Si desde allí no se logra ' +
      'dar solución, se envía un técnico a la vivienda. Si no alcanza a pasar hoy, pasaría mañana en el transcurso ' +
      'del día. NO prometas una hora exacta.',
  },
  falla_tv: {
    label: 'Falla de televisión',
    ticketType: 'Revision de television',
    requiereAbonado: true,
    prioridad: 'Media',
    campos: [
      { nombre: 'descripcion', pregunta: '¿Me puede especificar la falla del servicio de televisión?', obligatorio: true },
    ],
    guion:
      'En televisión el técnico va DIRECTO a la vivienda: aquí NO se pregunta por el bombillo rojo. Si no alcanza ' +
      'a pasar hoy pasaría mañana en el transcurso del día, y se comunica con el cliente antes de ir.',
  },
  falla_ambos: {
    label: 'Falla de internet y televisión',
    ticketType: 'Revision tv e internet',
    requiereAbonado: true,
    prioridad: 'Media',
    campos: [
      { nombre: 'descripcion', pregunta: '¿Me puede especificar la falla en ambos servicios?', obligatorio: true },
      { nombre: 'bombillo_rojo', pregunta: '¿De casualidad al equipo le alumbra algún bombillo rojo?', obligatorio: true },
    ],
    guion:
      'Se genera una orden para el área de sistemas. Explícale que si se resuelve el internet, la televisión se ' +
      'restablece automáticamente; si no, el técnico va a la vivienda y revisa los dos servicios.',
  },
  cambio_wifi: {
    label: 'Cambio de nombre o clave del WiFi',
    ticketType: 'Cambio de clave',
    requiereAbonado: true,
    exigeAccesoPleno: true,
    prioridad: 'Media',
    campos: [
      // Ninguno obligatorio por separado, pero se exige al menos uno (ver el toolset):
      // hay clientes que solo quieren cambiar la contraseña y pedirles un nombre nuevo
      // de red es fricción inventada.
      { nombre: 'wifi_nombre', pregunta: '¿Cómo quiere que se llame la red?', obligatorio: false },
      { nombre: 'wifi_clave', pregunta: '¿Qué contraseña quiere para la red?', obligatorio: false },
    ],
    guion: 'El área técnica aplica el cambio en el equipo. Confírmale exactamente el nombre y la clave que pidió.',
  },
  cambio_plan: {
    label: 'Cambio de plan',
    ticketType: 'Subir megas',
    requiereAbonado: true,
    exigeAccesoPleno: true,
    prioridad: 'Media',
    costo: 'Sin costo',
    campos: [
      { nombre: 'plan_nuevo', pregunta: '¿A qué plan desea cambiarse?', obligatorio: true },
    ],
    guion:
      'El cambio de plan no tiene costo y se refleja en la próxima factura. Si no sabe a cuál cambiarse, muéstrale ' +
      'los planes con planes_disponibles antes de registrar nada.',
  },
  suspension: {
    label: 'Suspensión temporal del servicio',
    ticketType: 'Suspension Internet',
    ticketTypePorServicio: {
      internet: 'Suspension Internet',
      tv: 'Suspension Television',
      combo: 'Suspension Combo',
    },
    requiereAbonado: true,
    exigeAccesoPleno: true,
    prioridad: 'Media',
    campos: [
      { nombre: 'fecha_inicio', pregunta: '¿Desde qué fecha quiere la suspensión? (día/mes/año)', obligatorio: true },
      { nombre: 'fecha_fin', pregunta: '¿Hasta qué fecha?', obligatorio: true },
    ],
    guion:
      'Solo se puede suspender si el cliente está al día con sus pagos, y la línea se guarda por un máximo de ' +
      '3 meses. Las dos condiciones las comprueba el sistema al registrar: no las prometas antes de tiempo.',
  },
  traslado: {
    label: 'Traslado del servicio a otra dirección',
    ticketType: 'Traslado',
    requiereAbonado: true,
    exigeAccesoPleno: true,
    prioridad: 'Media',
    costo: '$30.000',
    tiempo: '1 día hábil',
    campos: [
      { nombre: 'direccion_nueva', pregunta: '¿A qué dirección se va a trasladar el servicio?', obligatorio: true },
      { nombre: 'telefono_contacto', pregunta: '¿A qué número lo llamamos para coordinar?', obligatorio: false },
      { nombre: 'fecha_deseada', pregunta: '¿Para qué fecha lo necesita?', obligatorio: false },
    ],
    guion:
      'El traslado cuesta $30.000 y toma 1 día hábil. Dile el costo ANTES de pedirle los datos: nadie quiere ' +
      'enterarse del cobro después de haber dado la dirección. El traslado está sujeto a que haya cobertura en ' +
      'la dirección nueva, y eso lo confirma quien atienda la orden.',
  },
  equipo_danado: {
    label: 'Equipo dañado',
    ticketType: 'Cambio de equipo',
    requiereAbonado: true,
    prioridad: 'Media',
    campos: [
      { nombre: 'equipo', pregunta: '¿Qué equipo es el que está fallando?', obligatorio: true },
      { nombre: 'falla', pregunta: '¿Qué le pasa al equipo?', obligatorio: true },
    ],
    guion:
      'Se genera una orden de revisión técnica. Explícale la regla sin adelantar el veredicto: si el daño fue por ' +
      'falla normal del equipo responde la empresa; si fue por manipulación tiene un costo. Quién responde lo ' +
      'define el técnico en la revisión, no tú.',
  },
  cambio_titular: {
    label: 'Cambio de titular',
    // Tipo nuevo: en el legacy este trámite nunca fue una orden de servicio (se hacía
    // en mostrador), así que no hay un `type` histórico que reutilizar.
    ticketType: 'Cambio de titular',
    requiereAbonado: true,
    exigeAccesoPleno: true,
    prioridad: 'Media',
    campos: [
      { nombre: 'nuevo_titular', pregunta: '¿A nombre de quién quedaría el servicio?', obligatorio: true },
    ],
    guion:
      'El cambio de titularidad se hace PRESENCIAL en oficina: se necesitan los documentos y la firma del titular ' +
      'actual y del nuevo. Dile la oficina del municipio que le quede (sedes) y el horario de atención presencial ' +
      '(info_comercial horarios). Registra la solicitud para que un asesor coordine la cita, y NO le inventes la ' +
      'lista exacta de documentos: eso se lo confirma el asesor.',
  },
  afiliacion: {
    label: 'Afiliación (instalación nueva)',
    ticketType: 'Instalacion',
    requiereAbonado: false,
    prioridad: 'Media',
    costo: '$70.000 (pago único)',
    campos: [
      { nombre: 'nombre', pregunta: '¿Cuál es su nombre completo?', obligatorio: true },
      { nombre: 'telefono', pregunta: '¿A qué número lo podemos contactar?', obligatorio: true },
      { nombre: 'direccion', pregunta: '¿En qué dirección sería la instalación?', obligatorio: true },
      { nombre: 'municipio', pregunta: '¿En qué municipio?', obligatorio: false },
      { nombre: 'plan_interes', pregunta: '¿Qué plan le interesa?', obligatorio: true },
    ],
    guion:
      'La afiliación cuesta $70.000 (pago único) y pide cédula en físico y un recibo público de la vivienda. ' +
      'Cuéntale eso, muéstrale los planes si aún no eligió, y registra la solicitud: un asesor lo contacta para ' +
      'coordinar la instalación. NO le prometas fecha de instalación.',
    cargo: 'ventas',
  },
  cobertura: {
    label: 'Consulta de cobertura',
    ticketType: 'Consulta de cobertura',
    requiereAbonado: false,
    prioridad: 'Media',
    campos: [
      { nombre: 'direccion', pregunta: '¿En qué dirección o barrio necesita el servicio?', obligatorio: true },
      { nombre: 'telefono', pregunta: '¿A qué número le confirmamos?', obligatorio: true },
    ],
    guion:
      'No tienes forma de saber si hay cobertura: no lo adivines ni digas que sí. Registra la consulta y dile que ' +
      'un asesor le confirma en breve.',
    cargo: 'ventas',
  },
  pqr: {
    label: 'PQR (petición, queja o reclamo)',
    ticketType: 'PQR',
    // Un reclamo formal lo puede poner cualquiera, cliente o no: exigir identificación
    // para RECIBIR una queja es justo lo que no se debe hacer.
    requiereAbonado: false,
    // Las PQR tienen plazos de ley: nacen por encima de la cola normal.
    prioridad: 'Alta',
    campos: [
      { nombre: 'descripcion', pregunta: '¿Me cuenta qué sucedió, por favor?', obligatorio: true },
      { nombre: 'telefono', pregunta: '¿A qué número lo contactamos?', obligatorio: false },
    ],
    guion:
      'Registra la PQR y dile que queda radicada y que un asesor lo contacta. No discutas el fondo del reclamo ni ' +
      'le des la razón o se la quites: eso lo resuelve quien la atienda.',
    cargo: 'pqr',
  },
};

/** Slugs válidos, para el enum de la herramienta y los mensajes de error. */
export const TRAMITE_SLUGS = Object.keys(TRAMITES);

/** Los que puede pedir alguien que todavía no es cliente. */
export const TRAMITES_SIN_ABONADO = TRAMITE_SLUGS.filter((s) => !TRAMITES[s].requiereAbonado);
