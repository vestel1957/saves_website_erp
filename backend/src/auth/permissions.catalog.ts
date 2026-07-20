/**
 * Catalog of inventory permission keys + the default roles that bundle them.
 * Seeded into the DB (Permission / Role / RolePermission). The PermissionsGuard
 * compares these against req.user.permissions.
 */
export const INV_PERMISSIONS = {
  // catalog
  PRODUCTS_READ: 'inventory.products.read',
  PRODUCTS_WRITE: 'inventory.products.write',
  // warehouses & locations
  WAREHOUSES_READ: 'inventory.warehouses.read',
  WAREHOUSES_WRITE: 'inventory.warehouses.write',
  // stock & kardex
  STOCK_READ: 'inventory.stock.read',
  KARDEX_READ: 'inventory.kardex.read',
  MOVEMENTS_WRITE: 'inventory.movements.write',
  TRANSFERS_WRITE: 'inventory.transfers.write',
  // procurement
  PURCHASE_ORDERS_READ: 'inventory.purchase-orders.read',
  PURCHASE_ORDERS_WRITE: 'inventory.purchase-orders.write',
  PURCHASE_ORDERS_APPROVE: 'inventory.purchase-orders.approve',
  RECEIPTS_WRITE: 'inventory.receipts.write',
  // adjustments
  ADJUSTMENTS_WRITE: 'inventory.adjustments.write',
  ADJUSTMENTS_APPROVE: 'inventory.adjustments.approve',
  // assets
  ASSETS_READ: 'inventory.assets.read',
  ASSETS_WRITE: 'inventory.assets.write',
  ASSETS_ASSIGN: 'inventory.assets.assign', // entregar/asignar material a un funcionario (exclusivo del jefe de bodega)
  // maintenance & areas
  MAINTENANCE_READ: 'inventory.maintenance.read',
  MAINTENANCE_WRITE: 'inventory.maintenance.write',
  MAINTENANCE_PLANS_READ: 'inventory.maintenance-plans.read',
  MAINTENANCE_PLANS_WRITE: 'inventory.maintenance-plans.write',
  AREAS_READ: 'inventory.areas.read',
  AREAS_WRITE: 'inventory.areas.write',
  // work orders (órdenes de trabajo)
  WORK_ORDERS_WRITE: 'inventory.work-orders.write', // crear / editar / asignar (jefe)
  WORK_ORDERS_EXECUTE: 'inventory.work-orders.execute', // ejecutar las propias (técnico)
  // reports & dashboard
  REPORTS_READ: 'inventory.reports.read',
  // administration
  ADMIN: 'inventory.admin',
} as const;

export type InvPermission = (typeof INV_PERMISSIONS)[keyof typeof INV_PERMISSIONS];

export const ALL_INV_PERMISSIONS: { key: string; label: string }[] = [
  { key: INV_PERMISSIONS.PRODUCTS_READ, label: 'Ver productos' },
  { key: INV_PERMISSIONS.PRODUCTS_WRITE, label: 'Gestionar productos' },
  { key: INV_PERMISSIONS.WAREHOUSES_READ, label: 'Ver bodegas' },
  { key: INV_PERMISSIONS.WAREHOUSES_WRITE, label: 'Gestionar bodegas' },
  { key: INV_PERMISSIONS.STOCK_READ, label: 'Ver existencias' },
  { key: INV_PERMISSIONS.KARDEX_READ, label: 'Ver kardex' },
  { key: INV_PERMISSIONS.MOVEMENTS_WRITE, label: 'Registrar movimientos' },
  { key: INV_PERMISSIONS.TRANSFERS_WRITE, label: 'Registrar transferencias' },
  { key: INV_PERMISSIONS.PURCHASE_ORDERS_READ, label: 'Ver órdenes de compra' },
  { key: INV_PERMISSIONS.PURCHASE_ORDERS_WRITE, label: 'Gestionar órdenes de compra' },
  { key: INV_PERMISSIONS.PURCHASE_ORDERS_APPROVE, label: 'Aprobar órdenes de compra' },
  { key: INV_PERMISSIONS.RECEIPTS_WRITE, label: 'Registrar recepciones' },
  { key: INV_PERMISSIONS.ADJUSTMENTS_WRITE, label: 'Crear ajustes' },
  { key: INV_PERMISSIONS.ADJUSTMENTS_APPROVE, label: 'Aprobar ajustes' },
  { key: INV_PERMISSIONS.ASSETS_READ, label: 'Ver activos asignados' },
  { key: INV_PERMISSIONS.ASSETS_WRITE, label: 'Gestionar activos' },
  { key: INV_PERMISSIONS.ASSETS_ASSIGN, label: 'Asignar material a funcionarios' },
  { key: INV_PERMISSIONS.MAINTENANCE_READ, label: 'Ver mantenimientos' },
  { key: INV_PERMISSIONS.MAINTENANCE_WRITE, label: 'Registrar mantenimientos' },
  { key: INV_PERMISSIONS.MAINTENANCE_PLANS_READ, label: 'Ver planes de mantenimiento' },
  { key: INV_PERMISSIONS.MAINTENANCE_PLANS_WRITE, label: 'Gestionar planes de mantenimiento' },
  { key: INV_PERMISSIONS.AREAS_READ, label: 'Ver áreas' },
  { key: INV_PERMISSIONS.AREAS_WRITE, label: 'Gestionar áreas' },
  { key: INV_PERMISSIONS.WORK_ORDERS_WRITE, label: 'Crear y asignar órdenes de trabajo' },
  { key: INV_PERMISSIONS.WORK_ORDERS_EXECUTE, label: 'Ejecutar órdenes de trabajo asignadas' },
  { key: INV_PERMISSIONS.REPORTS_READ, label: 'Ver reportes de inventario' },
  { key: INV_PERMISSIONS.ADMIN, label: 'Administración total de inventario' },
];

const P = INV_PERMISSIONS;

/** Default roles seeded for the inventory module. */
export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: string[] }[] = [
  {
    // ÚNICO rol con acceso total al inventario (crear/editar/eliminar) y el
    // único autorizado para asignar material a funcionarios.
    key: 'warehouse-manager',
    name: 'Jefe de bodega',
    description: 'Acceso total al inventario y único autorizado para asignar material a funcionarios',
    permissions: [
      P.ADMIN, // comodín: control total del inventario (productos, bodegas, movimientos, ajustes, etc.)
      P.ASSETS_ASSIGN, // entregar/asignar material a un funcionario
    ],
  },
  {
    // Antes "Administrador de inventario". Degradado a SOLO LECTURA: el control
    // total ahora es exclusivo del Jefe de bodega.
    key: 'inventory-admin',
    name: 'Consulta de inventario',
    description: 'Solo lectura: consulta de todo el inventario sin poder modificar',
    permissions: [
      P.PRODUCTS_READ, P.WAREHOUSES_READ, P.STOCK_READ, P.KARDEX_READ,
      P.PURCHASE_ORDERS_READ, P.ASSETS_READ,
      P.MAINTENANCE_READ, P.MAINTENANCE_PLANS_READ, P.AREAS_READ, P.REPORTS_READ,
    ],
  },
  {
    key: 'maintenance-technician',
    name: 'Técnico de mantenimiento',
    description: 'Ejecuta órdenes de trabajo asignadas por el jefe: actualiza estado y registra el consumo de repuestos de su propia orden',
    permissions: [
      P.PRODUCTS_READ, P.WAREHOUSES_READ, P.STOCK_READ,
      P.WORK_ORDERS_EXECUTE,
      P.MAINTENANCE_READ, P.MAINTENANCE_PLANS_READ, P.AREAS_READ,
    ],
  },
  {
    // Degradado a SOLO LECTURA: ya no registra movimientos ni recepciones.
    key: 'warehouse-clerk',
    name: 'Auxiliar de bodega',
    description: 'Solo consulta: existencias, productos y kardex (sin modificar)',
    permissions: [
      P.PRODUCTS_READ, P.WAREHOUSES_READ, P.STOCK_READ, P.KARDEX_READ,
    ],
  },
];

// ============================================================================
//  APP-WIDE RBAC — permisos de todo el ERP (no solo inventario)
// ============================================================================

/**
 * Permisos transversales de la plataforma. `SYSTEM_ADMIN` es el superusuario:
 * el PermissionsGuard lo deja pasar cualquier verificación.
 */
export const APP_PERMISSIONS = {
  // visibilidad de módulos
  DASHBOARD_VIEW: 'dashboard.view',
  // contabilidad
  ACCOUNTING_VIEW: 'accounting.view',
  ACCOUNTING_MANAGE: 'accounting.manage',
  // recursos humanos
  HR_EMPLOYEES_READ: 'hr.employees.read',
  HR_EMPLOYEES_WRITE: 'hr.employees.write',
  HR_ACCESS_MANAGE: 'hr.access.manage', // crear login del empleado y asignarle roles
  // administración del sistema
  USERS_MANAGE: 'system.users.manage',
  WHATSAPP_MANAGE: 'system.whatsapp', // canal de mensajería de la empresa (Kapso)
  SYSTEM_ADMIN: 'system.admin',
  // áreas de acceso Vestel — cada permiso habilita una sección del sidebar.
  // El superusuario (SYSTEM_ADMIN) las cumple todas por el bypass del guard.
  AREA_GERENCIA: 'area.gerencia',
  AREA_ADMINISTRACION: 'area.administracion',
  AREA_CONTABILIDAD: 'area.contabilidad',
  AREA_TECNICOS: 'area.tecnicos',
  AREA_SISTEMAS: 'area.sistemas',
  // Caja y ventas (cajera) — rol par del legacy "roleid=3". Sección propia del
  // sidebar acotada a caja + facturación/notas + clientes + tickets + órdenes.
  AREA_CAJA: 'area.caja',

  // ── Acciones DESTRUCTIVAS ────────────────────────────────────────────────
  // Hasta ahora estas operaciones sólo exigían "pertenecer al área", así que
  // cualquiera del área técnicos podía dejar sin servicio a todo el parque, y
  // cualquiera de contabilidad disparar la facturación de 21k abonados. Con los
  // interruptores en LIVE eso se ejecuta de verdad contra routers y OLTs.
  //
  // Se separan del área para poder tener un técnico que ve la red pero no corta.
  NETWORK_CUT: 'network.cut', // cortar servicio (individual y masivo)
  NETWORK_RECONNECT: 'network.reconnect', // reconectar servicio
  NETWORK_ROUTERS_MANAGE: 'network.routers.manage', // crear/borrar routers, tumbar sesiones PPPoE
  NETWORK_OLT_MANAGE: 'network.olt.manage', // autorizar/reiniciar/ELIMINAR ONUs por SSH
  CRON_RUN: 'system.cron.run', // disparar cronjobs a mano (facturación masiva, cartera)
} as const;

export type AppPermission = (typeof APP_PERMISSIONS)[keyof typeof APP_PERMISSIONS];

const A = APP_PERMISSIONS;

export const ALL_APP_PERMISSIONS: { key: string; label: string; group: string }[] = [
  { key: A.DASHBOARD_VIEW, label: 'Ver panel ejecutivo', group: 'General' },
  { key: A.ACCOUNTING_VIEW, label: 'Ver contabilidad', group: 'Contabilidad' },
  { key: A.ACCOUNTING_MANAGE, label: 'Gestionar contabilidad', group: 'Contabilidad' },
  { key: A.HR_EMPLOYEES_READ, label: 'Ver empleados (RRHH)', group: 'Recursos Humanos' },
  { key: A.HR_EMPLOYEES_WRITE, label: 'Gestionar empleados y documentos (RRHH)', group: 'Recursos Humanos' },
  { key: A.HR_ACCESS_MANAGE, label: 'Dar acceso al sistema y asignar roles (RRHH)', group: 'Recursos Humanos' },
  { key: A.USERS_MANAGE, label: 'Gestionar usuarios y roles', group: 'Administración' },
  { key: A.WHATSAPP_MANAGE, label: 'Gestionar conexión de WhatsApp', group: 'Administración' },
  { key: A.SYSTEM_ADMIN, label: 'Superadministrador (acceso total)', group: 'Administración' },
  // Áreas de acceso (visibilidad de secciones del sidebar Vestel)
  { key: A.AREA_GERENCIA, label: 'Área: Gerencia', group: 'Áreas Vestel' },
  { key: A.AREA_ADMINISTRACION, label: 'Área: Administración', group: 'Áreas Vestel' },
  { key: A.AREA_CONTABILIDAD, label: 'Área: Contabilidad', group: 'Áreas Vestel' },
  { key: A.AREA_TECNICOS, label: 'Área: Técnicos', group: 'Áreas Vestel' },
  { key: A.AREA_SISTEMAS, label: 'Área: Sistemas', group: 'Áreas Vestel' },
  { key: A.AREA_CAJA, label: 'Área: Caja y ventas', group: 'Áreas Vestel' },
  // Acciones destructivas — se conceden aparte del área a propósito.
  { key: A.NETWORK_CUT, label: 'Cortar servicio (individual y masivo)', group: 'Operaciones críticas' },
  { key: A.NETWORK_RECONNECT, label: 'Reconectar servicio', group: 'Operaciones críticas' },
  { key: A.NETWORK_ROUTERS_MANAGE, label: 'Administrar routers y sesiones PPPoE', group: 'Operaciones críticas' },
  { key: A.NETWORK_OLT_MANAGE, label: 'Administrar ONUs de la OLT (autorizar/reiniciar/eliminar)', group: 'Operaciones críticas' },
  { key: A.CRON_RUN, label: 'Ejecutar procesos programados a mano (facturación masiva)', group: 'Operaciones críticas' },
];

/** Permiso que otorga acceso total — verificado por el PermissionsGuard. */
export const SUPERADMIN_PERMISSION = APP_PERMISSIONS.SYSTEM_ADMIN;

// ============================================================================
//  SST — Seguridad y Salud en el Trabajo
// ============================================================================

export const SST_PERMISSIONS = {
  VIEW: 'sst.view',
  ADMIN: 'sst.admin',
  EMPLOYEES_READ: 'sst.employees.read',
  EMPLOYEES_WRITE: 'sst.employees.write',
  RISKS_READ: 'sst.risks.read',
  RISKS_WRITE: 'sst.risks.write',
  EPP_READ: 'sst.epp.read',
  EPP_WRITE: 'sst.epp.write',
  MEDICAL_READ: 'sst.medical.read',
  MEDICAL_WRITE: 'sst.medical.write',
  TRAINING_READ: 'sst.training.read',
  TRAINING_WRITE: 'sst.training.write',
  INCIDENTS_READ: 'sst.incidents.read',
  INCIDENTS_WRITE: 'sst.incidents.write',
  INSPECTIONS_READ: 'sst.inspections.read',
  INSPECTIONS_WRITE: 'sst.inspections.write',
  FINDINGS_READ: 'sst.findings.read',
  FINDINGS_WRITE: 'sst.findings.write',
  FINDINGS_APPROVE: 'sst.findings.approve',
  DOCUMENTS_READ: 'sst.documents.read',
  DOCUMENTS_WRITE: 'sst.documents.write',
  DOCUMENTS_APPROVE: 'sst.documents.approve',
  EMERGENCY_READ: 'sst.emergency.read',
  EMERGENCY_WRITE: 'sst.emergency.write',
  BRIGADES_READ: 'sst.brigades.read',
  BRIGADES_WRITE: 'sst.brigades.write',
  DRILLS_READ: 'sst.drills.read',
  DRILLS_WRITE: 'sst.drills.write',
  CONTRACTORS_READ: 'sst.contractors.read',
  CONTRACTORS_WRITE: 'sst.contractors.write',
  AUDITS_READ: 'sst.audits.read',
  AUDITS_WRITE: 'sst.audits.write',
  REPORTS_READ: 'sst.reports.read',
} as const;

export type SstPermission = (typeof SST_PERMISSIONS)[keyof typeof SST_PERMISSIONS];

const S = SST_PERMISSIONS;

export const ALL_SST_PERMISSIONS: { key: string; label: string }[] = [
  { key: S.VIEW, label: 'Ver módulo SST' },
  { key: S.ADMIN, label: 'Administración total de SST' },
  { key: S.EMPLOYEES_READ, label: 'Ver empleados (SST)' },
  { key: S.EMPLOYEES_WRITE, label: 'Gestionar empleados (SST)' },
  { key: S.RISKS_READ, label: 'Ver matriz de riesgos' },
  { key: S.RISKS_WRITE, label: 'Gestionar matriz de riesgos' },
  { key: S.EPP_READ, label: 'Ver EPP' },
  { key: S.EPP_WRITE, label: 'Gestionar EPP' },
  { key: S.MEDICAL_READ, label: 'Ver exámenes médicos' },
  { key: S.MEDICAL_WRITE, label: 'Gestionar exámenes médicos' },
  { key: S.TRAINING_READ, label: 'Ver capacitaciones' },
  { key: S.TRAINING_WRITE, label: 'Gestionar capacitaciones' },
  { key: S.INCIDENTS_READ, label: 'Ver incidentes' },
  { key: S.INCIDENTS_WRITE, label: 'Gestionar incidentes' },
  { key: S.INSPECTIONS_READ, label: 'Ver inspecciones' },
  { key: S.INSPECTIONS_WRITE, label: 'Gestionar inspecciones' },
  { key: S.FINDINGS_READ, label: 'Ver hallazgos y acciones' },
  { key: S.FINDINGS_WRITE, label: 'Gestionar hallazgos y acciones' },
  { key: S.FINDINGS_APPROVE, label: 'Cerrar/verificar acciones correctivas' },
  { key: S.DOCUMENTS_READ, label: 'Ver documentos SST' },
  { key: S.DOCUMENTS_WRITE, label: 'Gestionar documentos SST' },
  { key: S.DOCUMENTS_APPROVE, label: 'Aprobar documentos SST' },
  { key: S.EMERGENCY_READ, label: 'Ver equipos de emergencia' },
  { key: S.EMERGENCY_WRITE, label: 'Gestionar equipos de emergencia' },
  { key: S.BRIGADES_READ, label: 'Ver brigadas' },
  { key: S.BRIGADES_WRITE, label: 'Gestionar brigadas' },
  { key: S.DRILLS_READ, label: 'Ver simulacros' },
  { key: S.DRILLS_WRITE, label: 'Gestionar simulacros' },
  { key: S.CONTRACTORS_READ, label: 'Ver contratistas' },
  { key: S.CONTRACTORS_WRITE, label: 'Gestionar contratistas' },
  { key: S.AUDITS_READ, label: 'Ver auditorías SST' },
  { key: S.AUDITS_WRITE, label: 'Gestionar auditorías SST' },
  { key: S.REPORTS_READ, label: 'Ver reportes SST' },
];

/** Roles por defecto del módulo SST. */
export const SST_ROLES: { key: string; name: string; description: string; permissions: string[] }[] = [
  {
    key: 'sst-admin',
    name: 'Administrador SST',
    description: 'Control total del módulo de Seguridad y Salud en el Trabajo',
    permissions: [A.DASHBOARD_VIEW, ...ALL_SST_PERMISSIONS.map((p) => p.key)],
  },
  {
    key: 'sst-coordinator',
    name: 'Coordinador SST',
    description: 'Operación SST: riesgos, EPP, médicos, capacitaciones, incidentes, hallazgos',
    permissions: [
      A.DASHBOARD_VIEW, S.VIEW,
      S.EMPLOYEES_READ, S.EMPLOYEES_WRITE, S.RISKS_READ, S.RISKS_WRITE,
      S.EPP_READ, S.EPP_WRITE, S.MEDICAL_READ, S.MEDICAL_WRITE,
      S.TRAINING_READ, S.TRAINING_WRITE, S.INCIDENTS_READ, S.INCIDENTS_WRITE,
      S.INSPECTIONS_READ, S.INSPECTIONS_WRITE, S.FINDINGS_READ, S.FINDINGS_WRITE, S.FINDINGS_APPROVE,
      S.DOCUMENTS_READ, S.DOCUMENTS_WRITE, S.EMERGENCY_READ, S.EMERGENCY_WRITE,
      S.BRIGADES_READ, S.BRIGADES_WRITE, S.DRILLS_READ, S.DRILLS_WRITE,
      S.CONTRACTORS_READ, S.CONTRACTORS_WRITE, S.AUDITS_READ, S.AUDITS_WRITE, S.REPORTS_READ,
    ],
  },
  {
    key: 'sst-inspector',
    name: 'Inspector SST',
    description: 'Inspecciones, incidentes y hallazgos en campo',
    permissions: [
      A.DASHBOARD_VIEW, S.VIEW,
      S.EMPLOYEES_READ, S.RISKS_READ, S.EPP_READ, S.MEDICAL_READ, S.TRAINING_READ,
      S.INCIDENTS_READ, S.INCIDENTS_WRITE, S.INSPECTIONS_READ, S.INSPECTIONS_WRITE,
      S.FINDINGS_READ, S.FINDINGS_WRITE, S.EMERGENCY_READ, S.DRILLS_READ, S.REPORTS_READ,
    ],
  },
];

// ============================================================================
//  PAYROLL — Nómina Inteligente
// ============================================================================

export const PAYROLL_PERMISSIONS = {
  VIEW: 'payroll.view',
  ADMIN: 'payroll.admin',
  CONCEPTS_READ: 'payroll.concepts.read',
  CONCEPTS_WRITE: 'payroll.concepts.write',
  CONTRACTS_READ: 'payroll.contracts.read',
  CONTRACTS_WRITE: 'payroll.contracts.write',
  PERIODS_READ: 'payroll.periods.read',
  PERIODS_WRITE: 'payroll.periods.write', // abrir / procesar / cerrar
  EVENTS_READ: 'payroll.events.read',
  EVENTS_WRITE: 'payroll.events.write',
  EVENTS_APPROVE: 'payroll.events.approve',
  PAYSLIPS_READ: 'payroll.payslips.read',
  PAYSLIPS_WRITE: 'payroll.payslips.write', // calcular / emitir
  // El empleado consulta ÚNICAMENTE su propia nómina (auto-scoping en el service).
  SELF_READ: 'payroll.self.read',
  REPORTS_READ: 'payroll.reports.read',
  // integraciones contables externas (Siigo/Alegra/…)
  INTEGRATIONS_MANAGE: 'payroll.integrations.manage',
} as const;

export type PayrollPermission = (typeof PAYROLL_PERMISSIONS)[keyof typeof PAYROLL_PERMISSIONS];

const PR = PAYROLL_PERMISSIONS;

export const ALL_PAYROLL_PERMISSIONS: { key: string; label: string }[] = [
  { key: PR.VIEW, label: 'Ver módulo de nómina' },
  { key: PR.ADMIN, label: 'Administración total de nómina' },
  { key: PR.CONCEPTS_READ, label: 'Ver conceptos de nómina' },
  { key: PR.CONCEPTS_WRITE, label: 'Gestionar conceptos de nómina' },
  { key: PR.CONTRACTS_READ, label: 'Ver contratos' },
  { key: PR.CONTRACTS_WRITE, label: 'Gestionar contratos' },
  { key: PR.PERIODS_READ, label: 'Ver periodos de nómina' },
  { key: PR.PERIODS_WRITE, label: 'Gestionar periodos (abrir/procesar/cerrar)' },
  { key: PR.EVENTS_READ, label: 'Ver novedades de nómina' },
  { key: PR.EVENTS_WRITE, label: 'Registrar novedades de nómina' },
  { key: PR.EVENTS_APPROVE, label: 'Aprobar novedades de nómina' },
  { key: PR.PAYSLIPS_READ, label: 'Ver desprendibles (todos)' },
  { key: PR.PAYSLIPS_WRITE, label: 'Calcular y emitir desprendibles' },
  { key: PR.SELF_READ, label: 'Ver mi propia nómina (portal empleado)' },
  { key: PR.REPORTS_READ, label: 'Ver reportes de nómina' },
  { key: PR.INTEGRATIONS_MANAGE, label: 'Gestionar integraciones contables (Siigo, etc.)' },
];

/** Roles por defecto del módulo de nómina. */
export const PAYROLL_ROLES: { key: string; name: string; description: string; permissions: string[] }[] = [
  {
    key: 'payroll-manager',
    name: 'Gestor de Nómina (RRHH)',
    description: 'Operación completa de nómina: conceptos, contratos, periodos, novedades, liquidación y desprendibles',
    permissions: [
      A.DASHBOARD_VIEW, A.HR_EMPLOYEES_READ,
      PR.VIEW, PR.CONCEPTS_READ, PR.CONCEPTS_WRITE, PR.CONTRACTS_READ, PR.CONTRACTS_WRITE,
      PR.PERIODS_READ, PR.PERIODS_WRITE, PR.EVENTS_READ, PR.EVENTS_WRITE, PR.EVENTS_APPROVE,
      PR.PAYSLIPS_READ, PR.PAYSLIPS_WRITE, PR.REPORTS_READ, PR.INTEGRATIONS_MANAGE,
    ],
  },
  {
    key: 'employee-self',
    name: 'Empleado (autoservicio)',
    description: 'Consulta únicamente su propia nómina: desprendibles, vacaciones y horas extras acumuladas',
    permissions: [PR.SELF_READ],
  },
];

// ============================================================================
//  PANTALLAS (screens) — permiso por módulo/submódulo del sidebar
// ============================================================================
// Un permiso por cada nodo del menú (`screen.*`), para asignar acceso fino por
// EMPLEADO (árbol de checkboxes) además del rol base. La llave se deriva del
// `href` de la pantalla: `/facturacion/notas` → `screen.facturacion.notas`.
// `module` agrupa en la UI; `areas` dice qué roles de área la traen por defecto.
// ESTA LISTA ES EL ESPEJO DE `frontend/src/lib/nav.ts` — mantener sincronizadas.

/** Deriva la llave de permiso de una pantalla a partir de su href. */
export const screenKey = (href: string) => 'screen' + href.replace(/\//g, '.');

export interface ScreenDef {
  href: string;
  label: string;
  module: string;
  areas: string[]; // slugs de área (sin el prefijo "area.")
}

export const SCREENS: ScreenDef[] = [
  { href: '/dashboard', label: 'Panel ejecutivo', module: 'Gerencia', areas: ['gerencia'] },
  { href: '/reportes', label: 'Reportes / Indicadores', module: 'Gerencia', areas: ['gerencia'] },

  { href: '/facturacion', label: 'Administrar facturas', module: 'Facturación', areas: ['contabilidad', 'caja'] },
  { href: '/facturacion/notas', label: 'Notas crédito/débito', module: 'Facturación', areas: ['contabilidad', 'caja'] },
  { href: '/facturacion/electronica', label: 'Facturas electrónicas', module: 'Facturación', areas: ['contabilidad'] },
  { href: '/cotizaciones', label: 'Cotizaciones', module: 'Facturación', areas: ['contabilidad'] },

  { href: '/tesoreria', label: 'Movimientos de caja', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  { href: '/tesoreria/apertura', label: 'Apertura de caja', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  { href: '/tesoreria/cierres', label: 'Cierre de caja', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  { href: '/tesoreria/importar-pagos', label: 'Importar pagos (Efecty)', module: 'Caja / Cobranza', areas: ['administracion', 'caja'] },

  { href: '/contabilidad', label: 'Resumen contable', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/plan-de-cuentas', label: 'Plan de cuentas', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/libros', label: 'Libro diario y mayor', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/informes', label: 'Balance y estados financieros', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/mapeo-cuentas', label: 'Mapeo de cuentas', module: 'Contabilidad', areas: ['contabilidad'] },

  { href: '/clientes', label: 'Clientes', module: 'Clientes', areas: ['administracion', 'caja'] },
  { href: '/cobranza', label: 'Cobranza / Acuerdos de pago', module: 'Clientes', areas: ['administracion', 'caja'] },
  { href: '/playhub', label: 'PlayHub / IPTV', module: 'Clientes', areas: ['administracion'] },

  { href: '/soporte', label: 'Tickets / Órdenes de trabajo', module: 'Soporte', areas: ['tecnicos', 'caja'] },

  { href: '/red/conexiones', label: 'Conexiones', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/transferencias', label: 'Transferencias', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/equipos', label: 'Administrar equipos', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/equipos/nuevo', label: 'Ingreso de equipo', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/bodegas', label: 'Bodega de equipos', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red', label: 'Red / ISP (resumen)', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/onus', label: 'ONUs', module: 'Red / ISP', areas: ['tecnicos'] },
  // Faltaban en el catálogo pese a estar en el nav: sin llave de pantalla, `can()`
  // solo las concedía a system.admin, así que un técnico no las veía en el menú.
  { href: '/red/naps', label: 'Cajas NAP', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/olt', label: 'Gestión OLT', module: 'Red / ISP', areas: ['tecnicos'] },
  { href: '/red/genieacs', label: 'GenieACS · TR-069', module: 'Red / ISP', areas: ['tecnicos'] },

  // MIKROTIK — módulo propio (2026-07-15). `/mikrotik/masivo` es el antiguo
  // `/red/masivo`: su llave se renombra en BD conservando las concesiones.
  { href: '/mikrotik', label: 'Gestión de routers', module: 'Mikrotik', areas: ['tecnicos'] },
  { href: '/mikrotik/masivo', label: 'Operaciones masivas', module: 'Mikrotik', areas: ['tecnicos'] },
  { href: '/mikrotik/ips', label: 'IPs de usuarios', module: 'Mikrotik', areas: ['tecnicos'] },

  { href: '/inventario', label: 'Material', module: 'Inventario / Compras', areas: ['administracion'] },
  { href: '/inventario/traspasos', label: 'Traspasos', module: 'Inventario / Compras', areas: ['administracion'] },
  { href: '/ordenes', label: 'Órdenes de compra', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/proveedores', label: 'Proveedores', module: 'Inventario / Compras', areas: ['administracion'] },
  { href: '/devoluciones', label: 'Devoluciones', module: 'Inventario / Compras', areas: ['administracion'] },

  { href: '/empleados', label: 'Empleados', module: 'Personas y Proyectos', areas: ['administracion'] },
  { href: '/proyectos', label: 'Proyectos', module: 'Personas y Proyectos', areas: ['administracion'] },
  { href: '/agenda', label: 'Agenda / Tareas', module: 'Personas y Proyectos', areas: ['administracion', 'caja'] },
  { href: '/tareas', label: 'Tareas / Pendientes', module: 'Personas y Proyectos', areas: ['administracion', 'gerencia', 'tecnicos', 'caja'] },

  { href: '/configuracion', label: 'Configuración', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/planes', label: 'Planes de servicio', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/api', label: 'API pública', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/usuarios', label: 'Usuarios y roles', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/whatsapp', label: 'Mensajería / WhatsApp', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/chatbot', label: 'Agente de WhatsApp (bot)', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/automatizaciones', label: 'Automatizaciones', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/actividad', label: 'Bitácora / Auditoría', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/datos', label: 'Importar / Exportar', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/mensajes', label: 'Mensajería', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/documentos', label: 'Documentos', module: 'Sistemas', areas: ['sistemas'] },
];

/** Todas las pantallas como permisos, para sembrar (`Permission`) y agrupar en la UI. */
export const ALL_SCREEN_PERMISSIONS: { key: string; label: string; group: string }[] = SCREENS.map((s) => ({
  key: screenKey(s.href),
  label: s.label,
  group: `Pantalla · ${s.module}`,
}));

/** Llaves de pantalla que un área trae por defecto (para expandir sus roles). */
export const screensForArea = (area: string): string[] =>
  SCREENS.filter((s) => s.areas.includes(area)).map((s) => screenKey(s.href));

/** Catálogo completo de permisos del ERP (transversales + inventario), agrupado. */
export const ALL_PERMISSIONS: { key: string; label: string; group: string }[] = [
  ...ALL_APP_PERMISSIONS,
  ...ALL_INV_PERMISSIONS.map((p) => ({ ...p, group: 'Inventario' })),
  ...ALL_SST_PERMISSIONS.map((p) => ({ ...p, group: 'SST' })),
  ...ALL_PAYROLL_PERMISSIONS.map((p) => ({ ...p, group: 'Nómina' })),
  ...ALL_SCREEN_PERMISSIONS,
];

/** Áreas para AGRUPAR los roles en la UI (orden de presentación). */
export const ROLE_AREAS = ['Áreas Vestel', 'Administración', 'Inventario', 'Recursos Humanos', 'Contabilidad', 'SST'] as const;
export type RoleArea = (typeof ROLE_AREAS)[number];

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  area: RoleArea;
  permissions: string[];
}

/**
 * Roles por defecto de TODO el ERP. Cada uno empaqueta un conjunto de permisos
 * y pertenece a un `area` para agruparlos en la administración.
 * Se siembran en la base de datos y se gestionan desde la UI.
 */
export const ALL_ROLES: RoleDef[] = [
  {
    key: 'super-admin',
    name: 'Superadministrador',
    description: 'Acceso total a toda la plataforma',
    area: 'Administración',
    permissions: ALL_PERMISSIONS.map((p) => p.key),
  },
  // ---- Áreas de acceso Vestel (organizan el sidebar por área) ----
  // El Superusuario es `super-admin` (system.admin ⇒ ve todas las áreas).
  {
    key: 'area-gerencia',
    name: 'Gerencia',
    description: 'Visión ejecutiva: panel de indicadores y reportes',
    area: 'Áreas Vestel',
    permissions: [A.AREA_GERENCIA, A.DASHBOARD_VIEW, ...screensForArea('gerencia')],
  },
  {
    key: 'area-administracion',
    name: 'Administración',
    description: 'Clientes, inventario, compras, empleados y proyectos',
    area: 'Áreas Vestel',
    permissions: [A.AREA_ADMINISTRACION, A.DASHBOARD_VIEW, A.HR_EMPLOYEES_READ, ...screensForArea('administracion')],
  },
  {
    key: 'area-contabilidad',
    name: 'Contabilidad',
    description: 'Facturación, cobranza/caja y facturación electrónica',
    area: 'Áreas Vestel',
    permissions: [A.AREA_CONTABILIDAD, A.DASHBOARD_VIEW, A.ACCOUNTING_VIEW, A.CRON_RUN, ...screensForArea('contabilidad')],
  },
  {
    key: 'area-tecnicos',
    name: 'Técnicos',
    description: 'Soporte/tickets, red/ISP, equipos y corte/reconexión',
    area: 'Áreas Vestel',
    // Las acciones destructivas se incluyen para que el rol siga funcionando igual
    // que antes de separarlas. Quitarlas de aquí es lo que permite tener un técnico
    // de consulta; esa decisión es de negocio, no del refactor.
    permissions: [
      A.AREA_TECNICOS,
      A.NETWORK_CUT, A.NETWORK_RECONNECT, A.NETWORK_ROUTERS_MANAGE, A.NETWORK_OLT_MANAGE,
      ...screensForArea('tecnicos'),
    ],
  },
  {
    key: 'area-sistemas',
    name: 'Sistemas',
    description: 'Configuración, usuarios y roles, WhatsApp y dispositivos',
    area: 'Áreas Vestel',
    permissions: [
      A.AREA_SISTEMAS, A.USERS_MANAGE, A.WHATSAPP_MANAGE, A.CRON_RUN,
      A.NETWORK_ROUTERS_MANAGE, A.NETWORK_OLT_MANAGE,
      ...screensForArea('sistemas'),
    ],
  },
  {
    // Cajera (legacy "Caja y ventas", roleid=3). Rol acotado a la operación de
    // caja: apertura/cierre/movimientos + facturación + notas + clientes +
    // tickets + órdenes + agenda. NO ve e-factura, ni config, ni el resto del
    // sistema. Su sección propia en el sidebar se gatea con `area.caja`.
    key: 'area-caja',
    name: 'Caja y ventas',
    description: 'Cajera: apertura/cierre de caja, movimientos, facturación, notas, clientes, tickets y órdenes',
    area: 'Áreas Vestel',
    permissions: [A.AREA_CAJA, A.ACCOUNTING_VIEW, ...screensForArea('caja')],
  },
  {
    key: 'auditor',
    name: 'Auditoría / Consulta',
    description: 'Solo lectura transversal: panel, contabilidad e inventario',
    area: 'Administración',
    permissions: [
      A.DASHBOARD_VIEW, A.ACCOUNTING_VIEW,
      P.PRODUCTS_READ, P.WAREHOUSES_READ, P.STOCK_READ, P.KARDEX_READ, P.REPORTS_READ,
    ],
  },
  // ---- Inventario / Bodega (con visibilidad del panel general añadida) ----
  ...DEFAULT_ROLES.map((r): RoleDef => ({
    ...r,
    area: 'Inventario',
    permissions: [A.DASHBOARD_VIEW, ...r.permissions],
  })),
  // ---- Recursos Humanos / Nómina ----
  {
    key: 'hr-director',
    name: 'Director de Recursos Humanos',
    description: 'Gestiona empleados, sus documentos y su acceso al sistema (crea logins y asigna roles)',
    area: 'Recursos Humanos',
    permissions: [A.DASHBOARD_VIEW, A.HR_EMPLOYEES_READ, A.HR_EMPLOYEES_WRITE, A.HR_ACCESS_MANAGE],
  },
  {
    key: 'hr-assistant',
    name: 'Asistente de Recursos Humanos',
    description: 'Crea y administra fichas y documentos de empleados, sin poder otorgar acceso ni roles',
    area: 'Recursos Humanos',
    permissions: [A.DASHBOARD_VIEW, A.HR_EMPLOYEES_READ, A.HR_EMPLOYEES_WRITE],
  },
  ...PAYROLL_ROLES.map((r): RoleDef => ({ ...r, area: 'Recursos Humanos' })),
  // ---- Contabilidad ----
  {
    key: 'accountant',
    name: 'Contador',
    description: 'Operación completa de contabilidad y nómina',
    area: 'Contabilidad',
    permissions: [
      A.DASHBOARD_VIEW, A.ACCOUNTING_VIEW, A.ACCOUNTING_MANAGE,
      // Nómina (vive dentro de /contabilidad): operación completa.
      PR.VIEW, PR.CONCEPTS_READ, PR.CONCEPTS_WRITE, PR.CONTRACTS_READ, PR.CONTRACTS_WRITE,
      PR.PERIODS_READ, PR.PERIODS_WRITE, PR.EVENTS_READ, PR.EVENTS_WRITE, PR.EVENTS_APPROVE,
      PR.PAYSLIPS_READ, PR.PAYSLIPS_WRITE, PR.REPORTS_READ, PR.INTEGRATIONS_MANAGE,
    ],
  },
  // ---- SST ----
  ...SST_ROLES.map((r): RoleDef => ({ ...r, area: 'SST' })),
];

/** Lookup rápido key → área (para anexar el grupo a los roles de la BD). */
export const ROLE_AREA_BY_KEY: Record<string, RoleArea> = Object.fromEntries(
  ALL_ROLES.map((r) => [r.key, r.area]),
) as Record<string, RoleArea>;
