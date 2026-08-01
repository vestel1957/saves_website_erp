# Manual de Caja y Ventas

Este manual es para el personal de **Caja y Ventas** (cajero o cajera) del sistema **SAVES** de Vestel. Aquí se explica, en palabras sencillas, cómo hacer el trabajo del día: abrir la caja al empezar el turno, cobrarle a los clientes, registrar los gastos y cerrar la caja cuadrando el dinero al final. No necesitas saber de computadores para seguir estos pasos; cada pantalla trae la ruta del menú y una guía numerada.

> Un par de aclaraciones antes de empezar:
> - **Caja**: el "cajón" donde se guarda el dinero de tu punto. Cada punto o sede puede tener su propia caja.
> - **Movimiento** o **transacción**: cada vez que entra dinero (ingreso) o sale dinero (egreso), queda anotado como un movimiento.
> - **Comprobante**: la foto o el PDF (recibo, factura o soporte de transferencia) que respalda un movimiento.

## El día a día en caja (resumen)

Todo tu día gira alrededor de tres momentos. Si entiendes estos tres pasos, entiendes el sistema:

1. **Abrir la caja** (al empezar el turno). Registras con cuánto dinero arranca el cajón: es el **monto base**. Se hace en *Tesorería → Apertura de caja*.
2. **Cobrar y gastar** (durante el día).
   - Cada pago que recibes de un cliente lo registras como **ingreso** (*Tesorería → Ingresos*, botón "Registrar recaudo").
   - Cada gasto que pagas de la caja lo registras como **egreso** (*Tesorería → Egresos*), y le puedes adjuntar el comprobante.
   - Si vas a entregarle su factura a un cliente y cobrarla, lo haces desde *Facturación*.
3. **Cerrar la caja** (al terminar el turno). Cuentas el efectivo real que quedó y lo comparas con lo que el sistema tiene registrado. Se hace en *Tesorería → Cierre de caja*.

> Regla de oro: registra cada pago y cada gasto en el momento en que ocurre. Si dejas todo para el final, la caja no cuadra y toca buscar el error.

---

# Caja / Tesorería

## Apertura de caja

**Dónde:** menú *Tesorería → Apertura de caja* (ruta `/tesoreria/apertura`).

**Para qué sirve:** dejar registrado con cuánto dinero empieza tu turno. Ese monto inicial se llama **base** y sirve para que, al cerrar, el sistema sepa cuánto efectivo debería haber.

**Qué vas a ver:** un formulario para abrir la caja y, al lado, la lista de las últimas aperturas hechas.

| Campo | Qué significa |
|-------|---------------|
| Caja | El cajón que vas a abrir. Normalmente ya sale el tuyo. |
| Fecha | El día de la apertura (hoy, por defecto). |
| Base | El dinero con el que arranca el cajón. El sistema la sugiere solo. |
| Nota | Una observación opcional. |

**Paso a paso:**

1. Selecciona tu **Caja** en la lista.
2. Confirma la **Fecha** (viene puesto el día de hoy).
3. Revisa la **Base**. El sistema la calcula solo como *fondo fijo + arrastre del día anterior*:
   - **Fondo fijo**: la plata que siempre se queda en el cajón para dar vueltas.
   - **Arrastre**: el excedente que sobró del cierre del día anterior.
   Si el número sugerido coincide con lo que tienes, déjalo así.
4. Si el efectivo real es distinto al sugerido, corrige el valor en **Base** escribiendo el monto correcto.
5. Escribe una **Nota** si quieres dejar constancia de algo.
6. Pulsa el botón para abrir la caja. Aparecerá un aviso verde confirmando "Caja abierta con base $...".

> Si esa caja ya fue abierta ese mismo día, el sistema te lo avisa con un mensaje amarillo e indica quién la abrió. Si guardas de nuevo, la apertura se **actualiza** (no se duplica).
> Cuenta el dinero del cajón antes de escribir la base. La base debe reflejar el efectivo real con el que arrancas.

## Cierre de caja

**Dónde:** menú *Tesorería → Cierre de caja* (ruta `/tesoreria/cierres`).

**Para qué sirve:** cerrar el turno cuadrando el dinero. El sistema toma lo que abriste de base, le suma los recaudos en efectivo, le resta los egresos en efectivo y te dice cuánto efectivo debería haber en el cajón. Ese sobrante (excedente) se "barre" y se arrastra al siguiente día.

**Qué vas a ver:** un formulario con **Sede**, **Caja** y **Fecha**, y un botón **Ver**. Hasta que no pulses **Ver**, abajo no aparece nada. Al consultar se muestra el informe del día y el historial de cierres recientes.

**Paso a paso:**

1. Elige la **Sede** y la **Caja**. Si eres cajero o cajera, estos dos campos ya vienen fijados en tu caja y no los puedes cambiar (solo eliges la fecha).
2. Elige la **Fecha** del cierre (normalmente el día de hoy).
3. Pulsa **Ver**. Aparece el informe con el detalle del día: recaudos en efectivo, egresos en efectivo y el excedente resultante.
4. Cuenta el efectivo físico del cajón y compáralo con el efectivo que muestra el informe.
5. Si todo coincide, confirma el cierre. El sistema "barre" el excedente (deja la base en cero) y lo arrastra al próximo día hábil.
6. Para guardar constancia, puedes abrir el **PDF** del cierre desde el historial e imprimirlo.

> **¿Qué hago si no cuadra?**
> - Si sobra o falta poco, revisa que hayas registrado **todos** los ingresos y egresos del día. El error casi siempre es un movimiento que no se anotó.
> - Revisa que ningún pago se haya registrado en la caja equivocada.
> - Si un movimiento quedó mal, se corrige o se anula (ver la pantalla *Anulaciones*) y vuelves a mirar el informe.
> - No cierres "a la fuerza" cuando falta plata sin avisar a tu supervisor. Deja la diferencia documentada.

## Movimientos

**Dónde:** menú *Tesorería* (ruta `/tesoreria`).

**Para qué sirve:** es el listado central de **todo** lo que entra y sale de las cajas: los ingresos, los egresos, las transferencias y las anulaciones, todo junto. Sirve para buscar un movimiento puntual o para revisar el día.

**Qué vas a ver:** unos totales arriba (resumen), filtros y una tabla con todos los movimientos.

| Columna | Qué muestra |
|---------|-------------|
| Fecha | Cuándo se registró. |
| Quién / Tercero | El cliente o persona del movimiento. |
| Tipo | Si fue ingreso, egreso, etc. |
| Categoría | El concepto (arriendo, servicios, recaudo...). |
| Monto | El valor. |
| Estado | Normal o "Anulada". |
| Comprobante | Enlace para ver la foto o PDF adjunto, si lo tiene. |

**Paso a paso:**

1. Usa el **buscador** (la lupa) para encontrar por nombre o concepto.
2. Filtra por **Tipo** (ingreso / egreso), por **Categoría**, por **Estado** o por **Caja** para acotar la lista.
3. Si hay muchos resultados, usa la **paginación** de abajo para pasar de página.
4. Para ver el soporte de un movimiento, pulsa el enlace en la columna **Comprobante**.

> Esta pantalla es de consulta. Para crear un ingreso o egreso, entra a las pantallas *Ingresos*, *Egresos* o *Nueva transacción*.

## Ingresos

**Dónde:** menú *Tesorería → Ingresos* (ruta `/tesoreria/ingresos`).

**Para qué sirve:** registrar el dinero que **entra**, es decir, los pagos (recaudos) que te hacen los clientes. Cuando registras un recaudo aquí, el pago se aplica automáticamente a las facturas pendientes del cliente.

**Qué vas a ver:** la lista de los ingresos registrados y un botón **Registrar recaudo**.

**Paso a paso:**

1. Pulsa **Registrar recaudo**.
2. En la ventana que se abre, **busca y elige al cliente** al que le vas a aplicar el pago.
3. El sistema te muestra la deuda del cliente (sus facturas pendientes) y su saldo a favor si lo tiene.
4. Escribe el **Monto a recaudar** (la plata que te está entregando).
5. Elige el **Método de pago** (efectivo, transferencia, etc.). Si es por banco, indica cuál.
6. El sistema reparte el pago sobre las facturas empezando por la más antigua. Si pagó de más, ese excedente le queda como **saldo a favor** para su próxima factura.
7. Confirma. Verás un aviso verde y el nuevo ingreso aparecerá en la lista.

**Captura:** tesoreria-ingresos-modal — Ventana **Registrar recaudo**: se busca el cliente y el sistema muestra su deuda antes de aplicar el pago.

> Cada fila tiene un botón **Editar** para corregir un movimiento, mientras no esté anulado.
> También puedes registrar el recaudo desde la ficha del cliente; es el mismo resultado.

## Egresos

**Dónde:** menú *Tesorería → Egresos* (ruta `/tesoreria/egresos`).

**Para qué sirve:** registrar el dinero que **sale** de la caja: gastos, pagos a terceros, compras menores, etc. Aquí es donde adjuntas la foto o el PDF del recibo.

**Qué vas a ver:** la lista de egresos registrados y un botón **Registrar egreso**.

**Paso a paso:**

1. Pulsa **Registrar egreso**.
2. Escribe el **Monto** del gasto.
3. Elige la **Categoría** (el concepto del gasto).
4. Elige el **Método de pago** (efectivo, transferencia...).
5. Escribe una **Nota** que explique el gasto.
6. Adjunta el **Comprobante (opcional)**: pulsa "Adjuntar comprobante" y sube la foto o el PDF de la factura, recibo o soporte de la transferencia.
7. Confirma. Verás el aviso verde y el egreso quedará en la lista con su comprobante.

**Captura:** tesoreria-egresos-modal — Ventana **Registrar egreso**, con el campo para adjuntar el comprobante.

> Cada fila tiene un botón **Editar** para corregir el egreso, mientras no esté anulado.
> Adjunta siempre el soporte de los gastos: sin comprobante, el gasto es difícil de justificar en el cierre.

## Nueva transacción

**Dónde:** menú *Tesorería → Nueva transacción* (ruta `/tesoreria/nueva`).

**Para qué sirve:** registrar a mano **un** movimiento de caja, sea ingreso o egreso, en un solo formulario. Se usa para movimientos que no van contra la factura de un cliente (por ejemplo, un ingreso o gasto suelto). Ojo: aquí el dinero **no** se aplica a facturas; para eso está "Registrar recaudo" en *Ingresos*.

**Qué vas a ver:** un formulario a la izquierda y un resumen a la derecha con el monto y los botones siempre a la vista.

| Campo | Qué significa |
|-------|---------------|
| Tipo | Ingreso o Egreso. Es lo primero que eliges. |
| Monto | El valor del movimiento. |
| Categoría | El concepto (obligatorio, si no, no sale en los reportes). |
| Método | Cómo se pagó o se recibió. |
| Caja | En qué cajón se registra. |
| Cliente / Tercero | Opcional: un cliente del sistema, o el nombre libre de quien no es cliente. |
| Fecha | El día del movimiento. |
| Nota | Observación. |
| Comprobante | Foto o PDF de soporte (opcional). |

**Paso a paso:**

1. Elige el **Tipo**: Ingreso o Egreso.
2. Escribe el **Monto** (debe ser mayor a cero).
3. Elige la **Categoría** (es obligatoria).
4. Elige el **Método** de pago y la **Caja**.
5. Si aplica, elige el **cliente** en el buscador, o escribe el nombre del tercero si no es cliente.
6. Ajusta la **Fecha** y escribe una **Nota** si hace falta.
7. Adjunta un **comprobante** si lo tienes.
8. Guarda. El sistema te lleva a la lista de Ingresos o de Egresos según lo que registraste.

> Si buscas aplicar un pago a la deuda de un cliente, no uses esta pantalla: usa **Registrar recaudo** en *Ingresos*.

## Transferencia entre cajas

**Dónde:** menú *Tesorería → Transferencia entre cajas* (ruta `/tesoreria/transferencia`).

**Para qué sirve:** mover dinero de una caja a otra (por ejemplo, llevar efectivo de tu caja al banco o a la caja principal). El sistema lo registra como un egreso en la caja de origen y, al mismo tiempo, como un ingreso en la caja de destino.

**Paso a paso:**

1. En **Desde (origen)** elige la caja de donde sale el dinero.
2. En **Hacia (destino)** elige la caja que recibe. Debe ser distinta a la de origen.
3. Escribe el **Monto** a transferir.
4. Confirma la **Fecha**.
5. Escribe un **Concepto / nota** si quieres (opcional).
6. Revisa el resumen que aparece y confirma. Verás un aviso verde "Transferencia de $... registrada".

> Si eliges la misma caja en origen y destino, el sistema no te deja continuar y te avisa.
> No tienes que registrar dos movimientos por tu cuenta: esta pantalla crea automáticamente el egreso y el ingreso.

## Anulaciones

**Dónde:** menú *Tesorería → Anulaciones* (ruta `/tesoreria/anulaciones`).

**Para qué sirve:** ver los movimientos que se anularon (reversaron) y su motivo. Anular es la forma de dejar sin efecto un movimiento mal registrado, sin borrarlo, para que quede el rastro.

**Qué vas a ver:** la lista de las transacciones anuladas, con una columna extra de **Motivo**.

**Paso a paso (para consultar):**

1. Entra a la pantalla; verás solo los movimientos ya anulados.
2. Usa el **buscador** para encontrar uno en concreto.
3. Lee el **Motivo** de cada anulación.

**Paso a paso (para anular un movimiento):**

1. Ubica el movimiento mal registrado en *Movimientos* o en la ventana de cierre.
2. Abre la opción de **anular** ese movimiento.
3. Escribe el **Motivo** (obligatorio, por ejemplo "Pago duplicado"). Debe tener al menos unas pocas letras.
4. Elige el **Detalle** en la lista.
5. Confirma. El movimiento pasa a estado "Anulada" y su dinero se reversa.

> Anular no borra: el movimiento queda visible marcado como anulado, con su motivo. Esto es a propósito, para la transparencia del arqueo.
> Si anulas un cobro que ya estaba aplicado a una factura, ese dinero sale del arqueo de la caja donde se recibió.

## Cajas y categorías

**Dónde:** menú *Tesorería → Cajas* (ruta `/tesoreria/cajas`).

**Para qué sirve:** administrar las **cajas** (y bancos) disponibles y las **categorías** con las que se clasifican los ingresos y egresos. Normalmente esto lo configura un supervisor; como cajero lo usarás sobre todo para consultar.

**Qué vas a ver:** la lista de cajas con su saldo, y la lista de categorías.

| Campo de una caja | Qué significa |
|-------------------|---------------|
| Nombre de la caja | Cómo se llama (ej: "Caja principal Yopal"). |
| N.º de cuenta | Solo si es un banco. |
| Código | Un código interno opcional. |
| Teléfono / Dirección | Datos de contacto, opcionales. |
| Fondo fijo | La plata que nunca sale del cajón; no entra en el excedente del arqueo. |

**Paso a paso:**

1. Para crear una caja o banco, pulsa el botón de **nueva caja** y llena al menos el **Nombre**.
2. Para editar una caja, ábrela desde la lista y cambia los datos.
3. Si el saldo de una caja se ve raro, usa **recalcular saldo** para que el sistema lo vuelva a sumar.
4. Para las **categorías**, escribe el nombre en el campo y agrégala; o elimínala desde la lista.

> El **fondo fijo** es clave para el cierre: es la base que siempre queda. Si lo cambias, cambia la base sugerida en la apertura.
> Elimina cajas o categorías solo si estás seguro; afectan cómo se agrupan los movimientos en los reportes.

## Importar pagos (Efecty)

**Dónde:** menú *Tesorería → Importar pagos (Efecty)* (ruta `/tesoreria/importar-pagos`).

**Para qué sirve:** cargar de una sola vez un archivo con los pagos que los clientes hicieron por **Efecty** (un punto de pago externo). El sistema los aplica automáticamente a la cartera (la deuda) de cada cliente, y reconecta a los que estaban cortados y pagaron.

**Qué vas a ver:** una zona para cargar el archivo, la lista de lotes cargados y el detalle de cada lote con sus filas (aplicadas, con error, no encontradas, duplicadas).

> El archivo debe ser un **Excel .xlsx** con los títulos en la fila 1 y los datos desde la fila 2, en estas columnas:
> - **A**: Fecha
> - **B**: Documento o número de abonado
> - **C**: Monto
> - **D**: Método
> - **E**: Referencia

**Paso a paso:**

1. Prepara el archivo **.xlsx** tal como se describe arriba.
2. Pulsa para seleccionar el **Archivo .xlsx**.
3. Si necesitas que todos los pagos tomen una fecha concreta, escríbela en **Forzar fecha (opcional)**.
4. Pulsa **Cargar**. El sistema lee el archivo y te muestra cuántas filas trae y si alguna tiene problemas.
5. Revisa el detalle: filas correctas, con error, cliente no encontrado o duplicadas.
6. Cuando esté bien, pulsa **Procesar**. Confirma el aviso: se aplicarán los pagos a la cartera y se reconectarán los clientes cortados que pagaron.
7. Al terminar verás cuántos se aplicaron y cuántos quedaron con problema.

> **Cuidado:** si eliminas un lote, los pagos que **ya se aplicaron no se revierten**. Eliminar solo quita el registro del lote, no deshace los cobros.
> Revisa siempre el detalle antes de procesar, para no aplicar pagos duplicados o a clientes equivocados.

---

# Ventas (cobrar)

## Administrar facturas

**Dónde:** menú *Facturación* (ruta `/facturacion`).

**Para qué sirve:** buscar la factura de un cliente, crear una factura nueva, registrar su pago y descargar el PDF para entregárselo o imprimirlo.

**Qué vas a ver:** unos totales arriba, filtros y una tabla de facturas.

| Columna | Qué muestra |
|---------|-------------|
| N° / Factura | El número de la factura. |
| Cliente | A quién pertenece. |
| Fecha / Vence | Fecha de emisión y de vencimiento. |
| Total y Saldo | Cuánto vale y cuánto falta por pagar. |
| Estado | Pagada, pendiente, vencida... |

**Paso a paso:**

1. Usa el **buscador** para encontrar la factura por número o por cliente.
2. Afina con los **filtros**: estado de pago, tipo de servicio, sede o rango de fechas. Puedes marcar la opción de solo **vencidas**.
3. Para crear una factura, pulsa el botón de **nueva factura** y sigue la ventana.
4. Para ver el detalle de una factura, ábrela desde la tabla.
5. Dentro del detalle puedes:
   - **Ver / imprimir PDF** para descargar o imprimir la factura.
   - Registrar el pago del cliente.
   - **Anular** la factura si estás autorizado (si tenía pagos, ese dinero se reversa y sale del arqueo).
   - Aplicar una **promoción** autorizada, que genera una nota crédito.

> Algunas acciones (emitir factura electrónica, generar facturas en lote, exportar) solo aparecen si tienes el permiso; si no las ves, es que ese permiso está en otra área.
> Antes de entregar el PDF al cliente, verifica que el total y el saldo sean los correctos.

**Captura:** facturacion-ficha — Detalle de una factura: conceptos, totales y los pagos aplicados.

## Notas crédito / débito

**Dónde:** menú *Facturación → Notas crédito / débito* (ruta `/facturacion/notas`).

**Para qué sirve:** corregir una factura ya emitida. Una **nota crédito** le **rebaja** el valor al cliente (le baja lo que debe); una **nota débito** le **recarga** (le suma).

**Qué vas a ver:** la lista de notas, con su tipo, la factura relacionada, el cliente, la descripción y el monto (en verde si rebaja, en color de aviso si recarga).

**Paso a paso:**

1. Usa el **buscador** para encontrar por número de factura, cliente o descripción.
2. Filtra por tipo con **Nota crédito** o **Nota débito** si quieres acotar.
3. Para crear una, pulsa **Nueva nota** y completa la ventana: indica la factura, el tipo (crédito o débito), el monto y una descripción del motivo.
4. Guarda. La nota queda asociada a la factura y ajusta su saldo.
5. Para ver el detalle de una nota, usa el botón de **Detalles** de la fila.

> Una nota crédito es la forma correcta de "descontar" o corregir de menos una factura ya emitida. No modifiques la factura por otro lado: deja el ajuste con su nota, para que quede el rastro.

## Administrar clientes

**Dónde:** menú *Clientes* (ruta `/clientes`).

**Para qué sirve:** consultar los datos de un cliente y su **estado de cuenta** al momento de cobrar: cuánto debe, qué facturas tiene pendientes y si tiene saldo a favor.

**Qué vas a ver:** el buscador y la lista de clientes con su número total.

**Paso a paso:**

1. Escribe en el **buscador** el nombre, documento, celular o número de abonado del cliente.
2. Abre su ficha desde la lista.
3. Revisa su estado de cuenta: facturas pendientes, saldo y datos de contacto.
4. Desde la ficha del cliente también puedes **registrar su recaudo** (aplica el pago a su deuda, igual que en *Ingresos*).

> Usa esta pantalla cuando un cliente llega a pagar y quieres confirmarle exactamente cuánto debe antes de cobrar.
> El botón "Nuevo cliente" crea un cliente; úsalo solo si tu rol lo tiene habilitado y realmente hace falta.

## Órdenes de compra

**Dónde:** menú *Órdenes* (ruta `/ordenes`).

**Para qué sirve:** consultar las órdenes de compra o de servicio a proveedores. Para caja es una consulta acotada: sirve para ubicar o verificar una orden cuando estás gestionando un pago relacionado.

**Qué vas a ver:** el buscador y la tabla de órdenes con su número, proveedor y estado.

**Paso a paso:**

1. Usa el **buscador** para encontrar por número de orden o por proveedor.
2. Abre la orden para ver su detalle.

> Esta pantalla es principalmente de consulta para caja. La creación y gestión completa de órdenes suele corresponder a otra área.

## Soporte técnico

**Dónde:** menú *Soporte* (ruta `/soporte`).

**Para qué sirve:** abrir un caso o **ticket** (una orden de trabajo) cuando un cliente que viene a la caja reporta una falla en su servicio, para que el equipo técnico lo atienda.

**Qué vas a ver:** unos totales arriba, el buscador y la lista de órdenes de trabajo (instalaciones, cortes, reconexiones, fallas).

**Paso a paso:**

1. Pulsa **Nueva orden**.
2. En la ventana, elige o busca al **cliente** que reporta la falla.
3. Describe el **problema** que reporta el cliente con el mayor detalle posible.
4. Completa los datos que pida la ventana y guarda. Verás el aviso verde y la orden aparecerá en la lista.
5. Para hacer seguimiento, usa el **buscador** por cliente, número de orden o técnico.

> Cuando un cliente reporta una falla mientras paga, deja el ticket creado en el momento: así el área técnica lo ve enseguida y el cliente sale atendido.
