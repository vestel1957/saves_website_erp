/**
 * Catálogo de cargos operativos: los frentes de trabajo que tienen un encargado.
 *
 * Vive en código y no en base de datos porque un cargo sólo sirve si algo del
 * sistema le habla. Una fila que nadie notifica es una casilla que se llena una vez
 * y se olvida; añadir un cargo aquí obliga a decidir, en el mismo commit, qué aviso
 * le llega. `alerts` es esa respuesta escrita, y la UI la pinta tal cual para que el
 * que nombra al encargado sepa a qué lo está comprometiendo.
 */
export interface PostDef {
  /** Slug estable. Es lo que se guarda en `Responsibility.post` y lo que piden los avisos. */
  slug: string;
  label: string;
  /** Agrupa en la pantalla de configuración. */
  group: string;
  /** De qué responde. Una frase, en el idioma de la operación. */
  purpose: string;
  /**
   * Avisos que hoy le llegan de verdad. Vacío = el cargo se puede nombrar, pero
   * todavía no hay nada enganchado (la UI lo dice así, sin prometer de más).
   */
  alerts: string[];
  /**
   * A quién avisar mientras el cargo esté SIN encargado.
   *
   * Es lo que evita el peor final de esta función: declarar el cargo, dejarlo vacío
   * y apagar en silencio un aviso que hoy sí le llega a alguien. Sin encargado el
   * aviso sale a todo el que tenga este permiso —el comportamiento viejo— y queda un
   * warning en el log diciendo que falta nombrar al responsable.
   */
  fallbackPermission?: string;
}

/** Grupos, en el orden en que se pintan. */
export const POST_GROUPS = [
  'Atención al cliente',
  'Operación técnica',
  'Inventario y compras',
  'Dinero',
  'Administración',
] as const;

export const POSTS: PostDef[] = [
  // ── Atención al cliente ───────────────────────────────────────────────────
  {
    slug: 'call-center',
    label: 'Call center / Atención al cliente',
    group: 'Atención al cliente',
    purpose: 'Contesta los chats y llamadas que entran, y reparte lo que llega sin dueño.',
    alerts: ['Un chat de WhatsApp quedó esperando a que alguien lo tome'],
    fallbackPermission: 'whatsapp.inbox',
  },
  {
    slug: 'ventas',
    label: 'Ventas',
    group: 'Atención al cliente',
    // Sin "altas de servicio": eso lo coordina el cargo de instalaciones. Ventas
    // responde por cerrar el negocio, no por la visita que viene después.
    purpose: 'Cotizaciones, seguimiento a los interesados y cierre de nuevas ventas.',
    alerts: [],
  },
  {
    slug: 'pqr',
    label: 'PQR y reclamos',
    group: 'Atención al cliente',
    purpose: 'Responde peticiones, quejas y reclamos dentro de los plazos de ley.',
    alerts: [],
  },

  // ── Operación técnica ─────────────────────────────────────────────────────
  {
    slug: 'soporte-tecnico',
    label: 'Soporte técnico',
    group: 'Operación técnica',
    purpose: 'Reparte las órdenes de servicio entre los técnicos y responde por que se cierren.',
    alerts: ['Se creó una orden de servicio y nació sin técnico asignado'],
    // El respaldo es quien REPARTE, no el técnico de campo. Estaba en
    // `area.tecnicos` y, con el cargo sin titular, cada orden sin asignar le sonaba
    // a los 16 técnicos —justo a quienes no les toca hacer nada con ella: ellos
    // atienden lo que les agendan, no lo reparten (`AgendaService.mover` se lo
    // niega por escrito)—. `screen.soporte.agenda` es el tablero donde se reparte:
    // caja y administración.
    fallbackPermission: 'screen.soporte.agenda',
  },
  {
    slug: 'red-isp',
    label: 'Red / ISP (NOC)',
    group: 'Operación técnica',
    purpose: 'Salud de la red: OLTs, routers, NAPs y cortes masivos.',
    alerts: [],
  },
  {
    slug: 'instalaciones',
    label: 'Coordinación de instalaciones',
    group: 'Operación técnica',
    purpose: 'Agenda las visitas a domicilio y cuadra las cuadrillas.',
    alerts: [],
  },

  // ── Inventario y compras ──────────────────────────────────────────────────
  {
    slug: 'bodega',
    label: 'Bodega y almacén',
    group: 'Inventario y compras',
    purpose: 'Custodia el material y los equipos: entradas, salidas y existencias.',
    alerts: ['Se aprobó una orden de compra con destino a su bodega (material en camino)'],
    fallbackPermission: 'inventory.areas.write',
  },
  {
    slug: 'compras',
    label: 'Compras y proveedores',
    group: 'Inventario y compras',
    purpose: 'Ordena el material, negocia con proveedores y mueve las aprobaciones.',
    alerts: [
      'Una orden de compra quedó pendiente de aprobación',
      'Una orden pasó del tope y le falta la segunda firma',
    ],
    fallbackPermission: 'purchases.approve',
  },

  // ── Dinero ────────────────────────────────────────────────────────────────
  {
    slug: 'cartera',
    label: 'Cartera y cobranza',
    group: 'Dinero',
    purpose: 'Persigue la deuda: morosos, acuerdos de pago y suspensiones por no pago.',
    alerts: ['Un cliente pidió un descuento al registrar una llamada de cobranza'],
    // El legacy mandaba la solicitud de descuento a una persona por sede
    // (`asignaciones.detalle = 'descuentos'`). Aquí se nombra un encargado; el
    // respaldo evita que, mientras nadie lo esté, la petición no le llegue a nadie.
    fallbackPermission: 'area.contabilidad',
  },
  // Tesorería/caja y facturación NO son cargos aparte: los tres frentes responden a
  // la misma persona (2026-07-30, decisión del negocio), así que se nombra una vez y
  // no tres. Si algún día se separan, se vuelven a partir aquí con sus propios avisos.
  {
    slug: 'contabilidad',
    label: 'Contabilidad',
    group: 'Dinero',
    purpose:
      'Libros, impuestos y cierres contables. Responde también por la facturación (incluida la electrónica ante la DIAN) y por las cajas.',
    alerts: ['Aparecieron pagos borrados en el legacy: su cierre de caja quedó corto'],
    // Sin respaldo, el aviso de caja no le llegaba a NADIE: la tabla de encargados
    // está vacía y este cargo no tenía `fallbackPermission`. Un detector que no avisa
    // no es un detector.
    fallbackPermission: 'area.contabilidad',
  },

  // ── Administración ────────────────────────────────────────────────────────
  //
  // NO hay cargo de Talento humano/Nómina ni de SST: esos frentes no existen hoy en
  // la empresa (2026-07-30, por decisión del negocio). Es la misma razón por la que
  // se retiraron sus roles del RBAC — ver la nota de roles retirados en
  // `permissions.catalog.ts`. Un cargo sin frente detrás es una casilla que alguien
  // llena una vez y nadie vuelve a mirar. Si mañana se construyen, se agregan aquí
  // junto con los avisos que de verdad les lleguen.
  {
    slug: 'sistemas',
    label: 'Sistemas / TI',
    group: 'Administración',
    purpose: 'Mantiene el sistema en pie: accesos, integraciones y procesos automáticos.',
    alerts: [],
    fallbackPermission: 'system.admin',
  },
  {
    slug: 'gerencia',
    label: 'Gerencia',
    group: 'Administración',
    purpose: 'Decide lo que excede a las áreas y firma lo que pasa de los topes.',
    alerts: [],
    fallbackPermission: 'area.gerencia',
  },
];

const BY_SLUG = new Map(POSTS.map((p) => [p.slug, p]));

export function postDef(slug: string): PostDef | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Slugs de los cargos que YA reciben algún aviso automático. Los usa el notificador
 * para gritar en el log si alguien avisa a un cargo que no existe en el catálogo
 * (un typo en un slug es un aviso que no le llega a nadie y no falla en ninguna parte).
 */
export const POST_SLUGS: string[] = POSTS.map((p) => p.slug);
