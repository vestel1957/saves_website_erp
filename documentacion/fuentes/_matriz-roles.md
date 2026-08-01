# Matriz de Roles y Permisos

Este documento es la **referencia técnica** del control de acceso de SAVES: qué roles existen,
qué permisos trae cada uno y a qué pantallas llega. Se **genera del código**
(`permissions.catalog.ts` y `nav.ts`), no se escribe a mano, para que no se desactualice.

Los manuales por rol explican *cómo trabajar*. Este documento responde *quién puede qué*, y es
el que se usa para asignar accesos, para una auditoría o para revisar un incidente.

## Cómo funciona el acceso

El acceso de una persona se arma con **tres capas** que se suman:

| Capa | Qué controla | Ejemplo |
|---|---|---|
| **Área** | Qué sección del menú ve | `area.tecnicos` habilita la operación de red |
| **Pantalla** | Cada opción concreta del menú | `screen.red.olt` habilita "Gestión OLT" |
| **Acción** | Operaciones delicadas, aparte del área | `network.cut` permite cortar servicio |

Reglas que conviene tener presentes:

- **`system.admin` (Superadministrador) pasa cualquier verificación.** Es el único acceso total.
- **`inventory.admin` (Jefe de bodega) es superusuario solo del inventario**: pasa las
  verificaciones `inventory.*` y ninguna otra.
- **Cada opción del menú exige su propia llave `screen.*`**, derivada de su ruta
  (`/facturacion/notas` → `screen.facturacion.notas`). Un rol sin llaves `screen.*` deja el
  menú vacío aunque traiga permisos de acción.
- Las **acciones destructivas** se conceden **aparte del área**, a propósito: así se puede
  tener un técnico que ve la red pero no corta el servicio.
- Los permisos por **empleado** (ficha del empleado → Permisos y accesos) se suman al rol.
  Solo el Superadministrador puede otorgarlos.

## Los roles del sistema

Un rol es una **plantilla de permisos**. La columna *Pantallas* dice cuántas opciones de menú
abre por sí solo: si dice 0, el rol necesita que se le habiliten pantallas aparte para que la
persona pueda trabajar.

| Rol | Grupo | Permisos | Pantallas | Usuarios | Estado |
|---|---|---:|---:|---:|---|
| **Superadministrador** | Administración | 164 | 67 | 21 | Acceso total |
| **Gerencia** | Áreas Vestel | 20 | 17 | 1 | Operativo |
| **Administración** | Áreas Vestel | 17 | 14 | 26 | Operativo |
| **Contabilidad** | Áreas Vestel | 16 | 12 | 1 | Operativo |
| **Técnicos** | Áreas Vestel | 20 | 15 | 52 | Operativo |
| **Sistemas** | Áreas Vestel | 17 | 11 | 1 | Operativo |
| **Caja y ventas** | Áreas Vestel | 16 | 14 | 21 | Operativo |
| **Auditoría / Consulta** | Administración | 7 | 0 | 1 | Requiere habilitar pantallas |
| **Jefe de bodega** | Inventario | 3 | 0 | 1 | Requiere habilitar pantallas |
| **Director de Recursos Humanos** | Recursos Humanos | 4 | 0 | 1 | Requiere habilitar pantallas |
| **Contador** | Contabilidad | 17 | 0 | 1 | Requiere habilitar pantallas |

Los tres estados significan cosas distintas:

| Estado | Qué quiere decir | Qué hacer |
|---|---|---|
| **Operativo** | El rol abre por sí solo las pantallas de su trabajo | Asignarlo y listo |
| **Requiere habilitar pantallas** | El módulo existe, pero el rol no trae sus llaves `screen.*`: quien lo tenga entra y ve el menú vacío | Concederle las pantallas en la ficha del empleado, o sumarle un rol de área |
| **Sin operación: módulo sin pantallas** | Los permisos existen pero el módulo aún no se ha construido | Nada por ahora; el rol todavía no sirve |

> **Ojo con los roles de 0 pantallas.** Es la causa más frecuente de "no puedo entrar" o "no veo
> nada": la persona está bien autenticada y con su rol correcto, pero ningún permiso de pantalla
> le abre el menú. No es un problema de contraseña.

### Roles personalizados

No hay roles personalizados: todos los roles de la base vienen del catálogo del sistema.

## Qué pantalla ve cada área

Las seis áreas de Vestel y las pantallas que cada una trae por defecto.

| Pantalla | Ruta | Ger. | Admin. | Cont. | Tec. | Sist. | Caja |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **Gerencia** | |  |  |  |  |  |  |
| Panel (ejecutivo / de caja) | `/dashboard` | Sí | — | — | — | — | Sí |
| **Reportes** | |  |  |  |  |  |  |
| Reportes (índice) | `/reportes` | Sí | — | — | — | — | — |
| Resumen de facturación | `/reportes/facturacion` | Sí | — | — | — | — | — |
| Recaudo | `/reportes/recaudo` | Sí | — | — | — | — | — |
| Ventas por sede | `/reportes/ventas-sede` | Sí | — | — | — | — | — |
| Ingresos y egresos | `/reportes/ingresos-egresos` | Sí | — | — | — | — | — |
| Cartera / deudores | `/reportes/cartera` | Sí | — | — | — | — | — |
| Reporte de IVA | `/reportes/iva` | Sí | — | — | — | — | — |
| Órdenes de servicio | `/reportes/ordenes` | Sí | — | — | — | — | — |
| Cortes y activaciones | `/reportes/cortes-activaciones` | Sí | — | — | — | — | — |
| Estado de clientes | `/reportes/estado-clientes` | Sí | — | — | — | — | — |
| Altas y retiros | `/reportes/altas-retiros` | Sí | — | — | — | — | — |
| Rendimiento de técnicos | `/reportes/tecnicos` | Sí | — | — | — | — | — |
| Recaudo por funcionario | `/reportes/recaudo-funcionario` | Sí | — | — | — | — | — |
| Anulaciones (control) | `/reportes/anulaciones` | Sí | — | — | — | — | — |
| Actividad en el sistema | `/reportes/actividad` | Sí | — | — | — | — | — |
| **Facturación** | |  |  |  |  |  |  |
| Administrar facturas | `/facturacion` | — | — | Sí | — | — | Sí |
| Notas crédito/débito | `/facturacion/notas` | — | — | Sí | — | — | Sí |
| Facturas electrónicas | `/facturacion/electronica` | — | — | Sí | — | — | — |
| Cotizaciones | `/cotizaciones` | — | — | Sí | — | — | — |
| **Caja / Cobranza** | |  |  |  |  |  |  |
| Movimientos de caja | `/tesoreria` | — | — | Sí | — | — | Sí |
| Apertura de caja | `/tesoreria/apertura` | — | — | Sí | — | — | Sí |
| Cierre de caja | `/tesoreria/cierres` | — | — | Sí | — | — | Sí |
| Importar pagos (Efecty) | `/tesoreria/importar-pagos` | — | Sí | — | — | — | Sí |
| **Contabilidad** | |  |  |  |  |  |  |
| Resumen contable | `/contabilidad` | — | — | Sí | — | — | — |
| Plan de cuentas | `/contabilidad/plan-de-cuentas` | — | — | Sí | — | — | — |
| Libro diario y mayor | `/contabilidad/libros` | — | — | Sí | — | — | — |
| Balance y estados financieros | `/contabilidad/informes` | — | — | Sí | — | — | — |
| Mapeo de cuentas | `/contabilidad/mapeo-cuentas` | — | — | Sí | — | — | — |
| **Clientes** | |  |  |  |  |  |  |
| Clientes | `/clientes` | — | Sí | — | — | — | Sí |
| Cobranza / Acuerdos de pago | `/cobranza` | — | Sí | — | — | — | Sí |
| PlayHub / IPTV | `/playhub` | — | Sí | — | — | — | — |
| **Soporte** | |  |  |  |  |  |  |
| Tickets / Órdenes de trabajo | `/soporte` | — | — | — | Sí | — | Sí |
| **Red / ISP** | |  |  |  |  |  |  |
| Conexiones | `/red/conexiones` | — | — | — | Sí | — | — |
| Transferencias | `/red/transferencias` | — | — | — | Sí | — | — |
| Administrar equipos | `/red/equipos` | — | — | — | Sí | — | — |
| Ingreso de equipo | `/red/equipos/nuevo` | — | — | — | Sí | — | — |
| Bodega de equipos | `/red/bodegas` | — | — | — | Sí | — | — |
| Red / ISP (resumen) | `/red` | — | — | — | Sí | — | — |
| ONUs | `/red/onus` | — | — | — | Sí | — | — |
| Cajas NAP | `/red/naps` | — | — | — | Sí | — | — |
| Gestión OLT | `/red/olt` | — | — | — | Sí | — | — |
| GenieACS · TR-069 | `/red/genieacs` | — | — | — | Sí | — | — |
| **Mikrotik** | |  |  |  |  |  |  |
| Gestión de routers | `/mikrotik` | — | — | — | Sí | — | — |
| Operaciones masivas | `/mikrotik/masivo` | — | — | — | Sí | — | — |
| IPs de usuarios | `/mikrotik/ips` | — | — | — | Sí | — | — |
| **Inventario / Compras** | |  |  |  |  |  |  |
| Material | `/inventario` | — | Sí | — | — | — | — |
| Traspasos | `/inventario/traspasos` | — | Sí | — | — | — | — |
| Órdenes de compra | `/ordenes` | — | Sí | — | — | — | Sí |
| Historial de órdenes | `/ordenes/historial` | — | Sí | — | — | — | Sí |
| Proveedores | `/proveedores` | — | Sí | — | — | — | — |
| Devoluciones | `/devoluciones` | — | Sí | — | — | — | — |
| **Personas y Proyectos** | |  |  |  |  |  |  |
| Empleados | `/empleados` | — | Sí | — | — | — | — |
| Proyectos | `/proyectos` | — | Sí | — | — | — | — |
| Agenda / Tareas | `/agenda` | — | Sí | — | — | — | Sí |
| Tareas / Pendientes | `/tareas` | Sí | Sí | — | Sí | — | Sí |
| **Sistemas** | |  |  |  |  |  |  |
| Configuración | `/configuracion` | — | — | — | — | Sí | — |
| Planes de servicio | `/configuracion/planes` | — | — | — | — | Sí | — |
| API pública | `/configuracion/api` | — | — | — | — | Sí | — |
| Usuarios y roles | `/configuracion/usuarios` | — | — | — | — | Sí | — |
| Mensajería / WhatsApp | `/configuracion/whatsapp` | — | — | — | — | Sí | — |
| Agente de WhatsApp (bot) | `/configuracion/chatbot` | — | — | — | — | Sí | — |
| Automatizaciones | `/configuracion/automatizaciones` | — | — | — | — | Sí | — |
| Bitácora / Auditoría | `/configuracion/actividad` | — | — | — | — | Sí | — |
| Importar / Exportar | `/configuracion/datos` | — | — | — | — | Sí | — |
| Mensajería | `/configuracion/mensajes` | — | — | — | — | Sí | — |
| Documentos | `/configuracion/documentos` | — | — | — | — | Sí | — |

> El **Superadministrador** ve todas las pantallas por su acceso total (`system.admin`); no
> aparece como columna porque no depende de esta tabla.

## Permisos de acción y operaciones críticas

Estos permisos no habilitan pantallas: habilitan **operaciones**. La columna *Se exige* dice si
el sistema lo verifica hoy al ejecutar la operación; los que dicen "—" están declarados pero
todavía no protegen nada (el módulo correspondiente no existe o no los usa).

| Permiso | Qué habilita | Se exige | Roles que lo traen |
|---|---|:-:|---|
| `system.admin` | Superadministrador (acceso total) | Sí | Superadministrador |
| `system.users.manage` | Gestionar usuarios y roles | Sí | Superadministrador, Sistemas |
| `system.whatsapp` | Gestionar conexión de WhatsApp | Sí | Superadministrador, Sistemas |
| `network.cut` | Cortar servicio (individual y masivo) | Sí | Superadministrador, Técnicos |
| `network.reconnect` | Reconectar servicio | Sí | Superadministrador, Técnicos |
| `network.routers.manage` | Administrar routers y sesiones PPPoE | Sí | Superadministrador, Técnicos, Sistemas |
| `network.olt.manage` | Administrar ONUs de la OLT (autorizar/reiniciar/eliminar) | Sí | Superadministrador, Técnicos, Sistemas |
| `system.cron.run` | Ejecutar procesos programados a mano (facturación masiva) | Sí | Superadministrador, Contabilidad, Sistemas |
| `purchases.approve` | Aprobar órdenes de compra | Sí | Superadministrador, Gerencia |
| `inventory.admin` | Administración total de inventario | Sí | Superadministrador, Jefe de bodega |
| `inventory.assets.assign` | Asignar material a funcionarios | — | Superadministrador, Jefe de bodega |
| `hr.access.manage` | Dar acceso al sistema y asignar roles (RRHH) | — | Superadministrador, Director de Recursos Humanos |
| `hr.employees.write` | Gestionar empleados y documentos (RRHH) | Sí | Superadministrador, Director de Recursos Humanos |
| `accounting.manage` | Gestionar contabilidad | — | Superadministrador, Contador |
| `dashboard.view` | Ver panel ejecutivo | — | Superadministrador, Gerencia, Administración, Contabilidad, Auditoría / Consulta y 3 más |

**Áreas que el sistema verifica hoy del lado del servidor:** `administracion`, `caja`, `contabilidad`, `gerencia`, `sistemas`, `tecnicos`.

## Coherencia entre el menú y el catálogo

El catálogo de pantallas debe ser el espejo del menú. Cuando una opción del menú **no** está en
el catálogo, no existe la llave `screen.*` que permitiría concederla: esa opción queda visible
**solo para el Superadministrador**, y no hay forma de dársela a nadie más sin tocar el código.

**Opciones del menú sin llave en el catálogo (21):** hoy solo las ve el Superadministrador.

| Sección del menú | Opción | Ruta |
|---|---|---|
| PRINCIPAL | Mapa | `/mapa` |
| PRINCIPAL | Plantillas | `/configuracion/whatsapp/plantillas` |
| PRINCIPAL | Envío masivo | `/configuracion/whatsapp/masivo` |
| CLIENTES / CRM | Grupos de clientes | `/clientes/grupos` |
| CLIENTES / CRM | Geo-cerca de cierres | `/soporte/geocerca` |
| FACTURACIÓN | Ventas recurrentes | `/facturacion/recurrente` |
| FACTURACIÓN | Promociones | `/configuracion/promociones` |
| CAJA / TESORERÍA | Ingresos | `/tesoreria/ingresos` |
| CAJA / TESORERÍA | Egresos | `/tesoreria/egresos` |
| CAJA / TESORERÍA | Nueva transacción | `/tesoreria/nueva` |
| CAJA / TESORERÍA | Transferencia entre cajas | `/tesoreria/transferencia` |
| CAJA / TESORERÍA | Anulaciones | `/tesoreria/anulaciones` |
| CAJA / TESORERÍA | Cajas y categorías | `/tesoreria/cajas` |
| INVENTARIO | Categorías de material | `/inventario/categorias` |
| INVENTARIO | Bodegas de material | `/inventario/bodegas` |
| INVENTARIO | Actas | `/inventario/actas` |
| INVENTARIO | Órdenes de servicio | `/ordenes/servicios` |
| INVENTARIO | Categorías de compra | `/ordenes/categorias` |
| PERSONAS / PROYECTOS | Móviles / cuadrillas | `/empleados/moviles` |
| CONFIGURACIÓN | Categorías de transacción | `/configuracion/categorias` |
| DOCUMENTACIÓN | Manuales de uso | `/documentacion` |

> Esta tabla es una **lista de pendientes**, no una descripción de cómo debería ser. Cada fila
> es una pantalla que su área no puede ver: mientras la llave no exista, quien la necesita
> tiene que pedirle a un Superadministrador que haga esa operación por él.

**Llaves del catálogo que ya no están en el menú (3):** son permisos que se pueden
conceder pero no llevan a ninguna opción visible.

| Pantalla | Ruta |
|---|---|
| Ingreso de equipo | `/red/equipos/nuevo` |
| Red / ISP (resumen) | `/red` |
| ONUs | `/red/onus` |

## Anexo: detalle de cada rol

Los permisos de **acción** de cada rol, uno por uno. Las llaves `screen.*` se resumen en el
total de pantallas para no alargar la lista.

La marca *(declarado, aún sin uso)* señala un permiso que existe en el catálogo pero que
todavía no protege ninguna operación: concederlo o quitarlo hoy no cambia nada.

### Superadministrador

*Llave:* `super-admin` · *Grupo:* Administración · *Usuarios:* 21

Acceso total a toda la plataforma.

**Permisos:** todos los del sistema (acceso total por `system.admin`).

### Gerencia

*Llave:* `area-gerencia` · *Grupo:* Áreas Vestel · *Usuarios:* 1

Visión ejecutiva: panel de indicadores y reportes.

**Pantallas que abre:** 17.

**Permisos de acción:**

- `area.gerencia` — Área: Gerencia
- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `purchases.approve` — Aprobar órdenes de compra

### Administración

*Llave:* `area-administracion` · *Grupo:* Áreas Vestel · *Usuarios:* 26

Clientes, inventario, compras, empleados y proyectos.

**Pantallas que abre:** 14.

**Permisos de acción:**

- `area.administracion` — Área: Administración
- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `hr.employees.read` — Ver empleados (RRHH)

### Contabilidad

*Llave:* `area-contabilidad` · *Grupo:* Áreas Vestel · *Usuarios:* 1

Facturación, cobranza/caja y facturación electrónica.

**Pantallas que abre:** 12.

**Permisos de acción:**

- `area.contabilidad` — Área: Contabilidad
- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `accounting.view` — Ver contabilidad *(declarado, aún sin uso)*
- `system.cron.run` — Ejecutar procesos programados a mano (facturación masiva)

### Técnicos

*Llave:* `area-tecnicos` · *Grupo:* Áreas Vestel · *Usuarios:* 52

Soporte/tickets, red/ISP, equipos y corte/reconexión.

**Pantallas que abre:** 15.

**Permisos de acción:**

- `area.tecnicos` — Área: Técnicos
- `network.cut` — Cortar servicio (individual y masivo)
- `network.reconnect` — Reconectar servicio
- `network.routers.manage` — Administrar routers y sesiones PPPoE
- `network.olt.manage` — Administrar ONUs de la OLT (autorizar/reiniciar/eliminar)

### Sistemas

*Llave:* `area-sistemas` · *Grupo:* Áreas Vestel · *Usuarios:* 1

Configuración, usuarios y roles, WhatsApp y dispositivos.

**Pantallas que abre:** 11.

**Permisos de acción:**

- `area.sistemas` — Área: Sistemas
- `system.users.manage` — Gestionar usuarios y roles
- `system.whatsapp` — Gestionar conexión de WhatsApp
- `system.cron.run` — Ejecutar procesos programados a mano (facturación masiva)
- `network.routers.manage` — Administrar routers y sesiones PPPoE
- `network.olt.manage` — Administrar ONUs de la OLT (autorizar/reiniciar/eliminar)

### Caja y ventas

*Llave:* `area-caja` · *Grupo:* Áreas Vestel · *Usuarios:* 21

Cajera: apertura/cierre de caja, movimientos, facturación, notas, clientes, tickets y órdenes.

**Pantallas que abre:** 14.

**Permisos de acción:**

- `area.caja` — Área: Caja y ventas
- `accounting.view` — Ver contabilidad *(declarado, aún sin uso)*

### Auditoría / Consulta

*Llave:* `auditor` · *Grupo:* Administración · *Usuarios:* 1

Solo lectura transversal: panel, contabilidad e inventario.

**Pantallas que abre:** 0.

**Permisos de acción:**

- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `accounting.view` — Ver contabilidad *(declarado, aún sin uso)*
- `inventory.products.read` — Ver productos *(declarado, aún sin uso)*
- `inventory.warehouses.read` — Ver bodegas *(declarado, aún sin uso)*
- `inventory.stock.read` — Ver existencias *(declarado, aún sin uso)*
- `inventory.kardex.read` — Ver kardex *(declarado, aún sin uso)*
- `inventory.reports.read` — Ver reportes de inventario *(declarado, aún sin uso)*

### Jefe de bodega

*Llave:* `warehouse-manager` · *Grupo:* Inventario · *Usuarios:* 1

Acceso total al inventario y único autorizado para asignar material a funcionarios.

**Pantallas que abre:** 0.

**Permisos de acción:**

- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `inventory.admin` — Administración total de inventario
- `inventory.assets.assign` — Asignar material a funcionarios *(declarado, aún sin uso)*

### Director de Recursos Humanos

*Llave:* `hr-director` · *Grupo:* Recursos Humanos · *Usuarios:* 1

Gestiona empleados, sus documentos y su acceso al sistema (crea logins y asigna roles).

**Pantallas que abre:** 0.

**Permisos de acción:**

- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `hr.employees.read` — Ver empleados (RRHH)
- `hr.employees.write` — Gestionar empleados y documentos (RRHH)
- `hr.access.manage` — Dar acceso al sistema y asignar roles (RRHH) *(declarado, aún sin uso)*

### Contador

*Llave:* `accountant` · *Grupo:* Contabilidad · *Usuarios:* 1

Operación completa de contabilidad y nómina.

**Pantallas que abre:** 0.

**Permisos de acción:**

- `dashboard.view` — Ver panel ejecutivo *(declarado, aún sin uso)*
- `accounting.view` — Ver contabilidad *(declarado, aún sin uso)*
- `accounting.manage` — Gestionar contabilidad *(declarado, aún sin uso)*
- `payroll.view` — Ver módulo de nómina *(declarado, aún sin uso)*
- `payroll.concepts.read` — Ver conceptos de nómina *(declarado, aún sin uso)*
- `payroll.concepts.write` — Gestionar conceptos de nómina *(declarado, aún sin uso)*
- `payroll.contracts.read` — Ver contratos *(declarado, aún sin uso)*
- `payroll.contracts.write` — Gestionar contratos *(declarado, aún sin uso)*
- `payroll.periods.read` — Ver periodos de nómina *(declarado, aún sin uso)*
- `payroll.periods.write` — Gestionar periodos (abrir/procesar/cerrar) *(declarado, aún sin uso)*
- `payroll.events.read` — Ver novedades de nómina *(declarado, aún sin uso)*
- `payroll.events.write` — Registrar novedades de nómina *(declarado, aún sin uso)*
- `payroll.events.approve` — Aprobar novedades de nómina *(declarado, aún sin uso)*
- `payroll.payslips.read` — Ver desprendibles (todos) *(declarado, aún sin uso)*
- `payroll.payslips.write` — Calcular y emitir desprendibles *(declarado, aún sin uso)*
- `payroll.reports.read` — Ver reportes de nómina *(declarado, aún sin uso)*
- `payroll.integrations.manage` — Gestionar integraciones contables (Siigo, etc.) *(declarado, aún sin uso)*

