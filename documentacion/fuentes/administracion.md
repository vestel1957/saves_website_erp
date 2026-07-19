# Manual de Administración

Este manual explica, pantalla por pantalla, las tareas del rol **Administración** del sistema SAVES de Vestel. Con este rol gestionas los clientes (abonados) del servicio de internet, el inventario de material, las compras a proveedores, el personal de la empresa y los proyectos. Cada sección te dice dónde encontrar la pantalla en el menú, para qué sirve, qué vas a ver y cómo hacer la tarea principal paso a paso.

> Consejos generales que aplican a todo el sistema:
> - El menú lateral solo muestra las opciones para las que tienes permiso. Si no ves una pantalla de este manual, es porque tu usuario no la tiene habilitada.
> - En el celular, las tablas se muestran como tarjetas (una ficha por fila) para que se lean cómodamente.
> - Al guardar algo aparece un aviso verde (todo salió bien) o rojo (hubo un error con el motivo).
> - Casi todas las listas tienen un buscador con una lupa; escribe y la lista se filtra sola.

# Clientes

## Administrar clientes

**Dónde:** Menú lateral → CLIENTES → Administrar clientes.

**Para qué sirve:** Es el listado de todos los abonados (clientes del servicio) y la puerta de entrada a la ficha completa de cada uno. Desde aquí creas clientes nuevos y consultas su estado, saldo y datos.

**Qué vas a ver:** En la parte de arriba, el total de clientes y un buscador donde puedes escribir nombre, documento, celular o número de abonado. Al lado hay filtros por estado (activo, suspendido, etc.), por sede y por tipo de servicio o tecnología. Debajo, una tabla con estas columnas:

| Columna | Qué muestra |
|---|---|
| Abonado | Número interno del cliente |
| Nombre | Nombre del cliente |
| Documento | Cédula o NIT |
| Celular | Teléfono de contacto |
| Sede | Sede a la que pertenece |
| Estado | Activo, suspendido, cortado, etc. (con color) |
| Saldo | Cuánto debe o tiene a favor |

Cada fila tiene el botón **Ver ficha** para abrir el detalle.

**Paso a paso (crear un cliente nuevo):**
1. Haz clic en el botón **Nuevo cliente** (arriba a la derecha).
2. Se abre un asistente que te va pidiendo los datos por pasos: información personal, datos de contacto, servicio y plan, y datos de red.
3. Completa los campos requeridos de cada paso y avanza.
4. Al terminar, el cliente queda creado y el sistema te lleva directamente a su ficha.

**Paso a paso (consultar y trabajar la ficha de un cliente):**
1. Busca al cliente y haz clic en **Ver ficha**.
2. Arriba verás su nombre, estado, número de abonado y los servicios contratados (Internet, TV, etc., cada uno con su plan). También una franja con la cartera (lo que debe), el saldo a favor y desde cuándo es cliente.
3. Usa las pestañas para moverte: **Resumen** (contacto, datos de red y de facturación, y notas), **Facturas**, **Estado de cuenta**, **Cobranza**, **Órdenes** de trabajo, **Equipos** asignados, **PlayHub**, **Historial** de estados y **Archivos**.
4. Para editar los datos, abre el menú **Acciones** (botón con tres puntos) y elige **Editar**.
5. En ese mismo menú **Acciones** tienes **Cambiar plan**, crear una **Nueva orden** de trabajo y **Conexión**, que es donde puedes **cortar o reconectar el servicio** del cliente.
6. El botón **Registrar pago** abre la ventana para abonar a las facturas pendientes.

> El botón de WhatsApp (verde), teléfono, correo y mapa que aparecen arriba en la ficha te dejan contactar o ubicar al cliente con un clic. Se ven en gris si el cliente no tiene ese dato cargado.
> En la pestaña Archivos puedes subir documentos del cliente (PDF, imágenes, Office) de hasta 20 MB cada uno.
> Cortar o reconectar el servicio afecta la conexión real del cliente. Hazlo solo cuando corresponda, porque el cliente lo nota de inmediato.

## Grupos de clientes

**Dónde:** Menú lateral → CLIENTES → Grupos de clientes.

**Para qué sirve:** Muestra a los abonados agrupados por sede, con un resumen de cuántos hay en cada una y cómo van de cartera. Sirve para ver el estado general de cada sede de un vistazo.

**Qué vas a ver:** Un buscador de sedes y una tabla con una fila por sede:

| Columna | Qué muestra |
|---|---|
| Sede | Nombre de la sede |
| Abonados | Total de clientes de esa sede |
| Activos | Cuántos están activos (verde) |
| Cortados | Cuántos están cortados (rojo) |
| Cartera | Cuántos tienen deuda pendiente |

**Paso a paso (ver los clientes de una sede):**
1. Si tienes muchas sedes, escribe el nombre en el buscador para encontrarla.
2. Haz clic en la fila de la sede (o en **Ver abonados**).
3. Se abre el listado de clientes de esa sede, donde puedes trabajar cada ficha igual que en Administrar clientes.

## Clientes PlayHub

**Dónde:** Menú lateral → CLIENTES → Clientes PlayHub.

**Para qué sirve:** Lista las suscripciones del servicio de televisión por streaming PlayHub (también llamado IPTV) y las relaciona con el cliente que las tiene.

**Qué vas a ver:** Arriba, unas etiquetas que resumen cuántas suscripciones hay por producto. Luego un buscador (por usuario, producto o voucher) y una tabla:

| Columna | Qué muestra |
|---|---|
| Cliente | Nombre del abonado (enlace a su ficha) |
| Usuario | Nombre de usuario en PlayHub |
| Producto | Plan o paquete de TV contratado |
| Voucher | Código de la suscripción |
| Últ. sync | Última vez que se actualizó el dato |

**Paso a paso (sincronizar las suscripciones):**
1. Para actualizar los datos con el proveedor de PlayHub, haz clic en **Sincronizar todo** (arriba a la derecha).
2. Espera a que termine; el aviso te dirá cuántos clientes se sincronizaron y si alguno tuvo error.
3. Para ir a la ficha de un cliente, haz clic en su nombre en la columna Cliente.

> La sincronización trae la información desde PlayHub. Úsala cuando notes datos desactualizados o después de dar de alta suscripciones nuevas.

# Inventario de material

## Administrar material

**Dónde:** Menú lateral → INVENTARIO → Material → Administrar material.

**Para qué sirve:** Es el inventario de materiales (cables, conectores, consumibles, etc.): qué hay, cuánto hay, en qué bodega y su valor. Aquí creas, editas y das de baja materiales.

**Qué vas a ver:** Arriba, unas tarjetas de resumen (total de materiales, categorías, bodegas, cuántos están con stock bajo y el valor total del inventario). Luego filtros por texto, categoría y bodega, y un botón **Solo stock bajo** para ver únicamente lo que está por agotarse. La tabla muestra:

| Columna | Qué muestra |
|---|---|
| Nombre | Nombre del material |
| Código | Código interno |
| Categoría | Grupo al que pertenece |
| Bodega | Dónde está guardado |
| Precio | Precio unitario |
| Stock | Cantidad disponible (en rojo si está bajo) |
| Valor | Valor total de esa existencia |

Cada fila tiene botones de lápiz (editar) y papelera (eliminar).

**Paso a paso (crear un material):**
1. Haz clic en **Nuevo material**.
2. Escribe el **Nombre** (obligatorio). Opcionalmente el código y la categoría.
3. Elige la **Bodega** donde entra el material.
4. Escribe el precio, el costo y el IVA (%) si aplica.
5. Indica el **Stock** inicial (cuántas unidades hay) y, si quieres, un valor de **Alerta stock** para que el sistema te avise cuando quede poco.
6. Agrega una descripción si lo necesitas y haz clic en **Crear**.

**Paso a paso (editar un material):**
1. Haz clic en el lápiz de la fila.
2. Cambia los datos que necesites y guarda con **Guardar cambios**.

> Al editar, la bodega no se puede cambiar directamente: para mover un material a otra bodega debes hacer un **Traspaso**, que deja un acta del movimiento.
> Puedes cargar muchos materiales de una vez con el botón **Importar Excel** (archivo .xlsx).
> Eliminar un material es definitivo y no se puede deshacer.

## Categorías de material

**Dónde:** Menú lateral → INVENTARIO → Material → Categorías.

**Para qué sirve:** Organiza el inventario en grupos (por ejemplo "Consumibles", "Herramienta"). Cada material puede pertenecer a una categoría.

**Qué vas a ver:** Una lista de tarjetas, una por categoría, con su nombre, cuántos materiales tiene y el valor de esos materiales. Cada tarjeta tiene botones de editar y eliminar, y al hacer clic en el nombre ves los materiales de esa categoría.

**Paso a paso (crear o editar una categoría):**
1. Haz clic en **Nueva categoría** (o en el lápiz de una existente).
2. Escribe el **Nombre** y, si quieres, una nota o detalle.
3. Haz clic en **Guardar**.

> Una categoría no se puede eliminar mientras tenga materiales asociados. Primero mueve o quita esos materiales.

## Bodegas de material

**Dónde:** Menú lateral → INVENTARIO → Material → Bodegas.

**Para qué sirve:** Son los almacenes donde se guarda el material. Cada bodega puede representar la bodega central o el stock de una sede.

**Qué vas a ver:** Una tabla con las bodegas, su referencia, cuántos materiales tienen y su valor. Cada fila tiene botones de editar y eliminar; al hacer clic en una fila ves el detalle de esa bodega.

**Paso a paso (crear o editar una bodega):**
1. Haz clic en **Nueva bodega** (o en el lápiz de una existente).
2. Escribe el **Nombre** (obligatorio) y una referencia o nota si quieres.
3. Haz clic en **Crear** o **Guardar cambios**.

> Una bodega solo se puede eliminar si no tiene material adentro.

## Traspasos

**Dónde:** Menú lateral → INVENTARIO → Material → Traspasos.

**Para qué sirve:** Mueve material de una bodega a otra dejando constancia. El material sale de la bodega origen y queda **en tránsito** hasta que alguien confirme la recepción en el destino; cada movimiento genera un acta.

**Qué vas a ver:** Un botón **Nuevo traspaso** y, debajo, la lista de **actas de traspaso** con fecha, origen, destino, cuántos ítems y unidades, quién recibe y el estado (Emitida, En tránsito, Recibida). Puedes buscar por bodega o responsable y filtrar por estado.

**Paso a paso (crear un traspaso):**
1. Haz clic en **Nuevo traspaso**.
2. Elige la **Bodega origen** (de dónde sale) y la **Bodega/sede destino** (a dónde va). Deben ser distintas.
3. Opcionalmente, elige **quién recibe** (la persona que confirmará la llegada en el destino).
4. En la lista de materiales, marca la casilla de cada material que vas a mover y ajusta la **cantidad** (por defecto se mueve todo lo disponible; no puedes poner más de lo que hay). Puedes usar el filtro para encontrar un material.
5. Revisa el resumen (ítems, unidades y valor) y agrega observaciones si quieres.
6. Haz clic en **Emitir traspaso**. El material queda en tránsito.

**Paso a paso (recibir un traspaso):**
1. Abre el acta desde la lista (botón **Ver**).
2. Si eres la persona designada para recibir, marca cada material a medida que lo recibes en el checklist, o usa **Recibir todo** para confirmar todos de una vez.
3. Al confirmar, el stock entra a la bodega destino.

> Solo la persona designada como receptora puede confirmar la recepción de ese traspaso.

## Actas

**Dónde:** Menú lateral → INVENTARIO → Material → Actas.

**Para qué sirve:** Es el historial completo de las actas de traspaso de material entre bodegas. Sirve para consultar y auditar movimientos ya hechos.

**Qué vas a ver:** Una tabla con fecha, origen, destino, cantidad de ítems, observaciones y estado (Recibida en verde). Al hacer clic en una fila se abre el detalle del acta.

**Paso a paso (consultar un acta):**
1. Recorre la lista o usa la paginación para encontrar el acta.
2. Haz clic en la fila para ver el detalle completo.
3. Si necesitas registrar un traspaso nuevo, usa el botón **Nuevo traspaso** que te lleva a la pantalla de Traspasos.

# Compras

## Órdenes de compra

**Dónde:** Menú lateral → COMPRAS → Órdenes de compra.

**Para qué sirve:** Registra las compras a proveedores: qué se pide, a quién, por cuánto, y luego el pago y la recepción de lo comprado.

**Qué vas a ver:** Un conmutador entre **Compra** y **Servicio** para ver un tipo u otro, un buscador (por número o proveedor) y un botón de filtros avanzados (estado, categoría, sede, proveedor, montos, fechas). La tabla muestra número de orden, proveedor, sede, fecha, total, estado y cantidad de ítems. El número de cada orden es un enlace a su detalle.

**Paso a paso (crear una orden):**
1. Haz clic en **Nueva orden**.
2. Busca y selecciona el **proveedor** por nombre o NIT.
3. Agrega los **ítems**: descripción, cantidad, precio e IVA (%). Usa **Agregar ítem** para añadir más filas; el subtotal y el total se calculan solos.
4. Indica la **fecha** de la orden y, opcionalmente, la **categoría de compra** y una nota.
5. Haz clic en **Crear orden**. El sistema te lleva al detalle de la orden creada.

**Paso a paso (recibir lo comprado y pagar):**
1. Abre la orden desde la lista (clic en su número).
2. En la sección **Recibir**, escribe cuánto llegó de cada ítem y haz clic en **Registrar recepción**. Puedes recibir por partes (recepción parcial).
3. Si hay saldo pendiente, usa **Registrar pago** (en el bloque de totales): indica monto, método (efectivo o consignación) y la caja o cuenta.
4. Si aplica, usa **Agregar nota** para registrar una nota crédito (descuento), nota débito (aumento) o una retención (ReteFuente/ReteICA); el total de la orden se ajusta.

> El crédito y la retención restan del total; el débito lo suma. El total nunca puede quedar por debajo de lo que ya se pagó.

## Órdenes de servicio

**Dónde:** Menú lateral → COMPRAS → Órdenes de servicio.

**Para qué sirve:** Igual que las órdenes de compra, pero para servicios contratados a proveedores (mano de obra, mantenimiento, etc.) en lugar de productos.

**Qué vas a ver:** Un buscador y filtros, y una tabla con número, proveedor, sede, fecha, total, estado e ítems. Es la misma mecánica que las órdenes de compra, ya filtrada para mostrar solo servicios.

**Paso a paso (crear una orden de servicio):**
1. Haz clic en **Nueva orden** (usa la misma pantalla de creación).
2. Selecciona un **proveedor de servicios**.
3. Agrega los ítems del servicio con su descripción, cantidad, precio e IVA.
4. Completa fecha y nota, y haz clic en **Crear orden**.

> El tipo de orden (compra o servicio) depende de la categoría del proveedor que elijas. Registra a los proveedores de servicios en la pantalla de Proveedores para que aparezcan aquí.

## Categorías de compra

**Dónde:** Menú lateral → COMPRAS → Categorías de compra.

**Para qué sirve:** Clasifican las órdenes de compra (por ejemplo "Compras", "Nómina", "Servicios") para ordenarlas y reportarlas.

**Qué vas a ver:** Una lista de tarjetas con el nombre de cada categoría y cuántas órdenes la usan, con botones de editar y eliminar.

**Paso a paso (crear o editar una categoría):**
1. Haz clic en **Nueva categoría** (o en el lápiz de una existente).
2. Escribe el **Nombre** y haz clic en **Guardar**.

> Una categoría no se puede eliminar mientras alguna orden la esté usando. Si la renombras, las órdenes que ya la usaban se actualizan automáticamente.

## Proveedores

**Dónde:** Menú lateral → COMPRAS → Proveedores.

**Para qué sirve:** Es el directorio de proveedores de la empresa. Separa proveedores de **Productos** y de **Servicios**, guarda sus datos y su estado de cuenta.

**Qué vas a ver:** Dos pestañas arriba: **Productos** y **Servicios**. Un buscador (por nombre, NIT o ciudad) y una tabla con nombre, NIT, teléfono, ciudad, banco y número de órdenes. Cada fila tiene tres botones: estado de cuenta, editar y eliminar.

**Paso a paso (crear o editar un proveedor):**
1. Haz clic en **Nuevo proveedor** (o en el lápiz de uno existente).
2. Escribe el **Nombre** (obligatorio) y elige la **Categoría** (Productos o Servicios).
3. Completa los datos opcionales: NIT, teléfono, email, dirección, ciudad, banco, cuenta y empresa.
4. Haz clic en **Crear proveedor** o **Guardar**.

**Paso a paso (ver el estado de cuenta de un proveedor):**
1. Haz clic en el ícono de estado de cuenta (el de la fila del proveedor).
2. Verás el total comprado, lo pagado y el saldo, además de la lista de órdenes y de pagos.

> Un proveedor solo se puede eliminar si no tiene órdenes ni devoluciones asociadas.

## Devoluciones

**Dónde:** Menú lateral → COMPRAS → Devoluciones.

**Para qué sirve:** Registra la devolución de material a un proveedor (por ejemplo producto defectuoso o de más).

**Qué vas a ver:** Tarjetas con el total de devoluciones y el monto acumulado. Un buscador (por número o proveedor) y un filtro por estado (Borrador, Pendiente, Aprobada, Completada, Anulada). La tabla muestra número, proveedor, fecha, total, estado y cantidad de ítems.

**Paso a paso (crear una devolución):**
1. Haz clic en **Nueva devolución**.
2. Busca y selecciona el **proveedor**.
3. En **Materiales**, busca cada material que vas a devolver y haz clic para agregarlo a la lista.
4. Ajusta la **cantidad** y el **precio** de cada material; el total se calcula solo.
5. Indica la **fecha** y una nota con el motivo si quieres.
6. Haz clic en **Crear devolución**.

# Personal y proyectos

## Empleados

**Dónde:** Menú lateral → PERSONAL → Empleados.

**Para qué sirve:** Es el listado del personal de la empresa y la ficha de cada empleado, con sus datos personales, de salud/contacto y, si tiene cuenta en el sistema, sus permisos de acceso.

**Qué vas a ver:** Tarjetas con el total de empleados, cuántos activos y cuántos técnicos. Un buscador (por nombre, documento o usuario) y filtros por rol, área y estado. La tabla muestra nombre, documento, usuario, rol, área, teléfono y estado (Activo o Inhabilitado).

**Paso a paso (crear un empleado):**
1. Haz clic en **Nuevo empleado**.
2. Escribe el **Nombre** (obligatorio).
3. Completa lo demás: documento, usuario, email, teléfono, rol, área y datos de salud (RH, EPS, pensión) y dirección.
4. Haz clic en **Crear empleado**.

**Paso a paso (consultar y editar la ficha de un empleado):**
1. Haz clic en la fila del empleado para abrir su ficha.
2. En la pestaña **Datos personales** ves sus datos, salud y contacto, y un resumen de su actividad (transacciones, ingresos, facturas emitidas).
3. Para cambiar datos, haz clic en **Editar**, modifica y guarda.
4. En la pestaña **Permisos y accesos** ves si el empleado tiene cuenta del sistema y qué puede hacer.

> El correo es el vínculo con la cuenta de acceso. Si un empleado no tiene cuenta y le agregas correo, el superusuario podrá crearle el acceso desde la pestaña Permisos.
> Solo el superusuario puede crear cuentas, cambiar permisos, asignar roles, habilitar/inhabilitar el acceso o restablecer contraseñas. Cuando se genera una contraseña temporal, se muestra una sola vez: cópiala y entrégala al empleado.

## Móviles / cuadrillas

**Dónde:** Menú lateral → PERSONAL → Móviles / cuadrillas.

**Para qué sirve:** Agrupa técnicos en "móviles" (cuadrillas o equipos de trabajo) para asignarles órdenes y agenda como grupo.

**Qué vas a ver:** Una tarjeta por cada móvil, con su nombre, estado (Activa/Inactiva) y los técnicos que la integran. Cada tarjeta tiene botones de editar y eliminar y un botón para gestionar sus técnicos.

**Paso a paso (crear una móvil):**
1. Haz clic en **Nueva móvil**.
2. Escribe el **Nombre** (por ejemplo "Móvil 1 · Yopal") y elige el **Estado**.
3. Haz clic en **Guardar**.

**Paso a paso (agregar o quitar técnicos de una móvil):**
1. En la tarjeta de la móvil, haz clic en **Gestionar técnicos**.
2. Para agregar, elige un técnico en la lista y haz clic en **Agregar**.
3. Para quitar uno, haz clic en la equis junto a su nombre.

## Proyectos

**Dónde:** Menú lateral → PROYECTOS → Proyectos.

**Para qué sirve:** Gestiona proyectos con su avance, presupuesto, prioridad e hitos. Un proyecto puede estar asociado a un cliente.

**Qué vas a ver:** Tarjetas con el total de proyectos, presupuesto total, cuántos en progreso y cuántos finalizados. Un buscador y un filtro por estado. La tabla muestra nombre, cliente, estado, prioridad, una barra de avance (%), presupuesto y número de hitos. El nombre es un enlace al detalle del proyecto.

**Paso a paso (crear un proyecto):**
1. Haz clic en **Nuevo proyecto**.
2. Escribe el **Nombre** (obligatorio).
3. Si aplica, asocia un **Cliente** con el buscador.
4. Elige **Estado** y **Prioridad**, y escribe el **Avance (%)** y el **Presupuesto**.
5. Indica fecha de inicio y fin si las conoces, agrega una nota y haz clic en **Crear proyecto**.

## Tareas / Pendientes

**Dónde:** Menú lateral → PROYECTOS → Tareas.

**Para qué sirve:** Lleva los pendientes del equipo. Una tarea puede ser una nota suelta o estar ligada a una orden de trabajo, y puede asignarse a una persona.

**Qué vas a ver:** Tarjetas con tus tareas abiertas, las pendientes, las vencidas y las hechas. Un buscador, un botón **Solo mías** y filtros por estado, prioridad y tipo (de órdenes o notas sueltas). La tabla muestra la tarea, si tiene orden asociada, el responsable, la fecha de vencimiento (en rojo si está vencida), la prioridad y el estado. Cada fila tiene botones para marcar como hecha, editar y eliminar.

**Paso a paso (crear una tarea):**
1. Haz clic en **Nueva tarea**.
2. Escribe la **Tarea** (qué hay que hacer, obligatorio).
3. Elige **Estado** y **Prioridad**, y fechas de inicio y vencimiento si aplican.
4. Si la tarea va ligada a una orden, escribe su **N° de orden**; si la dejas vacía, será una nota suelta.
5. Elige el **Responsable** (si lo dejas vacío, la tarea queda para ti) y agrega un detalle.
6. Haz clic en **Crear tarea**.

**Paso a paso (avanzar una tarea rápido):**
1. En la tabla, haz clic en el botón de check (marca de verificación) de la fila para marcarla como **Hecha** sin abrir la tarea.

> La fecha de vencimiento no puede ser anterior a la de inicio; el sistema te avisa si te equivocas.

## Agenda / Eventos

**Dónde:** Menú lateral → PROYECTOS → Agenda.

**Para qué sirve:** Programa eventos y actividades (instalaciones, visitas, reuniones) con fecha y hora. Algunos eventos pueden estar ligados a una orden de trabajo.

**Qué vas a ver:** Tarjetas con el total de eventos y el último registrado. Un filtro por rango de fechas (Desde / Hasta) y una tabla con inicio, título (con su color), descripción, orden asociada y quién lo asignó. Cada fila tiene botones de editar y eliminar.

**Paso a paso (crear un evento):**
1. Haz clic en **Nuevo evento**.
2. Escribe el **Título** (por ejemplo "Instalación cliente X").
3. Indica la fecha y hora de **Inicio** (obligatorio) y, si quieres, la de **Fin**.
4. Elige un **Color** para identificarlo y agrega una descripción.
5. Haz clic en **Guardar**.

**Paso a paso (buscar eventos por fecha):**
1. Escribe una fecha en **Desde** y/o **Hasta**.
2. Haz clic en **Filtrar** para ver solo los eventos de ese rango.

## Transferencias de equipos

**Dónde:** Menú lateral → RED → Transferencias.

**Para qué sirve:** Gestiona el movimiento de **equipos** (módems, ONTs, etc.) entre bodegas cuando los técnicos envían o solicitan equipo. El flujo tiene tres pasos: alguien **solicita**, inventario **despacha** (aprueba) y la caja de la sede destino **recibe**.

**Qué vas a ver:** El total de transferencias y un botón **Solicitar transferencia**. Un buscador (por bodega, solicitante u observación) y filtros por estado (Pendiente, En tránsito, Recibida, Rechazada) y por bodega. La tabla muestra fecha, origen, destino, número de equipos, quién solicita y el estado. Cada fila tiene un botón **Ver** para el detalle.

**Paso a paso (solicitar una transferencia):**
1. Haz clic en **Solicitar transferencia**.
2. Elige **Bodega origen** y **Bodega destino** (deben ser distintas).
3. Marca las casillas de los **equipos** que vas a transferir (aparecen los de la bodega origen, con su código, marca, MAC y serial).
4. Agrega observaciones si quieres y haz clic en **Crear transferencia**. Queda **pendiente de aprobación**.

**Paso a paso (aprobar/despachar o rechazar una solicitud):**
1. Abre la transferencia con **Ver**.
2. Si tienes permiso de inventario y está **Pendiente**, revisa los equipos y haz clic en **Aprobar y despachar**: los equipos salen de la bodega origen y quedan **en tránsito**.
3. Para rechazarla, haz clic en **Rechazar**, escribe el motivo (opcional) y confirma.

**Paso a paso (confirmar la recepción):**
1. Cuando la transferencia está **En tránsito**, ábrela con **Ver**.
2. Si te corresponde recibir (caja de la sede destino), haz clic en **Confirmar recepción**: los equipos entran a la bodega destino.

> En el detalle verás el recorrido completo: quién la solicitó, quién la despachó (inventario) y quién la recibió (caja), con sus fechas. Si fue rechazada, se muestra el motivo.
