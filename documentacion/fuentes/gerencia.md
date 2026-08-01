# Manual de Gerencia

Este manual está dirigido a las personas de **Gerencia y Dirección** de Vestel: quienes necesitan ver cómo va el negocio sin entrar a registrar facturas, pagos ni órdenes. Con SAVES usted observa el estado del ISP (el proveedor de internet), compara periodos y descarga reportes para reuniones o para la contabilidad. Su perfil es de **consulta**: mira, compara y exporta; no modifica datos. Este manual explica las dos pantallas que usará a diario —el **Panel ejecutivo (Dashboard)** y los **Reportes**—, la única acción en la que usted decide (**aprobar órdenes de compra**), y al final le da una guía sencilla para interpretar los números.

> A lo largo del sistema hay tres detalles útiles: el menú lateral solo muestra lo que su usuario tiene permitido ver (si no ve una opción, es por permisos). En el celular las tablas se muestran como tarjetas, una debajo de otra, para que se lean bien. Y la campana, arriba a la derecha, muestra las alertas y avisos del sistema.

---

## Dashboard / Panel ejecutivo

**Dónde:** *Menú lateral → PRINCIPAL → Dashboard*. Es la pantalla en la que queda apenas entra al sistema.

**Para qué sirve:** Es la foto del negocio en una sola pantalla: cuántos clientes hay y en qué estado están, cuánto se ha recaudado, cuánta plata está pendiente de cobro (la cartera) y cómo se reparte el negocio entre las sedes.

**Qué vas a ver:** La pantalla se organiza de arriba hacia abajo así:

1. **Franja de indicadores (KPIs):** seis recuadros con las cifras clave. Cada recuadro es un enlace: al tocarlo lo lleva al área correspondiente para ver el detalle.

| Indicador | Qué significa |
|---|---|
| Abonados | Total de clientes registrados (un "abonado" es cada cliente con su servicio) |
| Activos | Clientes con el servicio funcionando |
| Cartera | Dinero total pendiente de cobro |
| Recaudo | Dinero efectivamente cobrado |
| Órdenes abiertas | Solicitudes de soporte sin resolver |
| Conexiones | Puertos de red en uso (una medida de la infraestructura activa) |

2. **Recaudo vs. egresos por mes:** una gráfica de líneas que compara, mes a mes, lo que entró (ingresos) contra lo que salió (egresos). La línea llena es ingresos; la línea punteada es egresos.

3. **Distribución de la base activa:** una gráfica de anillo (dona) que reparte a los clientes por estado: Activos, Cartera, Cortados, Suspendidos y Otros. En el centro aparece el total de clientes conectados.

4. **Cartera por antigüedad:** otra dona que muestra la deuda según cuántos días lleva vencida: Corriente (0 a 30 días), 31 a 60, 61 a 90 y más de 90 días (esta última es la deuda más crítica, la más difícil de recuperar).

5. **Facturación por sede:** barras que comparan cuánto ha facturado cada sede y cuántos abonados tiene.

6. **Top clientes en mora:** lista de los clientes que más deben, ordenados de mayor a menor. Cada nombre es un enlace a su ficha.

**Paso a paso (revisar el estado del negocio):**

1. Abra el Dashboard desde el menú (*PRINCIPAL → Dashboard*).
2. Lea primero la **franja de indicadores** de arriba: le da el panorama en segundos.
3. Baje a la gráfica de **Recaudo vs. egresos** para ver si el mes viene mejor o peor que los anteriores.
4. Revise las dos **donas**: en la de clientes, cuánta base está activa frente a la que está en mora o cortada; en la de cartera, cuánta deuda es reciente y cuánta lleva más de 90 días.
5. Compare las **sedes** para identificar cuál aporta más y cuál está rezagada.
6. Si algún cliente en mora le llama la atención, haga clic en su nombre para abrir su ficha.

> Esta pantalla es de solo lectura: aquí usted observa, no registra nada. Los recuadros y los nombres que son enlaces solo lo llevan a ver más detalle.

> El Dashboard resume la operación completa. Cuando necesite filtrar por fechas exactas o por sede, o descargar la información, use la pantalla de **Reportes** (siguiente sección).

---

## Reportes

Los reportes tienen **capítulo propio al final de este manual**: son 14, cada uno vive en su
propia pantalla del menú **Reportes**, y todos se filtran por periodo y se exportan a PDF o Excel.

## Aprobar órdenes de compra

Es la única acción del sistema en la que Gerencia **decide y firma**, no solo consulta.

**Dónde:** *Menú lateral → INVENTARIO → Compras → Órdenes de compra* (`/ordenes`), y luego se abre la orden concreta.

> **Importante:** el permiso de aprobación viene con el rol de Gerencia, pero la pantalla de Órdenes de compra pertenece al área de Inventario/Administración. Si usted no ve esa opción en el menú, pida a **Sistemas** que le habilite la pantalla *Órdenes de compra* en su usuario (ficha del empleado → Permisos y accesos). El permiso para firmar ya lo tiene.

**Para qué sirve:** ninguna compra queda en firme hasta que un aprobador la firma. Mientras está **Pendiente**, la orden puede editarse; una vez **Aprobada**, se congela y sigue su curso (recepción y pago).

**Las dos firmas:** el sistema tiene un **umbral en pesos** (configurable por Sistemas; por defecto **$2.000.000**).

| Total de la orden | Firmas que exige |
|---|---|
| Por debajo del umbral | Una sola firma: con su aprobación la orden queda **Aprobada** |
| Igual o mayor al umbral | **Dos firmas de personas distintas**: la suya deja la orden "en flujo" y otro aprobador debe firmar la segunda |

**Paso a paso (aprobar una orden):**

1. Entre a **Órdenes de compra** y ubique las que están en estado **Pendiente**.
2. Haga clic en la orden para abrir su detalle: proveedor, ítems, subtotal, IVA y total.
3. Revise que el proveedor, las cantidades y el total sean los correctos.
4. Pulse **Aprobar**.
5. Si la orden está por debajo del umbral, queda **Aprobada** de inmediato. Si está por encima, queda esperando la **segunda firma**: el detalle mostrará su nombre como primera firma y quedará pendiente la otra.
6. Si la orden no debe seguir, use **Cancelar** e indique el motivo.

**Captura:** ordenes-ficha — Detalle de una orden de compra: proveedor, ítems, totales y el cuadro de firmas.

> Una misma persona **no puede poner las dos firmas**: el sistema lo rechaza. Esa es justamente la protección del doble control.

> El botón **PDF** de la orden genera el documento imprimible con el **cuadro de firmas** (quién la creó, quién dio la primera firma y quién la segunda). Es el respaldo para el proveedor y para el archivo.

> Toda aprobación queda registrada con su nombre, fecha y hora en la bitácora de la orden. Si necesita revisar el histórico, use *Compras → Historial de órdenes*.

---

## Cómo leer los indicadores

Esta guía rápida le ayuda a interpretar los números sin ser experto en finanzas.

**Ingresos frente a cartera (lo cobrado frente a lo pendiente).**

- Los **ingresos** (o "recaudo") son el dinero que efectivamente entró a las cajas.
- La **cartera** es el dinero facturado que todavía no le han pagado, es decir, lo pendiente de cobro.
- La idea es que los ingresos suban y la cartera se mantenga baja. Si la cartera crece mes a mes, significa que se está facturando pero no se está cobrando al mismo ritmo: es una señal de alerta.
- En el Resumen de facturación, el "Nivel de recaudo" le dice qué porcentaje de lo facturado ya se cobró. Mientras más cerca del 100%, mejor.

**Clientes activos frente a suspendidos o cortados.**

- **Activos** son los clientes con el servicio funcionando: son los que generan ingreso.
- **Cartera** (como estado del cliente) son quienes deben pero siguen conectados.
- **Cortados** o **Suspendidos** son quienes tienen el servicio interrumpido, casi siempre por falta de pago.
- Lo sano es tener la mayor parte de la base en **Activos**. Si crece la porción de cortados y suspendidos, se está perdiendo ingreso y hay que reforzar la gestión de cobro.

**Cartera por antigüedad (qué tan vieja es la deuda).**

- Una deuda **Corriente (0 a 30 días)** es normal y fácil de recuperar.
- A medida que pasa a **31-60**, **61-90** y sobre todo a **más de 90 días**, se vuelve más difícil de cobrar.
- Vigile que la porción de "+90 días" no crezca: es la deuda más riesgosa.

**Comparar periodos (para saber si vamos mejor o peor).**

1. En Reportes, elija el indicador que quiere seguir (por ejemplo, Recaudo o Altas y retiros).
2. Con el atajo **Mes anterior**, consulte y anote (o exporte) la cifra del mes pasado.
3. Cambie al atajo **Este mes** y compare contra lo anterior.
4. Use también **Este año** para ver la tendencia larga.
5. En "Altas y retiros", el **crecimiento neto** le resume todo: si es positivo, la base de clientes crece; si es negativo, se está reduciendo.

> Una lectura rápida y saludable del negocio es: muchos clientes **Activos**, ingresos **iguales o mayores** que el mes anterior, cartera **baja** y concentrada en tramos recientes, y un crecimiento neto **positivo** en altas y retiros.
