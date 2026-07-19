export type NavItem = {
  icon: string;
  label: string;
  href?: string;
  badge?: string;
  badgeKind?: "muted" | "ai";
  iconClass?: string;
  /** Permission(s) required to see this item. Omitted = visible to anyone signed in. */
  perm?: string | string[];
  /** Visible a cualquiera con sesión (no se le deriva permiso de pantalla). */
  public?: boolean;
  /** Submódulo colapsable: ítems hijos (3er nivel del árbol, como el saves real). */
  children?: NavItem[];
};

export type NavSection = {
  title: string;
  items: NavItem[];
  defaultOpen?: boolean;
  /** Permission(s) required to see the whole section. */
  perm?: string | string[];
};

/**
 * Llave de permiso de una pantalla, derivada de su href. DEBE coincidir con
 * `screenKey()` del backend (`permissions.catalog.ts`): `/facturacion/notas`
 * → `screen.facturacion.notas`. Cada hoja del menú se gatea con SU llave de
 * pantalla; así el acceso por empleado (rol base + overrides) controla el menú.
 */
export const screenKey = (href: string) => "screen" + href.replace(/\//g, ".");

// ── ESPEJO FIEL DEL SIDEBAR LEGACY (saves-vestel) ───────────────────────────
// Réplica de la estructura del menú de la app legacy (CodeIgniter,
// application/views/fixed/header.php): encabezados de sección → módulos
// colapsables (has-sub) → submenús. Se conservan las etiquetas del legacy.
// Se dejan TODOS los módulos del legacy en el menú (decisión 2026-07-07): lo que
// aún no tiene vista/backend se construye; cada hoja apunta a su ruta de nexus
// (existente o convencional por construir). El permiso se deriva solo
// (screenKey(href), ver withScreenPerm).

// ── AGRUPACIÓN POR ÁREA FUNCIONAL (2026-07-10) ──────────────────────────────
// Reorganizado desde el espejo legacy hacia grupos funcionales limpios (decisión
// del usuario): se deduplicó Mikrotik (estaba en Misceláneos Y en Ajustes), se
// movieron los gestores de red (Mikrotik/OLT) a RED/ISP, Reportes salió a su
// propia sección y "Ajustes" dejó de ser un cajón de sastre. NO se quitó ninguna
// hoja: solo se reordenó. Cada hoja conserva su href → su permiso se deriva solo.
//
// ── CONSOLIDACIÓN (2026-07-12) ──────────────────────────────────────────────
// El nav se sentía disperso (9 secciones, inventario y caja partidos en dos).
// Cambios (solo reagrupación; ningún href/permiso cambia):
//  · INVENTARIO unifica equipos (antes en RED/ISP) + material + compras. RED/ISP
//    queda solo con operación de red (conexiones, NAP, IPs, masivas, Mikrotik, OLT).
//  · CAJA / TESORERÍA fusiona apertura/cierre con los movimientos de tesorería
//    (que estaban enterrados como submódulo dentro de FACTURACIÓN).
//  · Documentos pasó de REPORTES a CONFIGURACIÓN. CLIENTES/CRM subió tras PRINCIPAL.

// PRINCIPAL — inicio (workspace por rol), Dashboard, Reportes, PlayHub y mensajería.
const principal: NavItem[] = [
  { icon: "gauge", label: "Inicio", href: "/inicio", public: true },
  { icon: "layout-dashboard", label: "Dashboard", href: "/dashboard" },
  { icon: "bar-chart-3", label: "Reportes", href: "/reportes" },
  { icon: "play", label: "Clientes PlayHub", href: "/playhub", iconClass: "text-error-text" },
  {
    icon: "message-circle",
    label: "WhatsApp",
    children: [
      { icon: "message-square", label: "Inbox", href: "/configuracion/mensajes" },
      { icon: "sparkles", label: "Agente (bot)", href: "/configuracion/chatbot" },
      { icon: "file-text", label: "Plantillas", href: "/configuracion/whatsapp/plantillas" },
      { icon: "send", label: "Envío masivo", href: "/configuracion/whatsapp/masivo" },
      { icon: "settings", label: "Configurar API", href: "/configuracion/whatsapp" },
    ],
  },
];

// FACTURACIÓN — documentos de venta y promociones. (Tesorería se movió a CAJA / TESORERÍA.)
const facturacion: NavItem[] = [
  // "Nueva factura" no va en el menú: el botón vive dentro de Administrar facturas.
  { icon: "receipt", label: "Administrar facturas", href: "/facturacion" },
  { icon: "scroll-text", label: "Notas crédito/débito", href: "/facturacion/notas" },
  { icon: "file-signature", label: "Facturas electrónicas", href: "/facturacion/electronica" },
  { icon: "file-text", label: "Cotizaciones", href: "/cotizaciones" },
  { icon: "repeat", label: "Ventas recurrentes", href: "/facturacion/recurrente" },
  { icon: "gift", label: "Promociones", href: "/configuracion/promociones" },
];

// CAJA / TESORERÍA — apertura/cierre de caja + movimientos de tesorería (unificado).
const cajaTesoreria: NavItem[] = [
  { icon: "key-round", label: "Apertura de caja", href: "/tesoreria/apertura" },
  { icon: "lock", label: "Cierre de caja", href: "/tesoreria/cierres" },
  { icon: "banknote", label: "Movimientos", href: "/tesoreria" },
  { icon: "trending-up", label: "Ingresos", href: "/tesoreria/ingresos" },
  { icon: "trending-down", label: "Egresos", href: "/tesoreria/egresos" },
  { icon: "plus", label: "Nueva transacción", href: "/tesoreria/nueva" },
  { icon: "arrow-left-right", label: "Transferencia entre cajas", href: "/tesoreria/transferencia" },
  { icon: "x", label: "Anulaciones", href: "/tesoreria/anulaciones" },
  { icon: "wallet", label: "Cajas y categorías", href: "/tesoreria/cajas" },
  { icon: "upload", label: "Importar pagos (Efecty)", href: "/tesoreria/importar-pagos" },
];

// CONTABILIDAD — plan de cuentas, libros e informes.
const contabilidad: NavItem[] = [
  { icon: "calculator", label: "Resumen contable", href: "/contabilidad" },
  { icon: "list-tree", label: "Plan de cuentas", href: "/contabilidad/plan-de-cuentas" },
  { icon: "book-open", label: "Libro diario y mayor", href: "/contabilidad/libros" },
  { icon: "bar-chart-3", label: "Balance y estados", href: "/contabilidad/informes" },
  { icon: "settings", label: "Mapeo de cuentas", href: "/contabilidad/mapeo-cuentas" },
];

// RED / ISP — operación de red que NO es Mikrotik (ese tiene módulo propio).
const red: NavItem[] = [
  { icon: "activity", label: "Conexiones", href: "/red/conexiones" },
  { icon: "git-branch", label: "Cajas NAP", href: "/red/naps" },
  { icon: "radio-tower", label: "Gestión OLT", href: "/red/olt" },
  { icon: "tv", label: "GenieACS · TR-069", href: "/red/genieacs" },
];

// MIKROTIK — módulo propio (2026-07-15). Todo lo que opera routers RouterOS vive
// aquí, con rutas /mikrotik/* de verdad (no /red/* renombradas: eso deja el menú
// diciendo una cosa y el gate por área del middleware otra, como pasa con
// Equipos). Lo que NO se mueve: el MikrotikModal de corte/reconexión sigue
// colgando de la ficha del abonado (/clientes/[id]) y de /inicio, porque ahí es
// donde se opera un cliente concreto; y el cambio de plan sigue en su modal.
const mikrotik: NavItem[] = [
  { icon: "router", label: "Gestión de routers", href: "/mikrotik" },
  { icon: "zap", label: "Operaciones masivas", href: "/mikrotik/masivo" },
  { icon: "network", label: "IPs de usuarios", href: "/mikrotik/ips" },
];

// INVENTARIO — todo el inventario físico: equipos (CPE), material, compras,
// devoluciones y proveedores. Los equipos conservan sus rutas /red/* (solo se
// reagrupan en el menú); su acceso sigue gateado por esas rutas en el middleware.
const inventario: NavItem[] = [
  {
    icon: "router",
    label: "Equipos",
    children: [
      // "Ingreso de equipo" no va en el menú: el botón vive dentro de Administrar equipos.
      { icon: "boxes", label: "Administrar equipos", href: "/red/equipos" },
      { icon: "warehouse", label: "Bodega de equipos", href: "/red/bodegas" },
      { icon: "arrow-left-right", label: "Transferencias de equipos", href: "/red/transferencias" },
    ],
  },
  {
    icon: "package",
    label: "Material",
    children: [
      { icon: "package", label: "Administrar material", href: "/inventario" },
      { icon: "boxes", label: "Categorías de material", href: "/inventario/categorias" },
      { icon: "warehouse", label: "Bodegas de material", href: "/inventario/bodegas" },
      { icon: "layers", label: "Traspasos", href: "/inventario/traspasos" },
      { icon: "clipboard-list", label: "Actas", href: "/inventario/actas" },
    ],
  },
  {
    icon: "shopping-cart",
    label: "Compras",
    children: [
      // "Nueva orden" no va en el menú: el botón vive dentro de Órdenes de compra.
      { icon: "shopping-cart", label: "Órdenes de compra", href: "/ordenes" },
      { icon: "wrench", label: "Órdenes de servicio", href: "/ordenes/servicios" },
      { icon: "folder", label: "Categorías de compra", href: "/ordenes/categorias" },
    ],
  },
  { icon: "package-x", label: "Devoluciones", href: "/devoluciones" },
  { icon: "truck", label: "Proveedores", href: "/proveedores" },
];

// CLIENTES / CRM — abonados, grupos y soporte técnico.
const crm: NavItem[] = [
  { icon: "users", label: "Administrar clientes", href: "/clientes" },
  { icon: "users-round", label: "Grupos de clientes", href: "/clientes/grupos" },
  { icon: "hand-coins", label: "Cobranza / Acuerdos", href: "/cobranza" },
  { icon: "headphones", label: "Soporte técnico", href: "/soporte" },
];

// PERSONAS / PROYECTOS — equipo interno, proyectos y tareas.
const personas: NavItem[] = [
  { icon: "contact", label: "Empleados", href: "/empleados" },
  { icon: "truck", label: "Móviles / cuadrillas", href: "/empleados/moviles" },
  { icon: "layers", label: "Proyectos", href: "/proyectos" },
  { icon: "list-checks", label: "Tareas / Pendientes", href: "/tareas" },
  // /agenda es el calendario de eventos (omni/events), no un listado de tareas:
  // se renombró al añadir /tareas, que sí es el to-do heredado del legacy.
  { icon: "calendar", label: "Agenda / Eventos", href: "/agenda" },
];

// CONFIGURACIÓN — ajustes del sistema (ya sin operación de red ni reportes).
const configuracion: NavItem[] = [
  { icon: "briefcase", label: "Empresa", href: "/configuracion" },
  { icon: "gauge", label: "Planes de servicio", href: "/configuracion/planes" },
  { icon: "folder", label: "Categorías de transacción", href: "/configuracion/categorias" },
  { icon: "user-cog", label: "Usuarios y roles", href: "/configuracion/usuarios" },
  { icon: "key-round", label: "REST API", href: "/configuracion/api" },
  { icon: "calendar-clock", label: "Cron job", href: "/configuracion/automatizaciones" },
  { icon: "history", label: "Bitácora / auditoría", href: "/configuracion/actividad" },
  // Importar y exportar viven en un solo hub (/configuracion/datos).
  { icon: "file-spreadsheet", label: "Importar / Exportar", href: "/configuracion/datos" },
  { icon: "folder", label: "Documentos", href: "/configuracion/documentos" },
];

/**
 * Asigna a cada HOJA su permiso de pantalla (`screenKey(href)`). Los módulos
 * padre no llevan permiso: su visibilidad la derivan sus hijos en el Sidebar.
 */
function withScreenPerm(item: NavItem): NavItem {
  if (item.children?.length) return { ...item, perm: undefined, children: item.children.map(withScreenPerm) };
  if (item.public) return { ...item, perm: undefined }; // visible a cualquiera con sesión
  return item.href ? { ...item, perm: screenKey(item.href) } : item;
}

// Secciones que espejan los encabezados del legacy. Cada hoja recibe su
// `screen.*`; la sección se muestra si al usuario le queda ≥1 ítem visible.
export const navSections: NavSection[] = [
  { title: "PRINCIPAL", items: principal },
  { title: "CLIENTES / CRM", items: crm },
  { title: "FACTURACIÓN", items: facturacion },
  { title: "CAJA / TESORERÍA", items: cajaTesoreria },
  { title: "CONTABILIDAD", items: contabilidad },
  { title: "RED / ISP", items: red },
  { title: "MIKROTIK", items: mikrotik },
  { title: "INVENTARIO", items: inventario },
  { title: "PERSONAS / PROYECTOS", items: personas },
  { title: "CONFIGURACIÓN", items: configuracion },
].map((s) => ({ ...s, items: s.items.map(withScreenPerm) }));

/** Aplana un ítem y sus hijos a las hojas con href (para búsqueda/activo/landing). */
function leaves(items: NavItem[]): NavItem[] {
  return items.flatMap((i) => (i.children?.length ? leaves(i.children) : i.href ? [i] : []));
}

/**
 * Href del primer ítem que el usuario puede ver — landing tras el login.
 * Devuelve null si no hay ninguna sección visible.
 */
export function firstAccessibleHref(
  check: (perm?: string | string[]) => boolean,
): string | null {
  for (const s of navSections) {
    if (!check(s.perm)) continue;
    for (const item of leaves(s.items)) {
      if (item.href && check(item.perm)) return item.href;
    }
  }
  return null;
}

/** Ítem aplanado para la paleta de comandos / búsqueda global. */
export type CommandItem = NavItem & { section: string };

export const commandItems: CommandItem[] = navSections.flatMap((s) =>
  leaves(s.items).map((item) => ({ ...item, section: s.title })),
);

/** Longitud de coincidencia de un href contra la ruta actual (-1 = no coincide). */
function hrefMatchLen(href: string, pathname: string): number {
  if (href === "/") return pathname === "/" ? 1 : -1;
  if (pathname === href) return href.length;
  if (pathname.startsWith(`${href}/`)) return href.length;
  return -1;
}

/** Href del ítem de navegación MÁS específico que corresponde a la ruta. */
export function activeNavHref(pathname: string): string {
  let best = "";
  let bestLen = -1;
  for (const s of navSections) {
    for (const item of leaves(s.items)) {
      if (!item.href) continue;
      const len = hrefMatchLen(item.href, pathname);
      if (len > bestLen) {
        bestLen = len;
        best = item.href;
      }
    }
  }
  return best;
}

/**
 * ¿La ruta actual ES una hoja del sidebar (una sección propia del menú)?
 * Sirve para decidir si mostrar el botón "Volver": en una sección del menú no
 * hace falta (se navega por el sidebar); solo se muestra en subpáginas que no
 * están en el menú (fichas de detalle como /clientes/123, /soporte/45). Compara
 * por igualdad exacta: /clientes es hoja, pero /clientes/123 no lo es.
 */
export function isNavLeaf(pathname: string): boolean {
  return navSections.some((s) => leaves(s.items).some((i) => i.href === pathname));
}

/** Devuelve [sección, etiqueta] del módulo que corresponde a la ruta actual. */
export function findCrumb(pathname: string): { section: string; label: string } {
  const href = activeNavHref(pathname);
  if (href) {
    for (const s of navSections) {
      for (const item of leaves(s.items)) {
        if (item.href === href) return { section: titleCase(s.title), label: item.label };
      }
    }
  }
  const first = navSections[0];
  return { section: titleCase(first.title), label: leaves(first.items)[0]?.label ?? "Inicio" };
}

function titleCase(upper: string): string {
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}
