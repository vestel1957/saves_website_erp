# Manual del Jefe de Bodega

Este manual está dirigido a la persona que **responde por el inventario** de Vestel: el material
(cables, conectores, consumibles) y los equipos que se instalan en casa del cliente (ONU, routers,
CPE). Usted es quien sabe qué hay, cuánto hay, dónde está y a quién se le entregó.

Su rol es **Jefe de bodega** y es el **único rol con control total del inventario**. También es el
único autorizado para **despachar equipos** hacia otra bodega o hacia un técnico: los demás roles
pueden *pedir*, pero la salida la aprueba usted.

## Qué le corresponde a usted

| Tarea | Quién la hace |
|---|---|
| Crear, editar y dar de baja material | **Usted** |
| Crear categorías y bodegas de material | **Usted** |
| Emitir traspasos de material entre bodegas | **Usted** |
| Registrar equipos nuevos e imprimir su etiqueta QR | **Usted** |
| **Aprobar y despachar** una transferencia de equipos | **Solo usted** |
| Rechazar una transferencia con su motivo | **Solo usted** |
| Recibir lo que llega de una orden de compra | **Usted** |
| Devolver material a un proveedor | **Usted** |
| *Solicitar* una transferencia de equipos | El técnico |
| *Confirmar la recepción* en la sede destino | Caja / la sede que recibe |
| *Aprobar* la orden de compra (la firma) | Gerencia |

## Antes de empezar: que le habiliten las pantallas

Su rol define *qué puede hacer*, pero **no** abre por sí solo las opciones del menú. Si al entrar
no ve la sección **INVENTARIO** completa, pida a **Sistemas** que le habilite estas pantallas en su
usuario (*Empleados → su ficha → Permisos y accesos*):

| Grupo | Pantallas |
|---|---|
| Material | Administrar material, Categorías, Bodegas, Traspasos, Actas |
| Equipos | Administrar equipos, Bodega de equipos, **Transferencias de equipos** |
| Compras | Órdenes de compra, Historial de órdenes |
| Otros | Devoluciones, Proveedores |

> La más importante de pedir es **Transferencias de equipos**: es donde vive la función que solo
> usted puede ejecutar. Sin esa pantalla, las transferencias se quedan atascadas en "Pendiente"
> porque nadie más puede despacharlas.

---

## Administrar material

**Dónde:** menú **INVENTARIO → Material → Administrar material** (`/inventario`).

**Para qué sirve:** es el inventario de materiales: qué hay, cuánto hay, en qué bodega y su valor.
Aquí crea, edita y da de baja materiales.

**Qué va a ver:** arriba, tarjetas de resumen (total de materiales, categorías, bodegas, cuántos
están con stock bajo y el valor total del inventario). Luego filtros por texto, categoría y bodega,
y un botón **Solo stock bajo** para ver únicamente lo que está por agotarse.

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

1. Pulse **Nuevo material**.
2. Escriba el **Nombre** (obligatorio). Opcionalmente el código y la categoría.
3. Elija la **Bodega** donde entra el material.
4. Escriba el precio, el costo y el IVA (%) si aplica.
5. Indique el **Stock** inicial y, si quiere, un valor de **Alerta stock** para que el sistema le
   avise cuando quede poco.
6. Agregue una descripción si la necesita y pulse **Crear**.

**Paso a paso (editar un material):**

1. Pulse el lápiz de la fila.
2. Cambie los datos y guarde con **Guardar cambios**.

> Al editar, la bodega **no** se puede cambiar directamente: para mover material a otra bodega debe
> hacer un **Traspaso**, que deja el acta del movimiento. Es a propósito: así ningún material se
> "teletransporta" sin dejar rastro.

> Puede cargar muchos materiales de una vez con **Importar Excel** (archivo .xlsx).

> Eliminar un material es **definitivo** y no se puede deshacer. Si solo se agotó, deje el stock en
> cero en lugar de borrarlo: perdería el histórico.

---

## Categorías de material

**Dónde:** menú **INVENTARIO → Material → Categorías** (`/inventario/categorias`).

**Para qué sirve:** organiza el inventario en grupos (por ejemplo "Consumibles", "Herramienta").

**Qué va a ver:** una tarjeta por categoría, con su nombre, cuántos materiales tiene y el valor de
esos materiales, con botones de editar y eliminar. Al hacer clic en el nombre ve sus materiales.

**Paso a paso (crear o editar una categoría):**

1. Pulse **Nueva categoría** (o el lápiz de una existente).
2. Escriba el **Nombre** y, si quiere, una nota.
3. Pulse **Guardar**.

> Una categoría no se puede eliminar mientras tenga materiales asociados. Primero mueva o quite
> esos materiales.

---

## Bodegas de material

**Dónde:** menú **INVENTARIO → Material → Bodegas** (`/inventario/bodegas`).

**Para qué sirve:** son los almacenes donde se guarda el material. Cada bodega puede representar la
bodega central o el stock de una sede.

**Qué va a ver:** una tabla con las bodegas, su referencia, cuántos materiales tienen y su valor.
Al hacer clic en una fila ve el detalle de esa bodega.

**Paso a paso (crear o editar una bodega):**

1. Pulse **Nueva bodega** (o el lápiz de una existente).
2. Escriba el **Nombre** (obligatorio) y una referencia o nota si quiere.
3. Pulse **Crear** o **Guardar cambios**.

> Una bodega solo se puede eliminar si no tiene material adentro.

---

## Traspasos de material

**Dónde:** menú **INVENTARIO → Material → Traspasos** (`/inventario/traspasos`).

**Para qué sirve:** mover material de una bodega a otra dejando constancia. El material sale de la
bodega origen y queda **en tránsito** hasta que alguien confirme la recepción en el destino; cada
movimiento genera un **acta**.

**Qué va a ver:** un botón **Nuevo traspaso** y la lista de actas con fecha, origen, destino,
cuántos ítems y unidades, quién recibe y el estado (Emitida, En tránsito, Recibida). Puede buscar
por bodega o responsable y filtrar por estado.

**Paso a paso (crear un traspaso):**

1. Pulse **Nuevo traspaso**.
2. Elija la **Bodega origen** y la **Bodega/sede destino**. Deben ser distintas.
3. Opcionalmente, elija **quién recibe** (la persona que confirmará la llegada).
4. En la lista de materiales, marque cada material a mover y ajuste la **cantidad** (por defecto se
   mueve todo lo disponible; no puede poner más de lo que hay). Use el filtro para encontrarlo.
5. Revise el resumen (ítems, unidades y valor) y agregue observaciones si quiere.
6. Pulse **Emitir traspaso**. El material queda en tránsito.

**Captura:** inventario-traspasos-nuevo — Formulario de **Nuevo traspaso**: bodega origen, destino y materiales a mover.

**Paso a paso (recibir un traspaso):**

1. Abra el acta desde la lista (botón **Ver**).
2. Si usted es la persona designada para recibir, marque cada material a medida que lo recibe, o
   use **Recibir todo** para confirmar todos de una vez.
3. Al confirmar, el stock entra a la bodega destino.

> Solo la persona **designada como receptora** puede confirmar la recepción de ese traspaso. Si
> designó a alguien y esa persona no está, tendrá que emitir el traspaso de nuevo con el receptor
> correcto.

---

## Actas

**Dónde:** menú **INVENTARIO → Material → Actas** (`/inventario/actas`).

**Para qué sirve:** es el historial completo de las actas de traspaso de material entre bodegas.
Es su herramienta para responder "¿cuándo salió esto y quién lo recibió?".

**Qué va a ver:** una tabla con fecha, origen, destino, cantidad de ítems, observaciones y estado
(Recibida en verde). Al hacer clic en una fila se abre el detalle del acta.

**Paso a paso (consultar un acta):**

1. Recorra la lista o use la paginación para encontrar el acta.
2. Haga clic en la fila para ver el detalle completo.
3. Si necesita registrar un traspaso nuevo, el botón **Nuevo traspaso** lo lleva a esa pantalla.

---

## Administrar equipos

**Dónde:** menú **INVENTARIO → Equipos → Administrar equipos** (`/red/equipos`).

**Para qué sirve:** el inventario de equipos que se instalan en casa del cliente (ONU, routers,
CPE). Aquí busca un equipo, ve dónde está (bodega o cliente), registra uno nuevo e imprime su
etiqueta con código QR.

**Qué va a ver:**

| Columna | Qué significa |
|---|---|
| Código | Código interno del equipo |
| Marca / MAC / Serial | Datos de identificación |
| Almacén | En qué bodega está |
| Asignado a | El cliente que lo tiene (o "— disponible") |
| ACS | Si está administrado por GenieACS |
| Estado | Disponible, Asignado o Instalado |

**Paso a paso:**

1. Busque por **código, MAC, serial o marca**. También puede filtrar por **asignados/disponibles**
   y por **almacén**.
2. Para registrar un equipo nuevo, pulse **Nuevo equipo** y llene el formulario.
3. Para imprimir la etiqueta con QR, pulse **Etiqueta** en su fila. Al escanear ese QR, el sistema
   busca el equipo por su código automáticamente.

> Etiquetar el equipo al ingresarlo es lo que después permite encontrarlo en segundos. Un equipo
> sin etiqueta obliga a buscar por serial a mano.

---

## Bodega de equipos

**Dónde:** menú **INVENTARIO → Equipos → Bodega de equipos** (`/red/bodegas`).

**Para qué sirve:** ver los almacenes de equipos por sede y cuántos equipos hay en cada uno.

**Qué va a ver:** arriba, el total de equipos en bodega y el número de bodegas. Debajo, la lista de
bodegas con nombre, descripción y cuántos equipos tiene cada una.

**Paso a paso:**

1. Revise la lista de bodegas.
2. Haga clic en una fila (**Ver equipos**) para entrar y ver los equipos que contiene.

---

## Transferencias de equipos — su función exclusiva

**Dónde:** menú **INVENTARIO → Equipos → Transferencias de equipos** (`/red/transferencias`).

**Para qué sirve:** mover equipos de una bodega a otra (o hacia el técnico). El movimiento tiene
**tres pasos y tres responsables distintos**: alguien **solicita**, usted **despacha**, y la sede
destino **confirma la recepción**.

| Paso | Quién lo hace | Qué pasa con los equipos |
|---|---|---|
| 1. Solicitar | El técnico o la sede que necesita el equipo | La transferencia queda **Pendiente** |
| 2. Aprobar y despachar | **Usted, el Jefe de bodega** | Los equipos **salen** de origen y quedan **En tránsito** |
| 3. Confirmar recepción | La sede destino (caja) | Los equipos **entran** a la bodega destino |

**Qué va a ver:**

| Columna | Qué significa |
|---|---|
| Fecha | Cuándo se solicitó |
| Origen → Destino | De qué bodega a qué bodega |
| # Equipos | Cuántos equipos incluye |
| Solicita | Quién la pidió |
| Estado | Pendiente, En tránsito, Recibida o Rechazada |

**Paso a paso (despachar una transferencia):**

1. Filtre o ubique las transferencias en estado **Pendiente**: son las que lo están esperando.
2. Pulse **Ver** en la fila. Se abre el detalle con el flujo completo: quién la solicitó, quién la
   despachó y quién la recibió.
3. Verifique que los equipos listados **estén realmente en la bodega origen** y que el destino sea
   el correcto.
4. Pulse **Aprobar y despachar**. Los equipos salen de la bodega origen y quedan En tránsito.
5. Entregue físicamente los equipos. La sede destino confirmará la recepción y el estado pasará a
   **Recibida**.

**Paso a paso (rechazar una transferencia):**

1. Abra el detalle con **Ver**.
2. Pulse **Rechazar** e **indique el motivo** (por ejemplo: "el equipo ya está asignado a un
   cliente" o "no hay existencia en la bodega origen").
3. La transferencia queda **Rechazada** y los equipos no se mueven.

> Despachar **mueve el inventario de verdad**. Si aprueba una transferencia de equipos que no
> entregó físicamente, el sistema y la bodega quedan descuadrados y nadie más lo va a notar hasta
> el siguiente conteo. Despache solo cuando el equipo salga.

> Si una transferencia lleva días **Pendiente**, es porque nadie la ha despachado. Revise esta
> pantalla a diario: es el cuello de botella que depende únicamente de usted.

---

## Recibir lo que llega de una compra

**Dónde:** menú **INVENTARIO → Compras → Órdenes de compra** (`/ordenes`), y luego se abre la orden.

**Para qué sirve:** registrar la **entrada física** de lo comprado. La orden la crea y la firma
otro (Administración la registra, Gerencia la aprueba); a usted le corresponde confirmar qué llegó.

**Paso a paso (registrar la recepción):**

1. Abra la orden desde la lista (clic en su número).
2. En la sección **Recibir**, escriba **cuánto llegó de cada ítem**.
3. Pulse **Registrar recepción**.
4. Si llegó solo una parte, registre lo que llegó: la recepción **parcial** está permitida y podrá
   completarla después cuando llegue el resto.

> Reciba **contra la mercancía física**, no contra el papel de la orden. Lo que usted registre aquí
> es lo que el sistema va a creer que existe en bodega.

> El **pago** al proveedor y las **notas** (crédito, débito, retenciones) no le corresponden a
> usted: los registra Administración o Contabilidad desde la misma orden.

---

## Devoluciones a proveedor

**Dónde:** menú **INVENTARIO → Devoluciones** (`/devoluciones`).

**Para qué sirve:** registrar la devolución de material a un proveedor (producto defectuoso, de
más o equivocado).

**Qué va a ver:** tarjetas con el total de devoluciones y el monto acumulado, un buscador (por
número o proveedor) y un filtro por estado (Borrador, Pendiente, Aprobada, Completada, Anulada).
La tabla muestra número, proveedor, fecha, total, estado y cantidad de ítems.

**Paso a paso (crear una devolución):**

1. Pulse **Nueva devolución**.
2. Busque y seleccione el **proveedor**.
3. En **Materiales**, busque cada material a devolver y haga clic para agregarlo a la lista.
4. Ajuste la **cantidad** y el **precio** de cada material; el total se calcula solo.
5. Indique la **fecha** y una nota con el motivo.
6. Pulse **Crear devolución**.

> Escriba siempre el motivo. Cuando el proveedor discuta la devolución tres semanas después, esa
> nota es la única prueba de por qué se devolvió.

---

## Proveedores

**Dónde:** menú **INVENTARIO → Proveedores** (`/proveedores`).

**Para qué sirve:** el directorio de proveedores. Separa proveedores de **Productos** y de
**Servicios**, guarda sus datos y su estado de cuenta.

**Qué va a ver:** dos pestañas (**Productos** y **Servicios**), un buscador (por nombre, NIT o
ciudad) y una tabla con nombre, NIT, teléfono, ciudad, banco y número de órdenes. Cada fila tiene
tres botones: estado de cuenta, editar y eliminar.

**Paso a paso (ver el estado de cuenta de un proveedor):**

1. Pulse el ícono de estado de cuenta en la fila del proveedor.
2. Verá el total comprado, lo pagado y el saldo, además de la lista de órdenes y de pagos.

> Un proveedor solo se puede eliminar si no tiene órdenes ni devoluciones asociadas.

---

## Rutina diaria sugerida

1. **Transferencias de equipos:** revise las **Pendientes** y despache o rechace. Es lo único que
   nadie más puede hacer por usted.
2. **Material → Solo stock bajo:** mire qué está por agotarse y avise a Administración para que
   genere la orden de compra.
3. **Órdenes de compra:** registre la recepción de lo que llegó ese día.
4. **Traspasos:** confirme lo que llegó de otras bodegas y emita lo que deba salir.
5. **Actas:** úselas cuando alguien pregunte por un movimiento pasado.

## Límites de su rol (y por qué existen)

- **Su control total es del inventario, no del sistema.** El rol de Jefe de bodega no le da acceso
  a nómina, recursos humanos, facturación ni configuración. Es a propósito.
- **No aprueba las órdenes de compra.** Usted recibe la mercancía; la firma de la compra es de
  Gerencia. Quien pide, quien aprueba y quien recibe deben ser personas distintas.
- **No confirma la recepción de sus propios despachos.** Eso lo hace la sede destino, y es lo que
  hace que el traslado tenga dos testigos.
- **Todo queda registrado con su nombre**, fecha y hora: despachos, rechazos, recepciones y
  eliminaciones.
