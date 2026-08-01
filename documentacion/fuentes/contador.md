# Manual del Contador

Este manual está dirigido a la persona que lleva la **contabilidad** de Vestel. Su trabajo en
SAVES no es facturar ni recibir dinero en caja —eso lo hacen Facturación y Caja—, sino
**verificar que todo lo que pasa por el sistema quede bien registrado en las cuentas**, revisar
los libros, sacar los estados financieros y mantener el mapeo que hace que la contabilidad se
arme sola.

Su rol es el de **Contador** y le da acceso a la sección **CONTABILIDAD** del menú.

## Qué incluye y qué no incluye su rol

| Sí hace el Contador | No hace el Contador |
|---|---|
| Consultar el resumen contable y los indicadores | Emitir facturas a los clientes |
| Consultar el plan de cuentas (PUC) | Abrir o cerrar la caja del día |
| Ver el libro diario y el libro mayor | Recibir pagos o registrar recaudos |
| Registrar asientos manuales y reversarlos | Emitir facturas electrónicas ante la DIAN |
| Sacar balance de comprobación, estado de resultados y balance general | Cortar o reconectar servicios |
| Configurar el mapeo de cuentas | Crear usuarios o cambiar permisos |

> Si además de contabilidad usted debe **facturar** o manejar **factura electrónica**, su usuario
> necesita el rol de área **Contabilidad** (no solo el de Contador). En ese caso use también el
> *Manual de Contabilidad y Facturación*, que explica esas pantallas.

## Antes de empezar: que le habiliten las pantallas

El rol **Contador** define *qué puede hacer* usted en contabilidad, pero **no** abre por sí solo
las opciones del menú. Si al entrar no ve la sección **CONTABILIDAD**, pida a **Sistemas** que le
habilite estas cinco pantallas en su usuario (*Empleados → su ficha → Permisos y accesos*):

| Pantalla que debe pedir | Ruta |
|---|---|
| Resumen contable | `/contabilidad` |
| Plan de cuentas | `/contabilidad/plan-de-cuentas` |
| Libro diario y mayor | `/contabilidad/libros` |
| Balance y estados | `/contabilidad/informes` |
| Mapeo de cuentas | `/contabilidad/mapeo-cuentas` |

> Es un trámite de una sola vez. Mientras no estén habilitadas, usted entra al sistema pero el
> menú se ve vacío o muy corto: no es un error suyo ni una contraseña mal puesta.

---

## Resumen contable

**Dónde:** menú **CONTABILIDAD → Resumen contable** (`/contabilidad`).

**Para qué sirve:** es su tablero de entrada. De un vistazo le dice si la contabilidad está sana
y le da los accesos a las demás pantallas.

**Qué va a ver:** cuatro indicadores, dos gráficos y las tarjetas de acceso.

| Indicador | Qué significa |
|---|---|
| Utilidad del ejercicio | Ingresos menos costos y gastos; verde si es positiva, rojo si hay pérdida |
| Disponible (caja y bancos) | El efectivo con el que cuenta el negocio |
| Ingresos del mes | Lo facturado en el mes en curso |
| Balance de comprobación | Si la contabilidad está "cuadrada" o "descuadrada" |

Los gráficos muestran **ingresos vs. egresos** de los últimos seis meses y la **distribución del
ingreso**: a dónde se va cada peso facturado (costos, gastos y utilidad).

**Paso a paso:**

1. Revise los cuatro indicadores para tener el panorama.
2. Mire los gráficos para ver la tendencia de los últimos meses.
3. Use las tarjetas de **Explorar** para ir al plan de cuentas, los libros, los estados
   financieros o el mapeo de cuentas.

> Si el balance de comprobación aparece **Descuadrado**, es la primera alarma que debe atender:
> revise los asientos del periodo en *Libro diario* y en *Balance y estados*.

---

## Plan de cuentas

**Dónde:** menú **CONTABILIDAD → Plan de cuentas** (`/contabilidad/plan-de-cuentas`).

**Para qué sirve:** consultar la estructura de cuentas del negocio, organizada según el **PUC**
(Plan Único de Cuentas, el catálogo estándar colombiano). Todo movimiento del negocio se registra
en alguna de estas cuentas.

**Qué va a ver:** un árbol que se despliega por niveles —**clase → grupo → cuenta → auxiliar**,
de lo más general a lo más específico—, con el código y el nombre de cada cuenta.

**Paso a paso:**

1. Haga clic en una clase para desplegar sus grupos.
2. Siga desplegando hasta la cuenta o el auxiliar que busca.
3. Use esta pantalla como referencia cuando necesite saber qué código corresponde a un concepto.

> Esta pantalla le dice **cómo está organizada** la contabilidad. Qué cuenta usa cada tipo de
> movimiento se decide en **Mapeo de cuentas**, no aquí.

---

## Libro diario y mayor

**Dónde:** menú **CONTABILIDAD → Libro diario y mayor** (`/contabilidad/libros`).

**Para qué sirve:** ver los **asientos contables** —los registros de cada operación, hechos por
partida doble: siempre una parte al debe y otra al haber, que deben sumar igual— y los
movimientos de una cuenta específica. Es también donde usted registra los asientos que el
sistema no genera solo.

**Qué va a ver:** dos pestañas.

| Pestaña | Qué muestra |
|---|---|
| Libro diario | Todos los asientos en orden, con su número y sus líneas |
| Libro mayor | Los movimientos de una sola cuenta en el tiempo, con su saldo |

**Paso a paso — consultar el libro diario:**

1. Entre a la pestaña **Libro diario**.
2. Recorra los asientos listados. Cada uno corresponde a una operación registrada.

**Paso a paso — registrar un asiento manual:**

1. En la pestaña **Libro diario**, pulse **Nuevo asiento**.
2. Complete las líneas eligiendo las cuentas y los valores en **debe** y **haber**.
3. Verifique que debe y haber sumen igual.
4. Guarde. El aviso verde confirma que el asiento quedó registrado.

**Paso a paso — consultar el libro mayor de una cuenta:**

1. Entre a la pestaña **Libro mayor**.
2. En el desplegable, seleccione la cuenta que quiere revisar.
3. Verá todos sus movimientos y el saldo acumulado.

**Paso a paso — reversar un asiento:**

1. En el libro diario, use la opción de **reversar** del asiento correspondiente.
2. Confirme. El sistema crea un asiento "espejo" que lo anula, y el original queda marcado como
   reversado.

> Reversar **no borra** el asiento: crea otro que lo neutraliza y deja el rastro completo. Es la
> forma correcta de corregir un asiento ya registrado; nunca intente "arreglarlo" pisando los
> valores.

---

## Balance y estados

**Dónde:** menú **CONTABILIDAD → Balance y estados** (`/contabilidad/informes`).

**Para qué sirve:** ver los estados financieros: el balance de comprobación, el estado de
resultados (si se ganó o se perdió) y el balance general (qué tiene y qué debe el negocio).

**Qué va a ver:** tres pestañas.

| Pestaña | Qué muestra |
|---|---|
| Comprobación | Lista de cuentas con sus saldos, para verificar que todo cuadre |
| Estado de resultados | Ingresos, costos, gastos, utilidad bruta y neta del periodo, con el margen |
| Balance general | El activo frente al pasivo y el patrimonio |

**Paso a paso:**

1. Elija la pestaña según lo que necesite revisar.
2. En **Estado de resultados**, el resumen de la derecha le da rápidamente ingresos, costos,
   utilidad y margen neto (qué porcentaje del ingreso quedó como ganancia).
3. En **Balance general**, verifique que el activo sea igual al pasivo más el patrimonio.

> Si el balance general muestra el aviso de que "no cuadra" (activo distinto de pasivo más
> patrimonio), hay asientos del periodo por revisar en el **Libro diario**.

---

## Mapeo de cuentas

**Dónde:** menú **CONTABILIDAD → Mapeo de cuentas** (`/contabilidad/mapeo-cuentas`).

**Para qué sirve:** decirle al sistema **qué cuenta contable usar en cada tipo de movimiento**.
Es la pantalla que hace que la contabilidad se arme sola: gracias a este mapeo, cuando se factura
una venta, se recibe una compra o se registra un pago, el asiento se genera automáticamente.

**Qué va a ver:** una tarjeta por cada tipo de movimiento, con su nombre, una explicación breve y
un desplegable para asignarle la cuenta. Cada tarjeta indica si está **asignada** (verde) o **sin
asignar** (naranja).

| Movimiento | Para qué se usa la cuenta |
|---|---|
| Cartera clientes (CxC) | Lo que el cliente queda debiendo al facturarle |
| Ingreso por ventas | El ingreso que genera cada factura |
| IVA generado | El IVA por pagar de las ventas |
| Proveedores (CxP) | Lo que se le debe a un proveedor por una compra |
| Gasto / compra | El gasto o costo por defecto de las compras |
| Banco / Caja por defecto | Las cuentas para recaudos y pagos |
| Costo de ventas e Inventario | El costo y las existencias de la mercancía |

**Paso a paso:**

1. Ubique la tarjeta del movimiento que quiere configurar.
2. Abra su desplegable y seleccione la cuenta contable (aparecen con código y nombre).
3. La selección se guarda al instante y la tarjeta pasa a verde.

> **Esta es la pantalla más delicada de su rol.** Un mapeo mal puesto no da error: simplemente
> manda los movimientos a la cuenta equivocada, y el problema se descubre semanas después al
> cuadrar. Revise las tarjetas en naranja antes de cada cierre de mes.

---

## Rutina sugerida de cierre de mes

Una secuencia práctica para cerrar el mes sin sorpresas:

1. **Mapeo de cuentas:** confirme que no queda ninguna tarjeta en **naranja** (sin asignar).
2. **Resumen contable:** verifique que el balance de comprobación diga **Cuadrado**.
3. **Libro diario:** revise los asientos del periodo, en especial los manuales.
4. **Balance y estados → Comprobación:** confirme que los saldos cuadran.
5. **Estado de resultados:** revise ingresos, costos y utilidad del mes; compare el margen contra
   el mes anterior.
6. **Balance general:** confirme que activo = pasivo + patrimonio.
7. Si algo no cuadra, vuelva al **Libro diario** y ubique el asiento que descompensa; corríjalo
   **reversándolo** y registrando el correcto.

> Los reportes de **IVA** (base gravable, base exenta e IVA, en ventas y en compras) no están en
> Contabilidad sino en *PRINCIPAL → Reportes*, con filtro de fechas y exportación a Excel y PDF.
> Si necesita esa pantalla, pídala a Sistemas junto con las cinco de contabilidad.

---

## Nómina

El rol de Contador contempla también la operación de **nómina** (conceptos, contratos, periodos,
novedades y desprendibles). **Ese módulo todavía no tiene pantallas en el sistema:** los permisos
están creados pero no hay aún una sección de nómina en el menú.

Mientras se construya, la nómina se lleva por fuera de SAVES. Cuando el módulo se habilite, esta
sección del manual se ampliará con su paso a paso.

---

## Límites de su rol (y por qué existen)

- **No puede crear usuarios ni cambiar permisos.** Eso es exclusivo del Superadministrador, para
  que nadie se amplíe el acceso a sí mismo.
- **No puede borrar asientos.** Solo reversarlos. Así la contabilidad conserva el rastro completo,
  que es lo que exige una auditoría.
- **No factura ni maneja caja.** La separación entre quien registra el dinero y quien lo
  contabiliza es un control interno, no una limitación técnica.
- **Todo lo que usted haga queda en la bitácora** con su nombre, fecha y hora
  (*Configuración → Bitácora / auditoría*, si tiene acceso).
