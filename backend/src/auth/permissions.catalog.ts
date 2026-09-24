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
];

// RETIRADOS el 2026-07-29, por decisión de negocio: el catálogo tenía 23 roles y
// solo 12 con alguien asignado. Se fueron los que nadie usaba —bien porque
// duplicaban a otro recortándole permisos, bien porque mandaban sobre un módulo
// que no está construido—:
//
//   inventory-admin         duplicaba a auditor, acotado a inventario
//   warehouse-clerk         duplicaba a warehouse-manager en solo lectura
//   maintenance-technician  órdenes de trabajo: sin pantallas
//   hr-assistant            duplicaba a hr-director en solo lectura
//   payroll-manager         nómina: sin pantallas
//   employee-self           portal del empleado: sin pantallas
//   sst-admin / sst-coordinator / sst-inspector   SST: sin módulo
//
// El respaldo con sus permisos exactos está en prisma/_respaldo-roles-2026-07-29.json.
// Si mañana se construye SST o Nómina, sus roles se diseñan de nuevo contra las
// pantallas que existan, no contra las que se imaginaron.

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
  // Atender la bandeja: ver los chats y responderlos. Aparte de WHATSAPP_MANAGE a
  // propósito — contestarle a un cliente no debe exigir acceso a las credenciales
  // del canal, ni a las campañas masivas.
  WHATSAPP_INBOX: 'whatsapp.inbox',
  SYSTEM_ADMIN: 'system.admin',
  // áreas de acceso Vestel — cada permiso habilita una sección del sidebar.
  // El superusuario (SYSTEM_ADMIN) las cumple todas por el bypass del guard.
  AREA_GERENCIA: 'area.gerencia',
  AREA_ADMINISTRACION: 'area.administracion',
  AREA_CONTABILIDAD: 'area.contabilidad',
  AREA_TECNICOS: 'area.tecnicos',
  AREA_SISTEMAS: 'area.sistemas',
  // Caja y ventas (cajera) — rol par del legacy "roleid=3". Sección propia del
  // sidebar acotada a la operación de su caja + clientes + tickets + órdenes.
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
  // El interruptor manual del legacy (ficha ▸ Activar/Desactivar): mete o saca la IP
  // del abonado de la address-list MOROSOS y NADA MÁS —no toca el estado de la ficha,
  // no tumba la sesión, no abre orden—. Es la herramienta de quien está depurando el
  // parque a mano y necesita probar si un cliente pasa o no pasa por el firewall.
  //
  // Es NOMINAL (ver PERMISOS_NOMINALES): se pidió "sólo para Santiago García", y con
  // veinte superusuarios activos un permiso normal no puede significar eso.
  NETWORK_MOROSOS_TOGGLE: 'network.morosos.toggle',
  CRON_RUN: 'system.cron.run', // disparar cronjobs a mano (facturación masiva, cartera)
  PURCHASES_APPROVE: 'purchases.approve', // aprobar órdenes de compra (1ª y 2ª firma)
  // Editar el catálogo de cláusulas de permanencia. Va aparte del área porque esos
  // valores son lo que se le cobra a un cliente que se retira antes de tiempo: los
  // consulta cualquiera que dé de alta un abonado, los cambia gerencia.
  CONTRACTS_MANAGE: 'contracts.manage',
  // Escribir sobre una ORDEN de servicio: abrirla, corregirla, asignarla, cambiarle
  // el estado, documentarla, firmarla, descargarle material o equipo. Va aparte del
  // área porque hasta ahora "ver las órdenes" y "tocarlas" eran lo mismo —el área
  // técnicos/caja/administración abría las dos puertas—, y hay quien debe seguir la
  // operación sin poder alterarla (jefaturas, auditoría). Sin este permiso, /soporte
  // es una pantalla de consulta: la lista, el detalle, el PDF y el Excel, nada más.
  SUPPORT_WRITE: 'support.write',
  // Emitir notas crédito/débito sobre una factura: la del módulo /facturacion/notas
  // (rebaja o recargo sobre cartera) y la nota crédito ELECTRÓNICA ante la DIAN.
  //
  // Es un permiso NOMINAL —ver PERMISOS_NOMINALES, más abajo—: se concede persona a
  // persona y NO lo hereda el superusuario. Rebajarle la deuda a un abonado es mover
  // plata sin que entre plata, y hasta 2026-09-10 podía hacerlo todo el área de
  // contabilidad (y, por el atajo de `system.admin`, los trece superusuarios).
  BILLING_NOTES_EMIT: 'billing.notes.emit',
  // Operar PlayHub desde la ficha del cliente: consultar, crear la cuenta, activar y
  // cancelar paquetes. Va aparte del área para dárselo a una persona sin abrirle toda
  // administración (2026-09-17: Edgar Esteban Rodriguez, cajero). La barrida masiva
  // (`/playhub/sync-all`) NO entra: sigue siendo de las áreas.
  PLAYHUB_OPERATE: 'playhub.operate',
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
  { key: A.WHATSAPP_INBOX, label: 'Atender la bandeja de WhatsApp (ver y responder chats)', group: 'Administración' },
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
  { key: A.NETWORK_MOROSOS_TOGGLE, label: 'Activar/Desactivar la IP en la lista MOROSOS (interruptor manual)', group: 'Operaciones críticas' },
  { key: A.CRON_RUN, label: 'Ejecutar procesos programados a mano (facturación masiva)', group: 'Operaciones críticas' },
  { key: A.PURCHASES_APPROVE, label: 'Aprobar órdenes de compra', group: 'Operaciones críticas' },
  { key: A.CONTRACTS_MANAGE, label: 'Editar cláusulas de permanencia del contrato', group: 'Operaciones críticas' },
  { key: A.SUPPORT_WRITE, label: 'Crear y modificar órdenes de servicio (sin él, solo consulta)', group: 'Soporte' },
  { key: A.BILLING_NOTES_EMIT, label: 'Emitir notas crédito/débito (incluida la nota crédito DIAN)', group: 'Operaciones críticas' },
  { key: A.PLAYHUB_OPERATE, label: 'Operar PlayHub en la ficha del cliente (crear cuenta, activar y cancelar)', group: 'Clientes' },
];

/**
 * Permisos que se conceden PERSONA A PERSONA y que el superusuario NO hereda.
 *
 * El `PermissionsGuard` deja pasar a `system.admin` cualquier comprobación, así que
 * un permiso normal nunca puede significar "sólo estas dos personas": hay trece
 * superusuarios activos y todos lo cumplirían por el atajo. Estos se comprueban
 * mirando la lista de permisos efectivos TAL CUAL, sin atajo.
 *
 * Por lo mismo quedan fuera de los permisos del rol `super-admin` (que se siembra
 * como "todo el catálogo"): si entraran ahí, una re-siembra de roles se los daría
 * a los trece de vuelta y el candado se abriría sin que nadie lo pidiera.
 */
export const PERMISOS_NOMINALES: string[] = [
  APP_PERMISSIONS.BILLING_NOTES_EMIT,
  APP_PERMISSIONS.NETWORK_MOROSOS_TOGGLE,
];

/**
 * ¿Este usuario tiene un permiso NOMINAL? Mira la lista de permisos efectivos tal
 * cual: sin el atajo de `system.admin` y sin el de `inventory.admin`, que son los
 * dos que `exigirPermisos` aplica. Se usa DENTRO de la operación (servicio o
 * pantalla), no en la ruta: la ruta sigue exigiendo el permiso por el camino normal
 * y esto es lo que remata el candado.
 */
export function tienePermisoNominal(
  user: { permissions?: string[] | null } | null | undefined,
  permiso: string,
): boolean {
  return !!user && (user.permissions ?? []).includes(permiso);
}

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

// Los roles del módulo SST se retiraron el 2026-07-29 (ver nota arriba): el
// módulo no está construido.

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
// Los roles de Nómina se retiraron el 2026-07-29 (ver nota arriba): el módulo
// no tiene pantallas.

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

/** Sedes del módulo "Equipos disponibles". ESPEJO de `SEDES_DISPONIBLES` en `frontend/src/lib/nav.ts`. */
export const SEDES_DISPONIBLES = [
  { slug: 'yopal', label: 'Yopal' },
  { slug: 'villanueva', label: 'Villanueva' },
  { slug: 'monterrey', label: 'Monterrey' },
  { slug: 'aguazul', label: 'Aguazul' },
  { slug: 'tauramena', label: 'Tauramena' },
  { slug: 'villavicencio', label: 'Villavicencio' },
  { slug: 'mocoa', label: 'Mocoa' },
] as const;

export interface ScreenDef {
  href: string;
  label: string;
  module: string;
  areas: string[]; // slugs de área (sin el prefijo "area.")
}

export const SCREENS: ScreenDef[] = [
  // Una sola ruta, TRES paneles: gerencia ve el ejecutivo (abonados, cartera,
  // recaudo, red), la cajera el de SU caja (el informe del cierre del día) y el
  // técnico su jornada (las órdenes que le tocan hoy y su rendimiento).
  // La pantalla decide cuál pintar según el área; el endpoint `/dashboard` sigue
  // siendo de gerencia — cada uno de los otros dos se sirve de los suyos, ya
  // acotados a quien pregunta: tesorería por caja, `/support/mi-*` por sesión.
  { href: '/dashboard', label: 'Panel (ejecutivo / de caja / del técnico)', module: 'Gerencia', areas: ['gerencia', 'caja', 'tecnicos'] },
  // REPORTES — una pantalla por reporte (2026-07-28). Antes era una sola ruta
  // con un selector adentro; al partirla, cada reporte tiene URL propia y por
  // tanto permiso propio, que es lo que permite dar acceso a "Recaudo" sin dar
  // acceso a "Rendimiento de técnicos".
  { href: '/reportes', label: 'Reportes (índice)', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/tendencias', label: 'Tendencias e histórico', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/indice-recaudo', label: 'Índice de recaudo', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/arpu', label: 'ARPU por abonado', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/permanencia', label: 'Antigüedad y permanencia', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/capacidad-red', label: 'Capacidad de red (NAPs)', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/reincidencia', label: 'Reincidencia de cortes', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/facturacion', label: 'Resumen de facturación', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/recaudo', label: 'Recaudo', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/ventas-sede', label: 'Ventas por sede', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/ingresos-egresos', label: 'Ingresos y egresos', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/cartera', label: 'Cartera / deudores', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/cartera-seguimiento', label: 'Seguimiento de cartera', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/iva', label: 'Reporte de IVA', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/ordenes', label: 'Órdenes de servicio', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/cortes-activaciones', label: 'Cortes y activaciones', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/estado-clientes', label: 'Estado de clientes', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/altas-retiros', label: 'Altas y retiros', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/tecnicos', label: 'Rendimiento de técnicos', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/recaudo-funcionario', label: 'Recaudo por funcionario', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/afiliados', label: 'Afiliados por funcionario', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/anulaciones', label: 'Anulaciones (control)', module: 'Reportes', areas: ['gerencia'] },
  { href: '/reportes/actividad', label: 'Actividad en el sistema', module: 'Reportes', areas: ['gerencia'] },

  // FACTURACIÓN era de contabilidad y NO de la cajera (decisión 2026-07-29): ella
  // recaudaba sobre facturas que ya existían. Se revisó el 2026-08-27: cobrar en
  // ventanilla algo aún no facturado —instalación, traslado, venta de equipo,
  // reconexión— la obligaba a pedirle la factura a contabilidad con el cliente
  // delante, así que la pantalla pasa a ser suya también.
  //
  // Lo que ve NO es lo mismo que ve contabilidad: el listado ya venía acotado por
  // sede (`whereSedePorSuscriptor`), y emitir el mes / anular / e-factura siguen
  // gateados por `AREA_CONTABILIDAD` dentro de la propia pantalla. Notas de crédito
  // y débito siguen fuera de su menú.
  { href: '/facturacion', label: 'Administrar facturas', module: 'Facturación', areas: ['contabilidad', 'caja'] },
  { href: '/facturacion/notas', label: 'Notas crédito/débito', module: 'Facturación', areas: ['contabilidad'] },
  { href: '/facturacion/electronica', label: 'Facturas electrónicas', module: 'Facturación', areas: ['contabilidad'] },
  { href: '/cotizaciones', label: 'Cotizaciones', module: 'Facturación', areas: ['contabilidad'] },

  // "Movimientos" es la vista TRANSVERSAL de tesorería (todas las cajas, todos los
  // tipos, con anular y filtro por caja). La cajera trabaja por sus pantallas
  // concretas —Ingresos, Egresos, Nueva transacción, Transferencia— y su arqueo,
  // así que se le quitó (decisión 2026-07-29).
  { href: '/tesoreria', label: 'Movimientos de caja', module: 'Caja / Cobranza', areas: ['contabilidad'] },
  // '/tesoreria/apertura' se retiró (2026-07-29): abrir la caja es un botón del panel
  // de la cajera, no una pantalla. Su llave `screen.tesoreria.apertura` se borra con
  // prisma/migrate-apertura-boton-2026-07.ts.
  { href: '/tesoreria/cierres', label: 'Cierre de caja', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  // Faltaban en el catálogo pese a llevar tiempo en el menú (nav.ts): sin llave de
  // pantalla, `can()` sólo se las concedía al superusuario, así que la cajera —que
  // es quien las usa todo el día— no las veía. Van con la misma pareja de áreas que
  // el resto de la operación de caja; el DATO sigue acotado a su sede por
  // `caja-scope.ts` (ve/mueve su caja y los bancos, nada de otra sede).
  { href: '/tesoreria/ingresos', label: 'Ingresos', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  { href: '/tesoreria/egresos', label: 'Egresos', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  { href: '/tesoreria/nueva', label: 'Nueva transacción', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  // Pagos fijos programados (2026-07-31): contabilidad los define, la cajera de la
  // caja registra la ejecución (el dato va acotado por caja en el backend).
  { href: '/tesoreria/pagos-fijos', label: 'Pagos fijos programados', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  { href: '/tesoreria/transferencia', label: 'Transferencia entre cajas', module: 'Caja / Cobranza', areas: ['contabilidad', 'caja'] },
  // Anulaciones y Cajas/categorías NO son de la cajera: la primera es el control de
  // quién anuló qué (se mira desde fuera), y la segunda fija el fondo de cada caja.
  { href: '/tesoreria/anulaciones', label: 'Anulaciones (control)', module: 'Caja / Cobranza', areas: ['contabilidad'] },
  { href: '/tesoreria/cajas', label: 'Cajas y categorías', module: 'Caja / Cobranza', areas: ['contabilidad', 'administracion'] },
  // Importar pagos (Efecty) es un cargue masivo de corresponsal: aplica cientos de
  // pagos de golpe y dispara reconexiones. Queda en administración (2026-07-29).
  { href: '/tesoreria/importar-pagos', label: 'Importar pagos (Efecty)', module: 'Caja / Cobranza', areas: ['administracion'] },
  // Pagos en línea: lo que entra por el portal del abonado (vestel.com.co/crm). Es
  // consulta —el pago lo procesa el portal, aquí no se aplica un peso—, así que la
  // ve quien ve el dinero. Forzar la pasada, que sí sale a tocar equipos, va con
  // área administración en la propia ruta (ver OnlinePaymentsController).
  { href: '/tesoreria/pagos-en-linea', label: 'Pagos en línea (portal)', module: 'Caja / Cobranza', areas: ['contabilidad', 'administracion', 'gerencia'] },

  { href: '/contabilidad', label: 'Resumen contable', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/plan-de-cuentas', label: 'Plan de cuentas', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/libros', label: 'Libro diario y mayor', module: 'Contabilidad', areas: ['contabilidad'] },
  { href: '/contabilidad/informes', label: 'Balance y estados financieros', module: 'Contabilidad', areas: ['contabilidad'] },
  // Cierre de mes: el arrastre de saldos al mes siguiente. Cerrar bloquea los asientos
  // de esas fechas, así que es de contabilidad y administración, no de caja.
  { href: '/contabilidad/cierres', label: 'Cierre de mes (arrastre de saldos)', module: 'Contabilidad', areas: ['contabilidad', 'administracion'] },
  { href: '/contabilidad/mapeo-cuentas', label: 'Mapeo de cuentas', module: 'Contabilidad', areas: ['contabilidad'] },
  // Contabilidad de gestión por sede (docs/centros-de-costo/PLAN.md, 2026-09-24): el informe
  // es para quien dirige (gerencia) además de contabilidad y administración; los centros los
  // ven los tres pero sólo contabilidad y administración los crean o editan (lo decide la API).
  { href: '/contabilidad/resultados-por-sede', label: 'Resultados por sede', module: 'Contabilidad', areas: ['contabilidad', 'administracion', 'gerencia'] },
  { href: '/contabilidad/centros-de-costo', label: 'Centros de costo', module: 'Contabilidad', areas: ['contabilidad', 'administracion', 'gerencia'] },

  { href: '/clientes', label: 'Clientes', module: 'Clientes', areas: ['administracion', 'caja'] },
  // PlayHub (2026-09-04): la cajera lo vende y lo cancela en ventanilla, así que la
  // pestaña de la ficha y este reporte son suyos. El reporte va acotado a SU sede
  // (`ExtrasService.playhub`) y las operaciones por cliente pasan por
  // `exigirSedeSuscriptor`. La barrida masiva sigue sin ser de caja.
  { href: '/playhub', label: 'PlayHub / IPTV', module: 'Clientes', areas: ['administracion', 'caja'] },
  // Las cuatro siguientes estaban EN EL MENÚ pero no en este catálogo, que es la
  // misma trampa que ya se documentó abajo con /red/naps: sin llave de pantalla
  // `can(screenKey(href))` sólo la da por buena a `system.admin`, así que la entrada
  // quedaba invisible para TODO el mundo menos el superusuario — nadie la echaba de
  // menos porque quien probaba era superusuario. Las áreas que se les ponen son las
  // que el gate de la URL (`frontend/src/middleware.ts`) ya dejaba pasar; esto no
  // abre nada nuevo, sólo deja de esconder lo que ya era suyo. (2026-09-19)
  { href: '/clientes/grupos', label: 'Grupos de clientes', module: 'Clientes', areas: ['administracion', 'caja'] },
  // El mapa: abonados, cajas NAP y —para quien la tiene— la capa de técnicos, que se
  // filtra aparte dentro de la página y en el backend.
  { href: '/mapa', label: 'Mapa (abonados, NAPs y técnicos)', module: 'Clientes', areas: ['gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'] },

  // Sin 'tecnicos' desde el 2026-09-10, a pedido del usuario («quitemos este módulo
  // completo para los técnicos… es más, todo el módulo de clientes»). Era la ÚNICA
  // pantalla que el técnico tenía en CLIENTES / CRM, así que al retirarla desaparece
  // la sección entera de su menú — que es lo que se pidió.
  //
  // Lo que NO se le quita, porque es con lo que trabaja: la FICHA de su orden
  // (`/soporte/:id`) y la del cliente (`/clientes/:id`, de consulta, a pedido del
  // usuario el 2026-08-31). Ninguna de las dos es hoja del menú, así que
  // `PantallaGate` no las toca y el área las sigue dejando pasar; lo que se cierra es
  // el LISTADO de las 139.000 órdenes, que nunca fue suyo. Su lista de trabajo es su
  // agenda del día. El permiso concedido en base lo retira
  // `prisma/migrate-tecnico-sin-soporte-2026-09.ts`.
  { href: '/soporte', label: 'Tickets / Órdenes de trabajo', module: 'Soporte', areas: ['caja'] },
  // Agendamiento (2026-07-31): la cajera reparte el día entre los técnicos y fija el
  // orden de las visitas. NO es del técnico — él sigue la agenda, no la arma —, y el
  // servicio se lo vuelve a negar por API (`AgendaService.mover`).
  { href: '/soporte/agenda', label: 'Agendamiento de órdenes', module: 'Soporte', areas: ['caja', 'administracion'] },
  // Auditoría de los cierres contra la geo-cerca (quién cerró desde dónde y qué se
  // marcó como sospechoso). Es control sobre el trabajo del técnico, así que NO es
  // suya: administración y gerencia, que son quienes responden por él.
  { href: '/soporte/geocerca', label: 'Geo-cerca de cierres (auditoría)', module: 'Soporte', areas: ['administracion', 'gerencia'] },
  // La otra cara de lo mismo: lo que el técnico VE de la agenda que le armaron.
  // Pantalla propia y no un bloque dentro de /soporte, para que sea su landing.
  { href: '/mi-agenda', label: 'Mi agenda (técnico)', module: 'Soporte', areas: ['tecnicos'] },

  // RED / ISP y MIKROTIK salieron del perfil del técnico (2026-07-31, decisión del
  // usuario): ni en el sidebar ni por URL. Pasan a administración, que es donde ya
  // viven los equipos y las transferencias, y donde están las personas que de verdad
  // operan la OLT y los routers (todas tienen esa área además de la técnica).
  // El bloqueo por API lo hace `network/modulo-red.guard.ts`: quitar la llave de
  // pantalla no cierra `/api/network/*`, que está abierto por ÁREA y el técnico
  // sigue siendo del área técnica por su soporte y su inventario.
  { href: '/red/conexiones', label: 'Conexiones', module: 'Red / ISP', areas: ['administracion'] },
  // Transferencias de equipos: también de la cajera (2026-07-30). La pantalla ya
  // estaba pensada para ella —`can('area.caja')` habilita RECIBIR en la sede
  // destino— pero sin la llave de pantalla no la veía en el menú. Puede solicitar
  // y recibir; aprobar/despachar sigue siendo del jefe de bodega (inventory.admin).
  // El técnico salió de estas tres (2026-07-31, decisión del usuario): en INVENTARIO
  // sólo ve lo suyo —sus equipos y su bodega de material—, y administrar el parque,
  // dar de alta equipo y armar transferencias es de bodega/administración. La ruta
  // sigue siendo del área técnica porque el jefe de bodega y la cajera trabajan ahí.
  // Pasan a administración para no dejarlas huérfanas (sólo las tenía el área
  // técnica): son el inventario de equipos de la empresa, que es justo la sección
  // INVENTARIO. El jefe de bodega ya las alcanza por `@OrPermission(inventory.admin)`.
  { href: '/red/transferencias', label: 'Transferencias', module: 'Red / ISP', areas: ['administracion', 'caja'] },
  { href: '/red/equipos', label: 'Administrar equipos', module: 'Red / ISP', areas: ['administracion', 'caja'] },
  { href: '/red/equipos/nuevo', label: 'Ingreso de equipo', module: 'Red / ISP', areas: ['administracion', 'caja'] },
  // "Bodega de equipos" SÍ se le deja, pero al técnico le muestra únicamente los
  // equipos que están a su nombre (ver `NetworkWriteService.equipmentWarehouses`).
  { href: '/red/bodegas', label: 'Bodega de equipos', module: 'Red / ISP', areas: ['tecnicos', 'administracion', 'caja'] },
  // Equipos disponibles (2026-09-14): una pantalla por sede, vacías por ahora. De
  // administración y de la cajera; el jefe de bodega las recibe en su rol. El técnico
  // no: él ve sólo lo suyo. Una llave por sede para poder repartirlas por empleado.
  ...SEDES_DISPONIBLES.map((s): ScreenDef => ({
    href: `/red/disponibles/${s.slug}`, label: `Equipos disponibles · ${s.label}`, module: 'Red / ISP', areas: ['administracion', 'caja'],
  })),
  { href: '/red', label: 'Red / ISP (resumen)', module: 'Red / ISP', areas: ['administracion'] },
  { href: '/red/onus', label: 'ONUs', module: 'Red / ISP', areas: ['administracion'] },
  // Faltaban en el catálogo pese a estar en el nav: sin llave de pantalla, `can()`
  // solo las concedía a system.admin, así que un técnico no las veía en el menú.
  { href: '/red/naps', label: 'Cajas NAP', module: 'Red / ISP', areas: ['administracion'] },
  // VLANs: volvió a pasar lo mismo que con las NAPs. La pantalla existe desde el
  // 2026-08-27 y el CRUD del backend desde antes, pero sin llave nadie veía el enlace.
  { href: '/red/vlans', label: 'VLANs', module: 'Red / ISP', areas: ['administracion'] },
  { href: '/red/olt', label: 'Gestión OLT', module: 'Red / ISP', areas: ['administracion'] },
  { href: '/red/genieacs', label: 'GenieACS · TR-069', module: 'Red / ISP', areas: ['administracion'] },

  // MIKROTIK — módulo propio (2026-07-15). `/mikrotik/masivo` es el antiguo
  // `/red/masivo`: su llave se renombra en BD conservando las concesiones.
  { href: '/mikrotik', label: 'Gestión de routers', module: 'Mikrotik', areas: ['administracion'] },
  { href: '/mikrotik/masivo', label: 'Operaciones masivas', module: 'Mikrotik', areas: ['administracion'] },
  { href: '/mikrotik/ips', label: 'IPs de usuarios', module: 'Mikrotik', areas: ['administracion'] },

  { href: '/inventario', label: 'Material', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  // (2026-09-17: la cajera ya tiene el inventario COMPLETO — ver el rol `area-caja`.
  // Lo de abajo es la historia de por qué empezó con sólo los traspasos.)
  // Lo ÚNICO que la cajera hace en inventario (decisión 2026-07-29): entregarle
  // material a un técnico. Un traspaso al "Almacén <técnico>" ES esa entrega —cada
  // técnico tiene su bodega (`MaterialWarehouse.technicianRef`)— y el acta queda
  // firmada cuando él la recibe. No ve el catálogo de material, ni bodegas, ni
  // categorías: sólo mueve lo que ya existe.
  // Y el TÉCNICO desde 2026-09-03: la misma pantalla le sirve para DEVOLVER a la
  // bodega principal de su sede el material que le sobró, que hasta ahora se le
  // quedaba en el almacén porque sólo la cajera podía emitir traspasos.
  { href: '/inventario/traspasos', label: 'Traspasos', module: 'Inventario / Compras', areas: ['administracion', 'caja', 'tecnicos'] },
  // "Bodegas de material" faltaba en el catálogo pese a llevar tiempo en el menú: sin
  // llave de pantalla sólo la veía el superusuario. Se le da al técnico porque es SU
  // bodega la que abre —el backend le devuelve una sola, la suya
  // (`InventoryService.warehouses`)— y a administración, que es la dueña del módulo.
  // Categorías de material, Órdenes de servicio y Categorías de compra llevaban
  // tiempo en el menú SIN llave de pantalla (sólo las veía el superusuario). Nacen
  // el 2026-09-17 al abrirle el inventario completo a la cajera.
  { href: '/inventario/categorias', label: 'Categorías de material', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/inventario/bodegas', label: 'Bodegas de material', module: 'Inventario / Compras', areas: ['administracion', 'tecnicos', 'caja'] },
  // "Actas" NO estaba en el catálogo pese a llevar tiempo en el menú: sin llave de
  // pantalla sólo la veía el superusuario, y el técnico —que es justo quien tiene
  // que FIRMAR el recibido— no tenía por dónde entrar. Las tres áreas son las
  // mismas que ya acepta la API (`InventoryController.TRASPASOS`): administración
  // lleva el módulo, la cajera emite la entrega y el técnico firma que la recibió.
  // Cada quien ve lo suyo: al técnico el backend le devuelve sólo las actas de su
  // almacén (`InventoryService.actas`).
  { href: '/inventario/actas', label: 'Actas de traspaso', module: 'Inventario / Compras', areas: ['administracion', 'tecnicos', 'caja'] },
  // COMPRAS fuera del perfil de caja (2026-07-29): quien recauda no ordena compras.
  // Matiz de 2026-09-08 (a pedido del usuario): la cajera SÍ ve las órdenes, porque es
  // quien tiene el papel en la mano —la factura del proveedor, el comprobante del pago—
  // y hasta ahora tenía que pasárselo a otro para que lo subiera. Sigue sin ORDENAR
  // compras: la API le abre sólo leer, el PDF y los adjuntos (`caja` en las rutas de
  // lectura y en `POST /:id/files`); crear, editar, aprobar, pagar, recibir, notas y
  // borrar siguen siendo de administración. Los catálogos (categorías, proveedores)
  // tampoco son suyos.
  { href: '/ordenes', label: 'Órdenes de compra', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/ordenes/historial', label: 'Historial de órdenes', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/ordenes/servicios', label: 'Órdenes de servicio', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/ordenes/categorias', label: 'Categorías de compra', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/proveedores', label: 'Proveedores', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },
  { href: '/devoluciones', label: 'Devoluciones', module: 'Inventario / Compras', areas: ['administracion', 'caja'] },

  // Empleados se mudó a CONFIGURACIÓN y Documentos bajó aquí (2026-08-05): las dos
  // pantallas se movieron de ruta junto con su sección, así que sus llaves cambiaron
  // (`screen.empleados` → `screen.configuracion.empleados`, `screen.configuracion.documentos`
  // → `screen.documentos`). El rename en base lo hace
  // `prisma/migrate-empleados-documentos-2026-08.ts`, que conserva las concesiones.
  // Cada una conserva su área original además de ganar la de su nueva sección:
  // cambiar de sitio una pantalla no es quitársela a quien la usa.
  { href: '/documentos', label: 'Documentos', module: 'Personas y Proyectos', areas: ['administracion', 'sistemas'] },
  { href: '/proyectos', label: 'Proyectos', module: 'Personas y Proyectos', areas: ['administracion'] },
  // Afiliados (2026-09-23): cada funcionario con los clientes que trajo.
  { href: '/afiliados', label: 'Afiliados por funcionario', module: 'Personas y Proyectos', areas: ['administracion', 'gerencia'] },
  { href: '/agenda', label: 'Agenda / Tareas', module: 'Personas y Proyectos', areas: ['administracion', 'caja'] },
  // Sin 'tecnicos' desde el 2026-09-10, a pedido del usuario («eliminar el módulo
  // Panel de Tareas: las actividades de los técnicos se gestionan mediante el
  // agendamiento diario»). El módulo se conserva para administración, gerencia y
  // caja, que lo usan para lo suyo; lo que se retira es del perfil del técnico —la
  // pantalla, el permiso (`migrate-tecnico-agenda-diaria-2026-09.ts`) y las 15 rutas
  // de la API (`tasks.router.ts`)—. Su lista de trabajo es su agenda del día.
  { href: '/tareas', label: 'Tareas / Pendientes', module: 'Personas y Proyectos', areas: ['administracion', 'gerencia', 'caja'] },

  // WHATSAPP — bandeja de atención (módulo propio, 2026-07-29). La configuración del
  // canal (plantillas, masivos, API, bot) se queda en Sistemas: son dos oficios
  // distintos y no tienen por qué ir juntos.
  { href: '/whatsapp', label: 'Bandeja de WhatsApp (chats)', module: 'WhatsApp', areas: ['administracion', 'caja', 'sistemas'] },
  // Campañas por plantilla (2026-09-14). Salió de Configuración porque se usa cada
  // mes, no se configura una vez. La API sigue pidiendo `system.whatsapp`.
  { href: '/whatsapp/masivo', label: 'Mensajes masivos (campañas)', module: 'WhatsApp', areas: ['sistemas'] },

  { href: '/configuracion', label: 'Configuración', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/planes', label: 'Planes de servicio', module: 'Sistemas', areas: ['sistemas'] },
  // Cuatro más que estaban en el menú sin llave (ver la nota de /clientes/grupos).
  // Todas cuelgan de /configuracion, cuyo gate de URL es sólo 'sistemas': ponerles
  // otra área las dejaría visibles en el menú y rebotadas al abrirlas.
  { href: '/configuracion/categorias', label: 'Categorías de transacción', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/contratos', label: 'Cláusulas de permanencia', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/promociones', label: 'Promociones', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/whatsapp/plantillas', label: 'Plantillas de WhatsApp', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/api', label: 'API pública', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/usuarios', label: 'Usuarios y roles', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/empleados', label: 'Empleados', module: 'Sistemas', areas: ['sistemas', 'administracion'] },
  { href: '/configuracion/responsables', label: 'Encargados por cargo', module: 'Sistemas', areas: ['sistemas'] },
  // Cuánto vale cada tipo de orden. Vive con los catálogos pero la decide GERENCIA:
  // es política de personal (con qué se mide al técnico), no un ajuste técnico.
  { href: '/configuracion/puntajes', label: 'Puntaje de órdenes', module: 'Sistemas', areas: ['sistemas', 'gerencia'] },
  { href: '/configuracion/whatsapp', label: 'Mensajería / WhatsApp', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/chatbot', label: 'Agente de WhatsApp (bot)', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/automatizaciones', label: 'Automatizaciones', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/actividad', label: 'Bitácora / Auditoría', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/datos', label: 'Importar / Exportar', module: 'Sistemas', areas: ['sistemas'] },
  { href: '/configuracion/mensajes', label: 'Mensajería', module: 'Sistemas', areas: ['sistemas'] },
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
export const ROLE_AREAS = ['Áreas Vestel', 'Administración', 'Inventario', 'Recursos Humanos', 'Contabilidad'] as const;
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
    // Todo el catálogo MENOS los permisos nominales (ver PERMISOS_NOMINALES).
    permissions: ALL_PERMISSIONS.map((p) => p.key).filter((k) => !PERMISOS_NOMINALES.includes(k)),
  },
  // ---- Áreas de acceso Vestel (organizan el sidebar por área) ----
  // El Superusuario es `super-admin` (system.admin ⇒ ve todas las áreas).
  {
    key: 'area-gerencia',
    name: 'Gerencia',
    description: 'Visión ejecutiva: panel de indicadores y reportes',
    area: 'Áreas Vestel',
    // Gerencia aprueba órdenes de compra (en el legacy estaba quemado a un usuario).
    permissions: [A.AREA_GERENCIA, A.DASHBOARD_VIEW, A.PURCHASES_APPROVE, ...screensForArea('gerencia')],
  },
  {
    key: 'area-administracion',
    name: 'Administración',
    description: 'Clientes, inventario, compras, empleados y proyectos',
    area: 'Áreas Vestel',
    permissions: [A.AREA_ADMINISTRACION, A.DASHBOARD_VIEW, A.HR_EMPLOYEES_READ, A.WHATSAPP_INBOX, A.SUPPORT_WRITE, ...screensForArea('administracion')],
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
      A.AREA_TECNICOS, A.SUPPORT_WRITE,
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
      A.AREA_SISTEMAS, A.USERS_MANAGE, A.WHATSAPP_MANAGE, A.WHATSAPP_INBOX, A.CRON_RUN,
      A.NETWORK_ROUTERS_MANAGE, A.NETWORK_OLT_MANAGE,
      ...screensForArea('sistemas'),
    ],
  },
  {
    // Cajera (legacy "Caja y ventas", roleid=3). Rol acotado a la operación de SU
    // caja: apertura/cierre, ingresos, egresos, nueva transacción y transferencia,
    // + clientes, tickets, agenda, la entrega de material a técnicos (traspasos) y,
    // desde 2026-08-27, emitir facturas de ventanilla (Administrar facturas).
    // NO ve las notas crédito/débito, ni la vista transversal de movimientos, ni el
    // cargue de Efecty, ni e-factura, ni config. De COMPRAS ve las órdenes (2026-09-08)
    // para subirles la factura del proveedor y el comprobante del pago, pero no las
    // crea ni las aprueba ni las paga. Su sección propia en el sidebar se gatea con
    // `area.caja`.
    // INVENTARIO COMPLETO desde 2026-09-17 (a pedido del usuario: «que las cajeras
    // puedan sí o sí ver todo el módulo de inventario, con todos sus submódulos y
    // todos los accesos»): equipos, disponibles, material, compras, devoluciones y
    // proveedores, con `inventory.admin` (aprobar/despachar transferencias y
    // mandarlas entre sedes). Lo que ve de equipos y traspasos sigue acotado a sus
    // sedes (`bodega-scope.ts`, `InventoryService.transferContext`). Aprobar una
    // orden de compra NO va incluido: es la firma nominal `purchases.approve`.
    key: 'area-caja',
    name: 'Caja y ventas',
    description: 'Cajera: apertura/cierre de su caja, ingresos, egresos, transferencias, entrega de material a técnicos, transferencias de equipos, clientes y tickets',
    area: 'Áreas Vestel',
    permissions: [A.AREA_CAJA, A.ACCOUNTING_VIEW, A.WHATSAPP_INBOX, A.SUPPORT_WRITE, P.ADMIN, ...screensForArea('caja')],
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
    permissions: [
      A.DASHBOARD_VIEW, ...r.permissions,
      // El Jefe de bodega es, desde 2026-07-30, el ÚNICO que puede mandar equipo de
      // una sede a otra: sin esta pantalla no podría armar esa transferencia. (Su
      // 403 histórico en las rutas gateadas por área lo resuelve `@OrPermission`.)
      ...(r.key === 'warehouse-manager' ? [screenKey('/red/transferencias'), ...SEDES_DISPONIBLES.map((s) => screenKey(`/red/disponibles/${s.slug}`))] : []),
    ],
  })),
  // ---- Recursos Humanos / Nómina ----
  {
    key: 'hr-director',
    name: 'Director de Recursos Humanos',
    description: 'Gestiona empleados, sus documentos y su acceso al sistema (crea logins y asigna roles)',
    area: 'Recursos Humanos',
    permissions: [A.DASHBOARD_VIEW, A.HR_EMPLOYEES_READ, A.HR_EMPLOYEES_WRITE, A.HR_ACCESS_MANAGE],
  },
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
];

/** Lookup rápido key → área (para anexar el grupo a los roles de la BD). */
export const ROLE_AREA_BY_KEY: Record<string, RoleArea> = Object.fromEntries(
  ALL_ROLES.map((r) => [r.key, r.area]),
) as Record<string, RoleArea>;
