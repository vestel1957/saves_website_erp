# Reportes

Los reportes son las **preguntas que el sistema ya sabe responder**: cuánto se facturó, quién debe, cuánto recaudó cada cajero, cuántos clientes se fueron el mes pasado. No hay que pedirle nada a nadie ni exportar la base de datos: se abre el reporte, se elige el periodo y ahí está la cifra.

**Dónde:** menú **Reportes → Todos los reportes** (ruta `/reportes`).

**Para qué sirve:** es el mapa. Muestra los 14 reportes agrupados por a quién le sirven, con una línea que explica qué contesta cada uno. Desde aquí se entra a cualquiera.

Los tres grupos son:

- **Gerencia** — la plata: facturación, recaudo, cartera e impuestos.
- **Operación** — el servicio: órdenes, cortes y estado de la base de clientes.
- **Personal** — la gente: rendimiento, recaudo por funcionario y control.

## Cómo funciona cualquier reporte

Las 14 pantallas se manejan igual. Aprendida una, están aprendidas todas.

1. **Elige el periodo.** Arriba hay dos fechas, **Desde** y **Hasta**, y tres atajos: *Este mes*, *Mes anterior* y *Este año*. Algunos reportes (cartera, estado de clientes, resumen de facturación) muestran la foto de hoy y por eso no piden fechas.
2. **Afina con los filtros extra**, si el reporte los tiene: sede, caja, método de pago, funcionario, módulo. Las opciones salen de los datos reales del periodo, así que nunca vas a elegir algo que dé cero.
3. **Lee el resultado.** Arriba van los totales grandes y abajo el detalle en tablas.
4. **Llévatelo** con el botón **Exportar** de la esquina superior derecha: **PDF (imprimir)** para archivar o firmar, **Excel (.xls)** para seguir trabajando la cifra.

> Los reportes solo **leen**. Nada de lo que hagas aquí cambia una factura, un pago o un cliente: puedes abrirlos y filtrarlos con toda confianza.

> Un reporte muestra únicamente los datos que tu usuario tiene permitido ver. Si dos personas abren el mismo reporte y ven cifras distintas, casi siempre es diferencia de permisos o de sede, no un error del sistema.

## Gerencia — la plata

### Resumen de facturación

**Dónde:** menú **Reportes → Gerencia → Resumen de facturación** (ruta `/reportes/facturacion`).

**Qué contesta:** cuánto se facturó, cuánto de eso ya se pagó y cuánta cartera quedó pendiente.

Es la foto de hoy, no de un periodo: sirve para saber en qué punto está el mes. Compara siempre las tres cifras juntas — facturado alto con recaudo bajo significa cartera creciendo, aunque el mes "se vea bien".

### Recaudo

**Dónde:** menú **Reportes → Gerencia → Recaudo** (ruta `/reportes/recaudo`).

**Qué contesta:** cuánto dinero entró de verdad en el periodo, abierto por **caja** y por **método de pago** (efectivo, transferencia, Efecty…).

Solo cuenta los ingresos **vigentes**: lo anulado no suma. Es el reporte para responder "¿cuánto entró este mes?" sin discusión.

### Ventas por sede

**Dónde:** menú **Reportes → Gerencia → Ventas por sede** (ruta `/reportes/ventas-sede`).

**Qué contesta:** cuánto facturó cada sede en el periodo.

Sirve para comparar puntos entre sí y para detectar la sede que dejó de facturar sin que nadie lo reportara.

### Ingresos y egresos

**Dónde:** menú **Reportes → Gerencia → Ingresos y egresos** (ruta `/reportes/ingresos-egresos`).

**Qué contesta:** el balance mes a mes — qué entró, qué salió y qué quedó.

Es la vista de tendencia: un mes malo suelto no dice nada, tres meses seguidos con el saldo cayendo sí.

### Cartera / deudores

**Dónde:** menú **Reportes → Gerencia → Cartera / deudores** (ruta `/reportes/cartera`).

**Qué contesta:** qué clientes deben más y cuántas facturas tienen en mora.

Es la lista de trabajo de cobranza: se empieza por arriba. Antes de llamar, conviene mirar la ficha del cliente para no cobrarle a alguien que ya pagó por otro canal.

### Reporte de IVA

**Dónde:** menú **Reportes → Gerencia → Reporte de IVA** (ruta `/reportes/iva`).

**Qué contesta:** base gravable, base exenta e IVA documento por documento, para armar la declaración.

Tiene un filtro de **Tipo**: *Ventas* (lo que facturamos) o *Compras* (lo que nos facturaron). Exporta a Excel y entrégalo al contador tal cual: cada fila conserva el número de documento para poder rastrearla.

## Operación — el servicio

### Órdenes de servicio

**Dónde:** menú **Reportes → Operación → Órdenes de servicio** (ruta `/reportes/ordenes`).

**Qué contesta:** cuántas órdenes hubo en el periodo, en qué estado están, de qué tipo son y a qué técnico se asignaron.

Sirve para ver la carga real del equipo y para encontrar las órdenes que llevan días abiertas.

### Cortes y activaciones

**Dónde:** menú **Reportes → Operación → Cortes y activaciones** (ruta `/reportes/cortes-activaciones`).

**Qué contesta:** cuántos clientes se cortaron, se activaron, se suspendieron o se retiraron en el periodo.

Es el termómetro del corte por mora: si los cortes suben y las reconexiones no, el problema dejó de ser de cobranza y pasó a ser de retención.

### Estado de clientes

**Dónde:** menú **Reportes → Operación → Estado de clientes** (ruta `/reportes/estado-clientes`).

**Qué contesta:** cómo está repartida la base de clientes por estado (activo, suspendido, retirado) y por sede.

Es la foto de hoy. Sirve para saber cuántos clientes activos hay de verdad, que casi nunca es el número que la gente recuerda.

### Altas y retiros

**Dónde:** menú **Reportes → Operación → Altas y retiros** (ruta `/reportes/altas-retiros`).

**Qué contesta:** cuántos clientes nuevos entraron contra cuántos se fueron.

La cifra que importa no es ninguna de las dos por separado, sino la resta: si entran 30 y se van 28, el mes fue plano aunque ventas reporte 30 altas.

## Personal — la gente

### Rendimiento de técnicos

**Dónde:** menú **Reportes → Personal → Rendimiento de técnicos** (ruta `/reportes/tecnicos`).

**Qué contesta:** la **re-visita** de cada técnico de campo — cuántos de sus trabajos obligaron a volver a la misma vivienda dentro de los 15 días siguientes — además de cumplimiento y carga.

Tiene filtros de **Sede**, **Tipo de orden** y **Prioridad**. Mide calidad, no volumen: el técnico que cierra muchas órdenes y vuelve a la mitad de ellas está trabajando peor que el que cierra menos y no vuelve.

> No lo uses como ranking sin mirar el tipo de orden. Un técnico asignado siempre a los casos difíciles va a tener más re-visita que uno que solo hace instalaciones nuevas.

### Recaudo por funcionario

**Dónde:** menú **Reportes → Personal → Recaudo por funcionario** (ruta `/reportes/recaudo-funcionario`).

**Qué contesta:** cuánto recaudó cada persona, abierto por caja y por método de pago.

Tiene filtros de **Método** y **Caja**. Es el reporte de cierre de mes para comisiones y para cuadrar quién movió qué.

### Anulaciones (control)

**Dónde:** menú **Reportes → Personal → Anulaciones (control)** (ruta `/reportes/anulaciones`).

**Qué contesta:** quién anuló qué, por cuánto, y **cuántos días después del cobro** lo anuló.

Tiene filtro por **Funcionario**. La columna de los días es la importante: anular el mismo día es corregir un error de digitación; anular un cobro de hace tres semanas es otra cosa y merece una explicación.

> Este reporte es de control interno. Revísalo con periodicidad fija —no solo cuando ya hay una sospecha— y deja constancia de lo revisado.

### Actividad en el sistema

**Dónde:** menú **Reportes → Personal → Actividad en el sistema** (ruta `/reportes/actividad`).

**Qué contesta:** qué se tocó en el sistema, por quién y en qué módulo.

Tiene filtros de **Usuario**, **Módulo** y **Operación**. Es el rastro de auditoría: sirve para reconstruir qué pasó con un registro concreto cuando nadie recuerda haberlo cambiado.
