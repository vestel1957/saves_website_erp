# Manual de Auditoría / Consulta

Este manual está dirigido a quien necesita **mirar el sistema sin tocarlo**: revisoría fiscal,
auditoría interna, un contador externo o cualquier persona que deba verificar cifras y movimientos
sin intervenir en la operación.

Su rol es **Auditoría / Consulta** y es, por diseño, **solo lectura**: puede ver, filtrar y
descargar, pero no crear, modificar, anular ni aprobar nada. Si un botón de acción no aparece en su
pantalla, no es una falla: es su rol funcionando como debe.

## Qué alcanza a ver

| Área | Qué puede consultar |
|---|---|
| Panel ejecutivo | Indicadores del negocio: abonados, recaudo, cartera, órdenes, red |
| Reportes | Los 14 reportes: la plata, la operación y el control del personal (capítulo propio) |
| Contabilidad | Resumen contable, plan de cuentas, libros, balance y estados financieros |
| Inventario | Materiales, existencias, bodegas y el histórico de actas de traspaso |

Lo que **no** alcanza: emitir o anular facturas, mover dinero en caja, registrar asientos, despachar
inventario, cortar o reconectar servicios, y crear o modificar usuarios.

## Antes de empezar: que le habiliten las pantallas

Su rol define que usted **solo consulta**, pero no abre por sí solo las opciones del menú. Pida a
**Sistemas** que le habilite las pantallas que va a necesitar:

| Pantalla | Ruta | Para qué la necesita |
|---|---|---|
| Dashboard | `/dashboard` | El panorama general |
| Reportes | `/reportes` | Las cifras con filtro de fecha y exportación |
| Resumen contable | `/contabilidad` | Estado de la contabilidad |
| Plan de cuentas | `/contabilidad/plan-de-cuentas` | Estructura de cuentas (PUC) |
| Libro diario y mayor | `/contabilidad/libros` | Los asientos, uno por uno |
| Balance y estados | `/contabilidad/informes` | Comprobación, resultados y balance general |
| Administrar material | `/inventario` | Existencias y valor del inventario |
| Actas | `/inventario/actas` | Histórico de movimientos entre bodegas |
| Bitácora / auditoría | `/configuracion/actividad` | **El rastro de quién hizo qué** |

> La última es la más importante para su trabajo y **no viene en el rol**: pídala explícitamente. Sin
> la bitácora usted ve resultados, pero no ve responsables.

---

## Panel ejecutivo (Dashboard)

**Dónde:** menú **PRINCIPAL → Dashboard** (`/dashboard`).

**Para qué sirve:** la foto del negocio en una pantalla. Es su punto de partida para saber dónde
mirar con lupa después.

**Qué va a ver:** una franja de indicadores (abonados, activos, cartera, recaudo, órdenes abiertas,
conexiones), la gráfica de **recaudo vs. egresos** mes a mes, la **distribución de la base** de
clientes por estado, la **cartera por antigüedad** (corriente, 31-60, 61-90 y más de 90 días), la
**facturación por sede** y el **top de clientes en mora**.

**Cómo usarlo en una revisión:**

1. Lea la franja de indicadores para tener las magnitudes.
2. Mire la **cartera por antigüedad**: si el tramo de "+90 días" crece, hay un problema de cobro
   que la cifra total esconde.
3. Compare las **sedes**: una sede muy desalineada respecto a las demás merece revisión.
4. Anote los valores que va a verificar contra Reportes y Contabilidad.

> Es una pantalla de solo lectura para todos, incluso para la gerencia. Los recuadros son enlaces
> que solo llevan a ver más detalle.

---

## Reportes

Los reportes tienen **capítulo propio al final de este manual**: son 14, cada uno vive en su
propia pantalla del menú **Reportes**, y todos se filtran por periodo y se exportan a PDF o Excel.

## Contabilidad

**Dónde:** menú **CONTABILIDAD** (`/contabilidad` y sus subpantallas).

**Para qué sirve:** verificar que la operación registrada se refleje correctamente en las cuentas.

| Pantalla | Qué revisar |
|---|---|
| Resumen contable | Que el **balance de comprobación** diga "Cuadrado" |
| Plan de cuentas | La estructura de cuentas según el PUC |
| Libro diario | Los asientos del periodo, en especial los **manuales** y los **reversados** |
| Libro mayor | El movimiento y el saldo de una cuenta puntual |
| Balance y estados | Comprobación, estado de resultados y balance general |

**Paso a paso (revisión contable de un periodo):**

1. En **Resumen contable**, confirme si la contabilidad está cuadrada o descuadrada.
2. En **Balance y estados → Comprobación**, verifique que los saldos cuadren.
3. En **Balance general**, verifique que activo = pasivo + patrimonio.
4. En **Estado de resultados**, revise ingresos, costos, utilidad y margen.
5. En **Libro diario**, recorra los asientos del periodo. Preste atención a los **asientos
   manuales**: son los que no los generó el sistema, sino una persona.
6. Para cualquier cuenta que le llame la atención, use el **Libro mayor** y siga sus movimientos.

> **Los asientos no se borran, se reversan.** Un asiento reversado queda marcado como tal y con su
> asiento "espejo" al lado. Si ve muchos reversos en un periodo, vale la pena preguntar por qué.

---

## Inventario

**Dónde:** menú **INVENTARIO → Material** (`/inventario`) y **Actas** (`/inventario/actas`).

**Para qué sirve:** verificar existencias y valor del inventario, y seguir el rastro de los
movimientos entre bodegas.

**Paso a paso:**

1. En **Administrar material** revise las tarjetas de resumen: total de materiales, bodegas,
   cuántos están con **stock bajo** y el **valor total** del inventario.
2. Use los filtros por categoría y bodega para acotar lo que quiere verificar.
3. En **Actas**, recorra el histórico de traspasos: fecha, origen, destino, ítems y estado.
4. Abra un acta para ver el detalle completo: qué salió, quién lo emitió y quién lo recibió.

> Las actas son el control clave del inventario: **ningún material cambia de bodega sin dejar un
> acta**. Un traspaso "En tránsito" desde hace mucho tiempo es una señal de alerta: salió de una
> bodega y nadie confirmó que llegó a la otra.

---

## Bitácora / auditoría

**Dónde:** menú **CONFIGURACIÓN → Bitácora / auditoría** (`/configuracion/actividad`).

**Para qué sirve:** es el registro de **quién hizo qué y cuándo** en el sistema. Es la pantalla que
convierte una cifra rara en una pregunta concreta a una persona concreta.

**Cómo usarla:** cuando encuentre algo que no cuadra (una anulación, un asiento manual, un cambio de
plan, un corte fuera de lo normal), busque en la bitácora la operación por su fecha y verá el
usuario que la ejecutó, con hora exacta.

> Esta pantalla pertenece al área de Sistemas y **debe pedirse aparte**. Es la más valiosa para su
> rol.

---

## Dónde está el rastro de cada cosa

Un mapa rápido de dónde verificar cada tipo de operación:

| Lo que quiere verificar | Dónde está el rastro |
|---|---|
| Una factura anulada | La nota crédito asociada, en Facturación → Notas |
| Un asiento corregido | Su asiento de reverso, en Libro diario |
| Un movimiento de caja anulado | Tesorería → Anulaciones, con su motivo y responsable |
| Una compra aprobada | El detalle de la orden: quién la creó y **quién firmó** (una o dos firmas) |
| Material que cambió de bodega | El acta del traspaso, con emisor y receptor |
| Un equipo que salió de bodega | La transferencia de equipos: quién solicitó, despachó y recibió |
| Un corte o reconexión de servicio | La bitácora y el histórico del cliente en su ficha |
| Un cambio de permisos | La bitácora y el histórico de accesos en la ficha del empleado |

> **El principio general del sistema:** nada se borra, todo se neutraliza con un movimiento
> contrario que queda registrado. Cuando algo parece haber "desaparecido", busque el movimiento que
> lo anuló en lugar de suponer que se perdió.

## Por qué su rol es de solo lectura

No es una limitación técnica sino un control interno: quien verifica no debe poder modificar lo que
verifica. Si en algún momento necesita que se corrija algo que encontró, el camino es reportarlo al
área responsable para que ella haga el ajuste —y ese ajuste quedará, a su vez, registrado con su
autor.
