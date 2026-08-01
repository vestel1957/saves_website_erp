import { Prisma } from '@prisma/client';
import { CARGO_OTRO, ETIQUETAS_CARGO, cargoSqlCase } from '../staff/cargos-legacy';

/**
 * El catálogo de datos: qué se puede preguntar de la empresa y cómo se traduce.
 *
 * POR QUÉ EXISTE. Se venía cubriendo cada pregunta con su propia herramienta de
 * chatbot, y eso topó: un superusuario ya ve 69 herramientas y sus definiciones
 * pesan ~7.700 tokens EN CADA llamada al modelo (con el tope diario de 500.000 eso
 * son ~32 conversaciones). Además el modelo empieza a equivocarse de herramienta
 * cuando hay tantas parecidas — ya pasó dos veces. Añadir cincuenta más empeora las
 * dos cosas a la vez.
 *
 * La salida no es más herramientas: es UNA que sepa consultar. El modelo elige
 * entidad, filtros, agrupación y métrica; este catálogo dice qué existe; y el
 * servicio arma la consulta. El modelo NUNCA escribe SQL.
 *
 * POR QUÉ ES SEGURO. Todo fragmento de SQL sale de este archivo — nombres de tabla,
 * columnas y joins son literales escritos aquí. Del modelo solo llegan CLAVES (que
 * se buscan en estos diccionarios y si no existen se rechazan) y VALORES (que van
 * siempre parametrizados). No hay forma de que una cadena del modelo acabe siendo
 * SQL.
 *
 * PARA AMPLIARLO: se añade una entrada aquí. Ni migración, ni herramienta nueva, ni
 * un token más en el prompt — el modelo descubre lo nuevo preguntando al catálogo.
 */

/** Un campo por el que se puede filtrar. `sql` es el fragmento; el valor va aparte. */
export type CampoFiltro = {
  sql: Prisma.Sql;
  tipo: 'texto' | 'numero' | 'fecha' | 'enum' | 'bool';
  /** Valores admitidos, si es un enum cerrado. Se le muestran al modelo. */
  valores?: string[];
  descripcion: string;
};

/** Una dimensión por la que se puede agrupar. */
export type CampoGrupo = { sql: Prisma.Sql; descripcion: string };

/** Una cifra que se puede calcular. */
export type Metrica = { sql: Prisma.Sql; descripcion: string; dinero?: boolean };

export type Entidad = {
  etiqueta: string;
  descripcion: string;
  /** Áreas que dan acceso (OR, igual que el AreaGuard). Vacío = cualquier interno. */
  areas: string[];
  /** FROM + JOINs. Fijo, escrito aquí. */
  from: Prisma.Sql;
  /** Condiciones que SIEMPRE se aplican (p. ej. excluir anulados). */
  base?: Prisma.Sql;
  filtros: Record<string, CampoFiltro>;
  grupos: Record<string, CampoGrupo>;
  metricas: Record<string, Metrica>;
};

const A = {
  ADMIN: 'area.administracion', GERENCIA: 'area.gerencia', CONTA: 'area.contabilidad',
  CAJA: 'area.caja', TECNICOS: 'area.tecnicos',
};

/**
 * El técnico de una orden, con NOMBRE COMPLETO.
 *
 * `Ticket.assigned` guarda el nombre de usuario con que el legacy firmaba las
 * órdenes ('OmarTec'), y el sistema ya no muestra nombres de usuario. Se traduce
 * con una subconsulta y no con un JOIN a propósito: dos fichas podrían compartir
 * username y un JOIN duplicaría filas, es decir, inflaría los conteos.
 */
const NOMBRE_TECNICO_SQL =
  `COALESCE((SELECT f.name FROM "Staff" f WHERE lower(btrim(f.username)) = lower(btrim(k.assigned)) LIMIT 1), k.assigned)`;
const NOMBRE_TECNICO = Prisma.raw(NOMBRE_TECNICO_SQL);

/** Agrupación por mes: se repite en casi todas las entidades con fecha. */
const mes = (col: string): CampoGrupo => ({
  sql: Prisma.raw(`to_char(date_trunc('month', ${col}), 'YYYY-MM')`),
  descripcion: 'Mes (YYYY-MM)',
});

export const CATALOGO: Record<string, Entidad> = {
  abonados: {
    etiqueta: 'Abonados / clientes',
    descripcion: 'La base de clientes: cuántos hay, en qué estado, de qué sede y con qué plan. ' +
      'OJO: se une con los servicios contratados, así que "cantidad" cuenta SERVICIOS; ' +
      'para contar personas usa la cifra "abonados_distintos".',
    areas: [A.ADMIN, A.GERENCIA, A.CONTA, A.CAJA, A.TECNICOS],
    // El plan NO está en Subscriber: vive en `SubscriberService` (un abonado puede
    // tener internet y televisión). Se une por ahí, y por eso una consulta agrupada
    // por plan cuenta SERVICIOS, no personas — se avisa en la descripción.
    from: Prisma.raw('"Subscriber" s LEFT JOIN "Branch" b ON b.id = s."branchId" LEFT JOIN "SubscriberService" sv ON sv."subscriberId" = s.id'),
    filtros: {
      estado: { sql: Prisma.raw('s.status::text'), tipo: 'enum', descripcion: 'Estado del abonado',
        valores: ['ACTIVO', 'CORTADO', 'CARTERA', 'RETIRADO', 'DEPURADO', 'SUSPENDIDO', 'COMPROMISO', 'REPORTADO', 'EXONERADO', 'INSTALAR'] },
      sede: { sql: Prisma.raw('b.name'), tipo: 'texto', descripcion: 'Nombre de la sede' },
      plan: { sql: Prisma.raw('sv."planName"'), tipo: 'texto', descripcion: 'Nombre del plan contratado (une con los servicios del abonado)' },
      servicio: { sql: Prisma.raw('sv.kind::text'), tipo: 'texto', descripcion: 'INTERNET / TELEVISION' },
      fecha_ingreso: { sql: Prisma.raw('s."entryDate"'), tipo: 'fecha', descripcion: 'Fecha de alta del abonado' },
      direccion: { sql: Prisma.raw('s."addressLine"'), tipo: 'texto', descripcion: 'Dirección (texto libre)' },
    },
    grupos: {
      estado: { sql: Prisma.raw('s.status::text'), descripcion: 'Estado' },
      sede: { sql: Prisma.raw("COALESCE(b.name, 'Sin sede')"), descripcion: 'Sede' },
      plan: { sql: Prisma.raw("COALESCE(NULLIF(sv.\"planName\", ''), 'Sin plan')"), descripcion: 'Plan (cuenta SERVICIOS, no personas)' },
      servicio: { sql: Prisma.raw("COALESCE(sv.kind::text, 'Sin servicio')"), descripcion: 'Tipo de servicio' },
      mes_ingreso: mes('s."entryDate"'),
    },
    metricas: {
      cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántos abonados' },
      abonados_distintos: { sql: Prisma.raw('COUNT(DISTINCT s.id)'), descripcion: 'Personas distintas (no servicios)' },
      precio_promedio: { sql: Prisma.raw('AVG(sv.price)'), descripcion: 'Precio medio del plan', dinero: true },
      precio_total: { sql: Prisma.raw('SUM(sv.price)'), descripcion: 'Suma de las mensualidades', dinero: true },
    },
  },

  facturas: {
    etiqueta: 'Facturas de venta',
    descripcion: 'Lo facturado a clientes: montos, estado de pago y saldo.',
    areas: [A.ADMIN, A.GERENCIA, A.CONTA, A.CAJA],
    from: Prisma.raw('"SubInvoice" i LEFT JOIN "Subscriber" s ON s.id = i."subscriberId" LEFT JOIN "Branch" b ON b.id = s."branchId"'),
    base: Prisma.raw("i.status <> 'CANCELED'"),
    filtros: {
      estado: { sql: Prisma.raw('i.status::text'), tipo: 'enum', descripcion: 'Estado de la factura',
        valores: ['DUE', 'PAID', 'PARTIAL'] },
      fecha: { sql: Prisma.raw('i."invoiceDate"'), tipo: 'fecha', descripcion: 'Fecha de emisión' },
      vencimiento: { sql: Prisma.raw('i."dueDate"'), tipo: 'fecha', descripcion: 'Fecha de vencimiento' },
      sede: { sql: Prisma.raw('b.name'), tipo: 'texto', descripcion: 'Sede del cliente' },
    },
    grupos: {
      estado: { sql: Prisma.raw('i.status::text'), descripcion: 'Estado' },
      sede: { sql: Prisma.raw("COALESCE(b.name, 'Sin sede')"), descripcion: 'Sede' },
      mes: mes('i."invoiceDate"'),
    },
    metricas: {
      cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántas facturas' },
      total: { sql: Prisma.raw('SUM(i.total)'), descripcion: 'Monto facturado', dinero: true },
      pagado: { sql: Prisma.raw('SUM(i."paidAmount")'), descripcion: 'Monto pagado', dinero: true },
      saldo: { sql: Prisma.raw('SUM(i.total - i."paidAmount")'), descripcion: 'Saldo pendiente', dinero: true },
      promedio: { sql: Prisma.raw('AVG(i.total)'), descripcion: 'Factura media', dinero: true },
    },
  },

  movimientos: {
    etiqueta: 'Movimientos de caja',
    descripcion: 'Ingresos y egresos de tesorería: cuánto entró o salió, por caja y método.',
    areas: [A.ADMIN, A.GERENCIA, A.CONTA, A.CAJA],
    from: Prisma.raw('"Transaction" t LEFT JOIN "Subscriber" s ON s.id = t."subscriberId" LEFT JOIN "Branch" b ON b.id = s."branchId"'),
    filtros: {
      tipo: { sql: Prisma.raw('t.type::text'), tipo: 'enum', descripcion: 'Ingreso o egreso', valores: ['INCOME', 'EXPENSE'] },
      estado: { sql: Prisma.raw('t.status::text'), tipo: 'enum', descripcion: 'Vigente o anulado', valores: ['VIGENTE', 'ANULADO'] },
      fecha: { sql: Prisma.raw('t.date'), tipo: 'fecha', descripcion: 'Fecha del movimiento' },
      metodo: { sql: Prisma.raw('t.method'), tipo: 'texto', descripcion: 'Método de pago' },
      caja: { sql: Prisma.raw('t."accountName"'), tipo: 'texto', descripcion: 'Nombre de la caja' },
      categoria: { sql: Prisma.raw('t.category'), tipo: 'texto', descripcion: 'Categoría' },
      sede: { sql: Prisma.raw('b.name'), tipo: 'texto', descripcion: 'Sede del cliente asociado' },
    },
    grupos: {
      tipo: { sql: Prisma.raw('t.type::text'), descripcion: 'Ingreso/egreso' },
      metodo: { sql: Prisma.raw("COALESCE(t.method, 'Sin método')"), descripcion: 'Método de pago' },
      caja: { sql: Prisma.raw("COALESCE(t.\"accountName\", 'Sin caja')"), descripcion: 'Caja' },
      categoria: { sql: Prisma.raw("COALESCE(t.category, 'Sin categoría')"), descripcion: 'Categoría' },
      sede: { sql: Prisma.raw("COALESCE(b.name, 'Sin sede')"), descripcion: 'Sede' },
      mes: mes('t.date'),
    },
    metricas: {
      cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántos movimientos' },
      ingresos: { sql: Prisma.raw('SUM(t.credit)'), descripcion: 'Suma de ingresos', dinero: true },
      egresos: { sql: Prisma.raw('SUM(t.debit)'), descripcion: 'Suma de egresos', dinero: true },
      neto: { sql: Prisma.raw('SUM(t.credit - t.debit)'), descripcion: 'Ingresos menos egresos', dinero: true },
    },
  },

  ordenes: {
    etiqueta: 'Órdenes de servicio',
    descripcion: 'Órdenes de soporte técnico: cuántas, de qué tipo, en qué estado y de quién.',
    areas: [A.ADMIN, A.GERENCIA, A.TECNICOS],
    from: Prisma.raw('"Ticket" k LEFT JOIN "Subscriber" s ON s.id = k."subscriberId" LEFT JOIN "Branch" b ON b.id = s."branchId"'),
    filtros: {
      tipo: { sql: Prisma.raw('k.type'), tipo: 'texto', descripcion: 'Tipo de orden (Instalacion, Corte Internet…)' },
      estado: { sql: Prisma.raw('k.status::text'), tipo: 'enum', descripcion: 'Estado',
        valores: ['PENDIENTE', 'REALIZANDO', 'RESUELTO', 'ANULADA'] },
      prioridad: { sql: Prisma.raw('k.priority'), tipo: 'texto', descripcion: 'Prioridad' },
      fecha: { sql: Prisma.raw('k.created'), tipo: 'fecha', descripcion: 'Fecha de creación' },
      tecnico: { sql: NOMBRE_TECNICO, tipo: 'texto', descripcion: 'Técnico asignado' },
      sede: { sql: Prisma.raw('b.name'), tipo: 'texto', descripcion: 'Sede del cliente' },
    },
    grupos: {
      tipo: { sql: Prisma.raw('k.type'), descripcion: 'Tipo de orden' },
      estado: { sql: Prisma.raw('k.status::text'), descripcion: 'Estado' },
      tecnico: { sql: Prisma.raw(`COALESCE(NULLIF(${NOMBRE_TECNICO_SQL}, ''), 'Sin asignar')`), descripcion: 'Técnico' },
      sede: { sql: Prisma.raw("COALESCE(b.name, 'Sin sede')"), descripcion: 'Sede' },
      prioridad: { sql: Prisma.raw("COALESCE(k.priority, 'Sin prioridad')"), descripcion: 'Prioridad' },
      mes: mes('k.created'),
    },
    metricas: { cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántas órdenes' } },
  },

  empleados: {
    etiqueta: 'Empleados',
    descripcion: 'La ficha de personal: cuántos hay, por cargo, área y si están habilitados.',
    areas: [A.ADMIN, A.GERENCIA],
    from: Prisma.raw('"Staff" e LEFT JOIN "StaffArea" a ON a.id = e."areaId"'),
    // Los inhabilitados no se consultan ni por aquí: quien pregunta "cuántos
    // empleados hay" tiene que recibir el mismo número que ve en la pantalla de
    // Empleados, no uno inflado con los que ya se fueron.
    base: Prisma.raw('NOT e.banned'),
    filtros: {
      cargo: { sql: cargoSqlCase('e.role'),
        tipo: 'enum', descripcion: 'Cargo', valores: [...ETIQUETAS_CARGO, CARGO_OTRO] },
      area: { sql: Prisma.raw('a.name'), tipo: 'texto', descripcion: 'Área' },
    },
    grupos: {
      cargo: { sql: cargoSqlCase('e.role'), descripcion: 'Cargo' },
      area: { sql: Prisma.raw("COALESCE(a.name, 'Sin área')"), descripcion: 'Área' },
    },
    metricas: { cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántos empleados' } },
  },

  materiales: {
    etiqueta: 'Materiales en bodega',
    descripcion: 'Existencias: cuánto hay de cada material, en qué bodega y cuánto vale.',
    areas: [A.ADMIN, A.GERENCIA, A.TECNICOS],
    from: Prisma.raw('"Material" m LEFT JOIN "MaterialWarehouse" w ON w.id = m."warehouseId" LEFT JOIN "MaterialCategory" c ON c.id = m."categoryId"'),
    // 310 de las 2.803 referencias traen una cantidad centinela del legacy (hasta
    // 2.147.483.647 = el máximo de un entero de 32 bits) que significa "sin control de
    // stock", no que haya dos mil millones de unidades. Sin excluirlas, "el material
    // que más vale" devolvía cifras de cuatrillones de pesos. Es el mismo recorte que
    // hace el dashboard (`WHERE qty < 100000`).
    base: Prisma.raw('m.qty < 100000'),
    filtros: {
      bodega: { sql: Prisma.raw('w.title'), tipo: 'texto', descripcion: 'Nombre de la bodega' },
      categoria: { sql: Prisma.raw('c.title'), tipo: 'texto', descripcion: 'Categoría del material' },
      nombre: { sql: Prisma.raw('m.name'), tipo: 'texto', descripcion: 'Nombre del material' },
    },
    grupos: {
      bodega: { sql: Prisma.raw("COALESCE(w.title, 'Sin bodega')"), descripcion: 'Bodega' },
      categoria: { sql: Prisma.raw("COALESCE(c.title, 'Sin categoría')"), descripcion: 'Categoría' },
      material: { sql: Prisma.raw('m.name'), descripcion: 'Material' },
    },
    metricas: {
      cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántas referencias' },
      existencias: { sql: Prisma.raw('SUM(m.qty)'), descripcion: 'Unidades en existencia' },
      valor: { sql: Prisma.raw('SUM(m.qty * m.price)'), descripcion: 'Valor del inventario', dinero: true },
    },
  },

  compras: {
    etiqueta: 'Órdenes de compra',
    descripcion: 'Compras y servicios a proveedores: cuántas, a quién y por cuánto.',
    areas: [A.ADMIN, A.GERENCIA, A.CONTA],
    from: Prisma.raw('"SupplyOrder" o LEFT JOIN "Supplier" p ON p.id = o."supplierId"'),
    filtros: {
      estado: { sql: Prisma.raw('o.status'), tipo: 'texto', descripcion: 'Estado de la orden' },
      proveedor: { sql: Prisma.raw('p.name'), tipo: 'texto', descripcion: 'Proveedor' },
      fecha: { sql: Prisma.raw('o."orderDate"'), tipo: 'fecha', descripcion: 'Fecha de la orden' },
      clase: { sql: Prisma.raw('o.kind'), tipo: 'texto', descripcion: 'compra o servicio' },
    },
    grupos: {
      estado: { sql: Prisma.raw('o.status'), descripcion: 'Estado' },
      proveedor: { sql: Prisma.raw("COALESCE(p.name, 'Sin proveedor')"), descripcion: 'Proveedor' },
      clase: { sql: Prisma.raw("COALESCE(o.kind, 'Sin clase')"), descripcion: 'Compra/servicio' },
      mes: mes('o."orderDate"'),
    },
    metricas: {
      cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántas órdenes' },
      total: { sql: Prisma.raw('SUM(o.total)'), descripcion: 'Monto comprado', dinero: true },
      pagado: { sql: Prisma.raw('SUM(o."paidAmount")'), descripcion: 'Monto pagado', dinero: true },
      saldo: { sql: Prisma.raw('SUM(o.total - o."paidAmount")'), descripcion: 'Saldo con proveedores', dinero: true },
    },
  },

  planes: {
    etiqueta: 'Planes del catálogo',
    descripcion: 'Los planes que se venden: cuáles hay, de qué tipo y a qué precio.',
    areas: [A.ADMIN, A.GERENCIA, A.CONTA, A.CAJA, A.TECNICOS],
    from: Prisma.raw('"Plan" pl'),
    filtros: {
      tipo: { sql: Prisma.raw('pl.kind::text'), tipo: 'texto', descripcion: 'INTERNET / TELEVISION…' },
      activo: { sql: Prisma.raw('pl.active'), tipo: 'bool', descripcion: 'true = se vende hoy' },
      nombre: { sql: Prisma.raw('pl.name'), tipo: 'texto', descripcion: 'Nombre del plan' },
    },
    grupos: {
      tipo: { sql: Prisma.raw('pl.kind::text'), descripcion: 'Tipo de servicio' },
      plan: { sql: Prisma.raw('pl.name'), descripcion: 'Plan' },
    },
    metricas: {
      cantidad: { sql: Prisma.raw('COUNT(*)'), descripcion: 'Cuántos planes' },
      precio_promedio: { sql: Prisma.raw('AVG(pl.price)'), descripcion: 'Precio medio', dinero: true },
    },
  },
};

export type EntidadKey = keyof typeof CATALOGO;
