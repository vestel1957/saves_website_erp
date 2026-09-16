# Manual de Contabilidad y Facturación

Este manual explica, pantalla por pantalla, cómo trabajar en el área de Contabilidad y Facturación del sistema SAVES de Vestel. Está pensado para personas sin conocimientos técnicos: cada pantalla dice dónde encontrarla, para qué sirve, qué verás y los pasos exactos para usarla. Aquí se cubren dos grandes bloques: la **Facturación** (crear cobros a los clientes, notas, facturación electrónica ante la DIAN, cotizaciones y ventas que se repiten cada mes) y la **Contabilidad** (los libros y estados financieros del negocio).

Antes de empezar, tres cosas que aplican a todas las pantallas:

> - El menú de la izquierda solo muestra las opciones para las que tienes permiso. Si no ves una pantalla de este manual, es porque tu usuario no tiene acceso a ella; pídeselo a un superusuario.
> - Cuando guardas algo, aparece un aviso corto: **verde** si salió bien, **rojo** si hubo un problema.
> - Casi todas las listas tienen un **buscador** arriba y un botón para **exportar** o **descargar en PDF**. El PDF es un archivo que puedes imprimir o enviar; el CSV es una hoja de cálculo que se abre en Excel.

Términos que se repiten:

> - **Abonado / cliente:** la persona o empresa que tiene contratado el servicio de internet o TV.
> - **DIAN:** la autoridad de impuestos de Colombia. La factura electrónica se "reporta" ante ella.
> - **Siigo:** el proveedor por el cual SAVES envía las facturas electrónicas a la DIAN.
> - **IVA:** el impuesto sobre las ventas que se suma al valor del servicio.
> - **Cartera:** el dinero que los clientes deben (facturas con saldo por pagar).

---

# Facturación

## Administrar facturas

**Dónde:** menú **Facturación** (ruta `/facturacion`).

**Para qué sirve:** es la pantalla central del área. Aquí ves todas las facturas emitidas a los clientes, creas facturas nuevas, revisas cuáles están pagadas o pendientes, descargas el PDF, las envías al cliente y, si tienes permiso, las anulas o las emites como factura electrónica.

**Qué vas a ver:** arriba, un resumen con el número total de facturas y el valor de la cartera. Debajo, un buscador, filtros y la lista de facturas. Cada fila es una factura:

| Columna | Qué significa |
| --- | --- |
| N° | Número de la factura |
| Cliente | Nombre del abonado (se puede abrir su ficha) |
| Servicio | Servicio facturado (internet, TV, etc.) |
| Fecha | Fecha en que se emitió |
| Vence | Fecha límite de pago; si ya pasó y hay saldo, aparece en rojo con una alerta |
| Total | Valor total de la factura |
| Saldo | Lo que falta por pagar; en rojo si es mayor a cero |
| Pago | Estado: pagada, pendiente o anulada |

Al final de cada fila hay botones de acción: ver/imprimir PDF, enviar por WhatsApp, enviar por correo, emitir factura electrónica o nota crédito (si tienes permiso) y **Ver** para abrir el detalle.

**Paso a paso — crear una factura nueva:**

1. Haz clic en **Nueva factura** (botón azul, arriba a la derecha).
2. En **Cliente**, busca y selecciona al abonado. Si quieres repetir la factura anterior de ese cliente, usa **Clonar última factura** para traer los mismos ítems.
3. En **Ítems**, escribe cada concepto que vas a cobrar: descripción, cantidad, precio e IVA %. Usa **Agregar ítem** para añadir más líneas.
4. Revisa la fecha de la factura y, si aplica, la fecha de vencimiento y una nota.
5. Verifica el total calculado a la derecha y haz clic en **Crear factura**. El sistema te lleva al detalle de la factura recién creada.

**Paso a paso — buscar y filtrar:**

1. Escribe en el buscador el N° de factura, el nombre del cliente, su documento o el número de abonado.
2. Para acotar más, pulsa **Filtros** y elige estado de pago, estado del servicio, sede o un rango de fechas.
3. El botón **Vencidas** muestra solo las facturas vencidas con saldo pendiente.
4. Para bajar la lista a una hoja de cálculo, usa **Exportar**.

**Paso a paso — ver, enviar o descargar una factura:**

1. En la fila de la factura, pulsa el ícono de documento para **ver o imprimir el PDF**.
2. Usa el ícono de WhatsApp o de correo para enviar la factura al cliente por esos medios.
3. Pulsa **Ver** para abrir el detalle completo (cliente, servicio, ítems, pagos y estado de la factura electrónica).

**Paso a paso — anular una factura (desde el detalle):**

1. Pulsa **Ver** en la factura y luego **Anular factura** (solo disponible si tienes permiso y la factura no está ya anulada).
2. Escribe el motivo de la anulación (obligatorio, mínimo unas palabras) y confirma.
3. El sistema reversa los pagos que tuviera registrados y marca la factura como anulada.

> El botón **Generar facturas del mes** crea de un solo golpe la mensualidad para todos los abonados activos. Antes de emitir de verdad, el sistema te obliga a hacer una **simulación** para revisar a quién se le va a facturar. Úsalo con cuidado: crea facturas reales.
> El manejo del efectivo del día (recibir pagos en caja, abrir y cerrar caja) se explica en el **Manual de Caja y Ventas**.

---

## Notas crédito / débito

**Dónde:** menú **Facturación → Notas** (ruta `/facturacion/notas`).

**Para qué sirve:** una **nota** ajusta una factura ya emitida. Una **nota crédito rebaja** el valor de la factura (por ejemplo, un descuento o la corrección de un cobro de más). Una **nota débito recarga** la factura (le suma un valor). También es la herramienta con la que se registran las promociones, que siempre se aplican como nota crédito.

**Qué vas a ver:** un buscador, un filtro por tipo (crédito o débito) y la lista de notas:

| Columna | Qué significa |
| --- | --- |
| Fecha | Cuándo se registró la nota |
| Tipo | Crédito (rebaja) o Débito (recargo) |
| Factura | Número de la factura afectada |
| Cliente | Abonado de esa factura |
| Descripción | Motivo de la nota |
| Monto | En verde con signo menos si es crédito; en naranja con signo más si es débito |

**Paso a paso — crear una nota:**

1. Pulsa **Nueva nota**.
2. Escribe el **N° de la factura** sobre la que vas a aplicar la nota.
3. Elige el **tipo**: nota crédito (rebaja) o nota débito (recargo).
4. Si corresponde, indica el tipo de retención en la lista desplegable (el sistema no la calcula solo; el valor lo digitas tú en el monto).
5. Escribe el **monto** y una **descripción** con el motivo.
6. Pulsa **Aplicar nota**. Verás el nuevo total de la factura en el aviso de confirmación.

**Paso a paso — ver el detalle de una nota:**

1. En la fila de la nota, pulsa **Ver**.
2. Se abre una ventana con el tipo, el monto, la factura, el cliente, la fecha, quién la registró y la descripción.

> Las **promociones** también terminan siendo una nota crédito, pero no se crean aquí: se aplican desde el detalle de la factura. Abre la factura (botón **Ver** en Administrar facturas), pulsa **Aplicar promoción**, elige una de las promociones que tengas autorizadas y confirma. El sistema genera automáticamente la nota crédito por el porcentaje de descuento sobre el total. Solo verás las promociones que un superusuario te haya asignado.

---

## Facturas electrónicas

**Dónde:** menú **Facturación → Electrónica** (ruta `/facturacion/electronica`).

**Para qué sirve:** emitir las facturas ante la DIAN a través de Siigo. "Timbrar" o "emitir" significa reportar oficialmente la factura y obtener un número DIAN. Se puede hacer factura por factura, o por lote (toda una sede de una vez). Esta pantalla también deja ver el histórico de lo emitido y reintentar las que fallaron.

**Qué vas a ver:** un encabezado con cuántas facturas se han emitido, cuántas tienen número DIAN y cuántas quedan pendientes. Debajo, tres pestañas:

| Pestaña | Qué muestra |
| --- | --- |
| Por sede | Cada sede con su número de clientes y cuántos están marcados para facturar TV e Internet, con botón para emitir el lote |
| Histórico | Todas las facturas electrónicas ya emitidas, con su tipo, factura y número DIAN |
| Errores | Las facturas que la DIAN o Siigo rechazaron, para reintentarlas (muestra un contador si hay pendientes) |

**Paso a paso — emitir por lote (una sede completa):**

1. Entra a la pestaña **Por sede**.
2. Ubica la sede y, si quieres revisar antes a quién se le facturará, pulsa **Ver clientes**.
3. Pulsa **Emitir e-factura** en esa sede.
4. Lee el aviso de confirmación y acepta. El sistema procesa las facturas pendientes de los clientes marcados y te informa cuántas salieron bien y cuántas con error. Si quedan más pendientes, vuelve a pulsar para continuar.

**Paso a paso — emitir una factura individual:**

1. Desde **Administrar facturas** (o desde el detalle de la factura), pulsa el botón de **emitir e-factura** en la fila.
2. Confirma el aviso. Cuando termina, la factura queda con su número DIAN.

**Paso a paso — ver el histórico y el detalle:**

1. Entra a la pestaña **Histórico** y busca por cliente o por número DIAN.
2. Pulsa **Ver** en una fila para abrir el detalle: cliente, fecha, tipo de servicio, cuenta Siigo usada, número DIAN, CUFE (el código único que la DIAN asigna a cada factura) y, si existe, el enlace al PDF oficial de la DIAN.

**Paso a paso — reintentar una factura con error:**

1. Entra a la pestaña **Errores**.
2. Lee el mensaje de error de la fila para entender qué pasó.
3. Pulsa **Reintentar**. Si se corrige, la factura sale de esta lista y queda emitida.

> Verás en pantalla un indicador de modo: **LIVE** significa que las facturas se envían de verdad a la DIAN (es un acto legal e irreversible); **DRY-RUN** (modo prueba) significa que el sistema solo simula el envío para revisar que todo esté bien, sin reportar nada. El cambio de modo prueba a real lo activa el área de sistemas al desplegar.

---

### Configuración de cuentas por sede (Cuentas Siigo)

**Dónde:** dentro de **Facturación electrónica**, enlace **Cuentas Siigo** (ruta `/facturacion/electronica/cuentas`).

**Para qué sirve:** guardar los datos que Siigo y la DIAN necesitan para emitir (credenciales y el "mapeo DIAN": qué comprobante, vendedor y medios de pago usar). Solo el área de contabilidad puede entrar aquí. Sin esta configuración completa, la emisión real no funciona.

**Qué vas a ver:** una tarjeta por cada cuenta (por ejemplo, una para Internet y otra para TV). Cada tarjeta indica si está **Lista para emitir** (verde) o si le **Faltan datos** (naranja, y lista qué falta). Dentro hay dos bloques de campos: identidad/credenciales (razón social, usuario API, access key, etc.) y el **Mapeo DIAN** (comprobante DIAN, vendedor, medios de pago, IVA); los campos marcados con asterisco son obligatorios para emitir.

**Paso a paso:**

1. Abre la tarjeta de la cuenta que vas a configurar.
2. Completa los datos de identidad y credenciales que te haya entregado el contador o Siigo. La access key, si ya estaba guardada, se deja en blanco para no cambiarla.
3. Llena el **Mapeo DIAN**, prestando atención a los campos con asterisco.
4. Deja marcada la casilla **Cuenta activa** si esa cuenta debe usarse.
5. Pulsa **Probar conexión** para verificar que las credenciales funcionan con Siigo.
6. Pulsa **Guardar**. Si todo está completo, el estado de la tarjeta cambiará a **Lista para emitir**.

> Si el sistema está en modo prueba (DRY-RUN), la configuración se guarda igual y queda lista, pero la emisión seguirá simulada hasta que sistemas active el modo real en el servidor.

---

## Cotizaciones

**Dónde:** menú **Cotizaciones** (ruta `/cotizaciones`).

**Para qué sirve:** preparar una **cotización** (una oferta de precio para un cliente) y, cuando el cliente la acepta, convertirla en una factura de venta sin volver a digitar todo.

**Qué vas a ver:** un buscador y la lista de cotizaciones:

| Columna | Qué significa |
| --- | --- |
| Cotización | Número de la cotización |
| Cliente | A quién va dirigida |
| Fecha | Cuándo se creó |
| Total | Valor con IVA |
| Estado | Enviada, aceptada, convertida, etc. |
| Ítems | Cuántas líneas de producto tiene |

**Paso a paso — crear una cotización:**

1. Pulsa **Nueva cotización**.
2. Opcionalmente selecciona el **Cliente** (recomendado si luego la vas a convertir en factura).
3. En **Ítems**, agrega cada producto o servicio con su cantidad, precio e IVA %. El total con IVA se calcula abajo automáticamente.
4. Si quieres, escribe una **Nota** interna y el texto de la **Propuesta** para el cliente.
5. Pulsa **Crear cotización**.

**Paso a paso — aceptar y convertir en factura:**

1. En la fila de la cotización, pulsa el ícono de **check** para marcarla como aceptada.
2. Pulsa el ícono de **recibo** (convertir a factura) y confirma. El sistema crea la factura de venta y te muestra su número.

> Para convertir una cotización a factura debe tener un **cliente asignado**. Si no lo tiene, el sistema no la deja convertir.

---

# Contabilidad

## Resumen contable

**Dónde:** menú **Contabilidad** (ruta `/contabilidad`).

**Para qué sirve:** es el tablero de entrada. De un vistazo muestra los números contables clave del negocio y los accesos rápidos a las demás pantallas de contabilidad.

**Qué vas a ver:** cuatro indicadores principales, dos gráficos y cuatro accesos.

| Indicador | Qué significa |
| --- | --- |
| Utilidad del ejercicio | Ingresos menos costos y gastos; verde si es positiva, rojo si hay pérdida |
| Disponible (caja y bancos) | El efectivo con el que cuenta el negocio |
| Ingresos del mes | Lo facturado en el mes en curso |
| Balance de comprobación | Indica si la contabilidad está "cuadrada" o "descuadrada" |

Los gráficos muestran **ingresos vs. egresos** de los últimos seis meses y la **distribución del ingreso** (a dónde va cada peso facturado: costos, gastos y utilidad).

**Paso a paso:**

1. Revisa los cuatro indicadores para tener el panorama general.
2. Observa los gráficos para ver la tendencia de los últimos meses.
3. Usa las tarjetas de **Explorar** (abajo) para ir al plan de cuentas, los libros, los estados financieros o el mapeo de cuentas.

> Si el balance de comprobación aparece como **Descuadrado**, significa que hay que revisar los asientos del periodo. Puedes hacerlo en Libro diario y en Balance y estados.

---

## Plan de cuentas

**Dónde:** menú **Contabilidad → Plan de cuentas** (ruta `/contabilidad/plan-de-cuentas`).

**Para qué sirve:** consultar la estructura de cuentas contables del negocio, organizada según el PUC (Plan Único de Cuentas, el catálogo estándar de cuentas usado en Colombia). Cada movimiento del negocio se registra en alguna de estas cuentas.

**Qué vas a ver:** un árbol de cuentas que se despliega por niveles: **clase → grupo → cuenta → auxiliar** (de lo más general a lo más específico). Cada cuenta muestra su código y su nombre.

**Paso a paso:**

1. Haz clic en una clase para desplegar los grupos que contiene.
2. Sigue desplegando hasta llegar a la cuenta o al auxiliar que buscas.
3. Usa esta pantalla como referencia cuando debas saber qué código corresponde a cada concepto.

> Esta pantalla es principalmente de consulta: te dice cómo está organizada la contabilidad. Qué cuenta usa cada tipo de movimiento se define en **Mapeo de cuentas**.

---

## Libro diario y mayor

**Dónde:** menú **Contabilidad → Libros** (ruta `/contabilidad/libros`).

**Para qué sirve:** ver los **asientos contables** (los registros de cada operación, hechos por partida doble: siempre una parte "debe" y otra "haber" que deben sumar igual) y los movimientos de una cuenta específica.

**Qué vas a ver:** dos pestañas.

| Pestaña | Qué muestra |
| --- | --- |
| Libro diario | La lista de todos los asientos en orden, con su número y sus líneas |
| Libro mayor | Los movimientos de una sola cuenta a lo largo del tiempo, con su saldo |

**Paso a paso — consultar el libro diario:**

1. Entra a la pestaña **Libro diario**.
2. Revisa los asientos listados. Cada uno corresponde a una operación registrada.

**Paso a paso — registrar un asiento manual:**

1. En la pestaña **Libro diario**, pulsa **Nuevo asiento**.
2. Completa las líneas del asiento eligiendo las cuentas y los valores en debe y haber.
3. Guarda. El aviso confirmará que el asiento quedó registrado.

**Paso a paso — consultar el libro mayor de una cuenta:**

1. Entra a la pestaña **Libro mayor**.
2. En el desplegable, selecciona la cuenta que quieres revisar.
3. Verás todos sus movimientos y saldos.

**Paso a paso — reversar un asiento:**

1. En el libro diario, usa la opción de reversar del asiento correspondiente.
2. Confirma. El sistema crea un asiento "espejo" que anula el original, y el original queda marcado como reversado.

> Reversar no borra el asiento: crea otro que lo neutraliza, dejando el rastro completo. Es la forma correcta de corregir un asiento ya registrado.

---

## Balance y estados

**Dónde:** menú **Contabilidad → Informes** (ruta `/contabilidad/informes`).

**Para qué sirve:** ver los estados financieros del negocio: el balance de comprobación, el estado de resultados (si se ganó o se perdió) y el balance general (qué tiene y qué debe el negocio).

**Qué vas a ver:** tres pestañas.

| Pestaña | Qué muestra |
| --- | --- |
| Comprobación | El balance de comprobación: lista de cuentas con sus saldos, para verificar que todo cuadre |
| Estado de resultados | Ingresos, costos, gastos, utilidad bruta y utilidad neta del periodo, con el margen neto |
| Balance general | El activo (lo que tiene) frente al pasivo y el patrimonio (lo que debe y lo que es propio) |

**Paso a paso:**

1. Elige la pestaña según lo que necesites revisar.
2. En **Estado de resultados**, mira el resumen de la derecha para ver rápidamente ingresos, costos, utilidad y el margen neto (qué porcentaje del ingreso quedó como ganancia).
3. En **Balance general**, revisa que el activo sea igual al pasivo más el patrimonio.

> Si en el balance general aparece un aviso de que "no cuadra" (activo distinto de pasivo más patrimonio), hay que revisar los asientos del periodo en el Libro diario.

---

## Mapeo de cuentas

**Dónde:** menú **Contabilidad → Mapeo de cuentas** (ruta `/contabilidad/mapeo-cuentas`).

**Para qué sirve:** decirle al sistema **qué cuenta contable usar en cada tipo de movimiento**. Gracias a este mapeo, cuando se factura una venta, se recibe una compra o se registra un pago, la contabilidad se arma sola (contabilización automática).

**Qué vas a ver:** una tarjeta por cada tipo de movimiento, con su nombre, una breve explicación y un desplegable para asignarle una cuenta. Cada tarjeta indica si ya está **asignada** (verde) o **sin asignar** (naranja). Algunos ejemplos:

| Movimiento | Para qué se usa la cuenta |
| --- | --- |
| Cartera clientes (CxC) | Lo que el cliente queda debiendo al facturarle |
| Ingreso por ventas | El ingreso que genera cada factura |
| IVA generado | El IVA por pagar de las ventas |
| Proveedores (CxP) | Lo que se le debe a un proveedor por una compra |
| Gasto / compra | El gasto o costo por defecto de las compras |
| Banco / Caja por defecto | Las cuentas para recaudos y pagos |
| Costo de ventas e Inventario | El costo y las existencias de la mercancía |

**Paso a paso:**

1. Ubica la tarjeta del movimiento que quieres configurar.
2. Abre su desplegable y selecciona la cuenta contable correspondiente (aparecen con su código y nombre).
3. La selección se guarda al instante y la tarjeta pasa a verde (asignada).

> Si arriba aparece un aviso de mapeos faltantes, complétalos: **los documentos sin cuenta asignada no se contabilizan automáticamente** y tocaría registrarlos a mano en el libro diario.
