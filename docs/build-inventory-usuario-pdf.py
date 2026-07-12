#!/usr/bin/env python3
"""Genera el MANUAL DE USO (paso a paso, orientado al usuario final) del modulo de
Inventario, con la paleta y el diseno de marca BHDC. A diferencia del manual de modulo
(que explica como funciona por dentro), este explica como OPERAR cada pantalla: que ve
el usuario, que botones hay, que campos pide cada formulario y el paso a paso de las
tareas tipicas."""
import base64
import re
from pathlib import Path

import markdown
from weasyprint import HTML

ROOT = Path("/home/dev/nexus-erp")
LOGO = ROOT / "LOGO BHDC Completo.png"
OUT = ROOT / "docs" / "Manual-Inventario-Usuario-BHDC.pdf"

# --- Paleta de marca BHDC (de frontend/src/app/globals.css) ---
BRAND, BRAND_HOVER, BRAND_SOFT = "#ea580c", "#c2410c", "#ffedd5"
GOLD, GOLD_SOFT = "#f2ae2e", "#fdf3da"
RED = "#bf303c"
INK, INK_2, INK_3 = "#0f172a", "#475569", "#64748b"
BORDER, CANVAS, SURFACE = "#dbe2ea", "#eef1f6", "#f7f9fc"

logo_b64 = base64.b64encode(LOGO.read_bytes()).decode()
md = markdown.Markdown(extensions=["tables", "sane_lists", "fenced_code"])

EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF\U00002B00-\U00002BFF\U0000FE0F\U000020E3]",
    flags=re.UNICODE,
)
clean = lambda s: EMOJI.sub("", s)

# ============================================================================
#  CONTENIDO — una pantalla / tarea por seccion, en lenguaje de usuario
# ============================================================================
SECTIONS = [

("Primeros pasos", r"""
# Primeros pasos

Bienvenido al modulo de **Inventario** de BHDC. Esta guia explica, pantalla por pantalla,
como hacer el trabajo diario de la bodega: registrar productos, controlar existencias,
comprar, recibir, ajustar, entregar material y dar mantenimiento.

## Como entrar
1. Abre el sistema en tu navegador e inicia sesion con tu **correo y contrasena**.
2. Al entrar caes directamente en el **Resumen** de tu area (no hay un panel general).
3. En el menu lateral izquierdo encuentras la seccion **INVENTARIO** con todas las
   pantallas. En el celular, el menu se abre con el boton de las tres rayas.

## Que veras segun tu rol
No todos ven lo mismo: el sistema **oculta** las pantallas y botones para los que no
tienes permiso. Si no ves un boton (por ejemplo "Nuevo producto"), es que tu rol no
incluye esa accion. Habla con el administrador si necesitas mas acceso.

| Rol tipico | Que hace |
|---|---|
| **Jefe de bodega** | Control total: catalogo, existencias, compras, ajustes, custodia de material |
| **Tecnico de mantenimiento** | Ejecuta las ordenes de trabajo que le asignan |
| **Consulta / auxiliar** | Solo mira existencias, kardex y reportes |

## Cosas que se repiten en todas las pantallas
- **Buscador:** casi toda lista tiene una lupa para filtrar por nombre o codigo (SKU).
- **Tablas en el celular:** en pantalla pequena las tablas se ven como **tarjetas**
  apiladas, con cada dato en su renglon. Todo funciona igual que en computador.
- **Mensajes:** al guardar veras un aviso **verde** con un visto bueno si todo salio
  bien, o **rojo** si hubo un error (el formulario queda abierto para corregir).
- **La campana** (arriba a la derecha) te avisa cuando un producto esta agotado o por
  debajo del minimo. Ver la seccion *Alertas y la campana*.

> **Regla de oro:** el inventario refleja la realidad fisica. Todo movimiento (entrada,
> salida, traslado, ajuste, consumo) se registra en el sistema para que las existencias y
> su valor esten siempre cuadrados y auditables.
"""),

("Resumen de inventario", r"""
# Resumen de inventario

**Donde:** Inventario -> **Resumen**  ·  Necesitas: ver existencias

Es la pantalla de entrada de la bodega: un tablero con los numeros clave del inventario,
calculados en vivo a partir de los movimientos reales.

## Que muestra
Una fila de indicadores (tarjetas) con lo importante del dia:

| Indicador | Que significa |
|---|---|
| **Valor del inventario** | Cuanto vale todo lo que tienes en bodega (existencias x costo promedio) |
| **Stock disponible** | Unidades totales listas para usar |
| **Productos agotados** | Cuantos articulos estan en cero (en rojo si hay) |
| **Bajo minimo** | Articulos por debajo de su punto de reorden (en rojo si hay) |
| **Sin movimiento** | Productos quietos, sin salidas en el periodo |
| **Ordenes abiertas** | Ordenes de compra pendientes de recibir |
| **Recepciones / ajustes** | Actividad reciente de la bodega |

## Como usarlo
- Revisalo al empezar el dia para ver de un vistazo que necesita atencion.
- Si "Productos agotados" o "Bajo minimo" estan en rojo, ve a **Limites y reorden** para
  ver que comprar.
- Es una pantalla de **consulta**: no se registra nada aqui, solo se mira.
"""),

("Catalogo de productos", r"""
# Catalogo de productos

**Donde:** Inventario -> **Productos** (pestana *Productos*)  ·  Necesitas: ver productos
(para crear/editar: administrar productos)

Es el maestro de articulos. Antes de mover stock, el producto debe existir aqui. La
pantalla agrupa cuatro pestanas: **Productos**, **Categorias**, **Marcas** y **Unidades**.

## Lo que ves en la tabla
| Columna | Que es |
|---|---|
| SKU | Codigo unico del producto (ej. `BRC-001`) |
| Producto | Nombre del articulo |
| Tipo | Fisico, materia prima, consumible, **repuesto**, herramienta, activo… |
| Categoria / Unidad | Clasificacion y unidad de medida |
| Existencias | Cuanto hay en mano (en rojo si esta en cero o negativo) |
| Costo prom. | Costo promedio que mantiene el sistema solo |
| Ingreso | Fecha de entrada al inventario |
| Estado | Activo o Inactivo |

Arriba tienes un **buscador** (por SKU o nombre), un filtro por **fecha de ingreso** y el
boton **Nuevo producto**. La lista esta paginada y las columnas se pueden ordenar haciendo
clic en su titulo.

## Crear un producto — paso a paso
1. Clic en **Nuevo producto**.
2. Llena los datos. Los unicos **obligatorios** son **SKU** y **Nombre**:
   - **SKU** (ej. `BRC-001`) y **Nombre**.
   - **Tipo** (por defecto Consumible), **Categoria**, **Marca**, **Unidad de medida**.
   - **Fecha de ingreso** (por defecto hoy).
   - **Codigo interno** y **Codigo de barras** (opcionales).
   - **Metodo de costeo** (por defecto Promedio ponderado) y **Costo estandar**.
   - **Descripcion** libre.
   - **Controlar por numero de serie:** marcalo para equipos/herramientas que se siguen
     unidad por unidad.
3. (Opcional) **Stock inicial y alerta:** elige una **bodega**, cuantas unidades llegaron
   y el nivel para **avisar cuando baje de** (punto de reorden). Si no eliges bodega,
   estos campos quedan inactivos.
4. Clic en **Crear producto**. Veras el aviso verde y el producto aparece en la lista.

## Editar o dar de baja
- En la fila, **Eliminar** intenta borrar el producto. Si ya tiene historial, **no** se
  borra: se **desactiva** (queda en gris, sin perder su historia).
- En un producto inactivo, el boton **Reactivar** lo vuelve a habilitar.

> **Importante:** el **costo promedio no se digita** en el producto; lo calcula el sistema
> con cada entrada. El catalogo dice *que* es el articulo; *cuanto* hay vive en
> Existencias.
"""),

("Categorias, marcas y unidades", r"""
# Categorias, marcas y unidades

**Donde:** Inventario -> **Productos**, pestanas *Categorias*, *Marcas* y *Unidades*

Son los catalogos de apoyo para clasificar tus productos. Se administran desde las
pestanas de la misma pantalla de Productos.

## Categorias (arbol)
Permiten organizar el catalogo en una jerarquia (categoria padre -> subcategorias).
1. Pestana **Categorias** -> **Nueva categoria**.
2. Escribe el **Nombre** (obligatorio). El **Codigo** se sugiere solo a partir del nombre
   (puedes ajustarlo).
3. (Opcional) Elige una **Categoria padre** para crear una subcategoria; dejala vacia para
   una categoria raiz.
4. **Crear categoria**.

Desde el arbol puedes **Ver** los productos de una categoria, **Editar** o **Eliminar**.
Una categoria con productos no deberia eliminarse sin reasignarlos antes.

## Marcas
Pestana **Marcas** -> **Nueva marca** -> escribe el **Nombre** (ej. *Atlas Copco*) ->
**Crear marca**.

## Unidades de medida
Pestana **Unidades** -> **Nueva unidad** -> escribe **Codigo** (ej. `UND`, `KG`, `MT`) y
**Nombre** (ej. *Unidad*, *Kilogramo*, *Metro*) -> **Crear unidad**.

> **Consejo:** crea primero unas pocas categorias, marcas y unidades reales antes de cargar
> el catalogo; asi cada producto nace bien clasificado.
"""),

("Bodegas y ubicaciones", r"""
# Bodegas y ubicaciones

**Donde:** Inventario -> **Bodegas**  ·  Necesitas: ver bodegas (para crear/editar:
administrar bodegas)

Define donde se guarda el inventario. Cada bodega puede tener ubicaciones internas (zona,
pasillo, estante, casilla) para saber no solo cuanto hay sino exactamente donde esta.

## Lo que ves en la tabla
Codigo, Nombre, **Tipo** (principal, secundaria, produccion, **taller**, **vehiculos**,
consignacion, transito), **Responsable**, numero de **ubicaciones**, **items en stock** y
**estado**. Un icono naranja junto al responsable avisa si no tiene WhatsApp configurado
(no recibiria alertas).

## Crear una bodega — paso a paso
1. Clic en **Nueva bodega**.
2. Llena: **Codigo** (ej. `BOD-01`) y **Nombre** son obligatorios; elige el **Tipo**.
3. (Opcional) **Direccion** y **Responsable**. El responsable recibe las alertas de esa
   bodega por WhatsApp (el numero sale de su ficha de empleado en RRHH).
4. **Guardar**.

## Ubicaciones internas (al editar)
Abre una bodega y, en la seccion **Ubicaciones**, agrega cada una indicando su **Tipo**
(Zona, Pasillo, Estante o Casilla), **Codigo** y **Nombre**, y pulsa **Agregar**.

## Ver el detalle de una bodega
El boton **Ver detalle** abre el stock de esa bodega: tarjetas de resumen (estado,
responsable, valor total…), un buscador y el stock **agrupado por categoria** (cada grupo
muestra en mano, disponible y valor). Util para inventariar una sola bodega.

> **Recomendacion:** modela primero las bodegas reales (campo, taller, vehiculos) y baja al
> detalle de ubicaciones solo donde de verdad ayude a ubicar el material.
"""),

("Existencias: inventario disponible", r"""
# Existencias: inventario disponible

**Donde:** Inventario -> **Existencias** (pestana *Disponible*)  ·  Necesitas: ver
existencias

Tu consulta rapida de "cuanto hay y donde". Es solo lectura: para mover stock usa la
pestana *Entradas y salidas*.

## Lo que ves
| Columna | Que es |
|---|---|
| SKU / Producto | Identificacion del articulo |
| Bodega | Donde esta ese stock |
| En mano | Unidades fisicas |
| Disponible | En mano menos lo reservado |
| Ultimo ingreso | Fecha de la ultima entrada |
| Costo prom. / Valor | Costo unitario promedio y valor total (cantidad x costo) |

## Filtros
- **Buscador** por producto o SKU.
- **Bodega** y **Categoria** para acotar.
- **Limpiar** quita todos los filtros de una vez.
- Las columnas se ordenan haciendo clic en su titulo (por ejemplo, ordena por **Valor**
  para ver que es lo mas caro que tienes guardado).

> **Truco:** filtra por una bodega y ordena por "En mano" para detectar rapido lo que esta
> por agotarse en ese sitio.
"""),

("Registrar entradas, salidas y traslados", r"""
# Registrar entradas, salidas y traslados

**Donde:** Inventario -> **Existencias** -> pestana *Entradas y salidas*  ·  Necesitas:
registrar movimientos

Aqui registras todo lo que entra, sale o se traslada. Cada movimiento queda en el
**historial de costos (Kardex)** para auditoria.

## La pantalla
Arriba puedes filtrar el historial por tipo (**Todas / Entradas / Salidas / Traspasos**) y
buscar por producto. La tabla muestra fecha, producto, tipo (verde=entrada, rojo=salida,
azul=traspaso), cantidad, costo total y referencia. El boton **Registrar movimiento** abre
el formulario.

## Paso a paso
1. Clic en **Registrar movimiento**.
2. Elige **que vas a registrar**:
   - **ENTRADA** — llega mercancia (compra, devolucion, ajuste positivo). **Suma** stock.
   - **SALIDA** — sale o se consume (consumo interno, perdida, dano, robo…). **Resta** stock.
   - **TRASPASO** — mueve stock de una bodega a otra. No cambia el total ni el costo.
3. Completa los datos:
   - **Producto** y **Cantidad** (obligatorios).
   - **Motivo** (segun el tipo): compra/devolucion para entradas; consumo interno,
     perdida, dano, robo para salidas.
   - **Costo unitario** (solo entradas): cuanto cuesta cada unidad, para valorizar.
   - **Bodega**: destino (entrada), origen (salida) u origen **y** destino (traspaso).
   - **Referencia** (opcional): No. de factura, remision o una nota para ubicarlo despues.
4. Clic en **Registrar…**. Veras el aviso verde y el historial se actualiza.

## Tareas tipicas
- **Entrada por compra:** ENTRADA -> producto -> cantidad -> costo unitario -> bodega
  destino -> referencia (factura).
- **Consumo interno:** SALIDA -> producto -> motivo *Consumo interno* -> cantidad ->
  bodega origen.
- **Traslado entre bodegas:** TRASPASO -> producto -> cantidad -> bodega origen -> bodega
  destino.

> **Los movimientos no se editan ni se borran** (para garantizar la auditoria). Si te
> equivocaste, registra el movimiento inverso o usa un **Ajuste**.
"""),

("Historial de costos (Kardex)", r"""
# Historial de costos (Kardex)

**Donde:** Inventario -> **Existencias** -> pestana *Historial de costos*  ·  Necesitas:
ver kardex

El Kardex es la hoja de vida de un producto: cada entrada y salida con su costo, el saldo
acumulado y como evoluciono el costo promedio.

## Como se usa
1. **Busca y selecciona un producto** en la lista superior.
2. Aparecen los **indicadores**: stock actual, valor del inventario, costo promedio, total
   de entradas y total de salidas.
3. Abajo, la **tabla del kardex**, fila por movimiento:

| Columna | Que es |
|---|---|
| Fecha / Motivo / Documento | Cuando, por que y con que soporte |
| Bodega | Donde ocurrio |
| Entrada / Salida | Cuanto entro (verde) o salio (rojo) |
| Costo unit. | Costo de esa operacion |
| Saldo bodega | Cuanto queda en esa bodega tras el movimiento |
| Costo prom. | Costo promedio vigente en ese momento |
| Valor saldo | Saldo x costo promedio |

## Filtros y exportar
- Filtra por **bodega** y por **rango de fechas** (Desde / Hasta).
- **Exportar CSV** descarga el historial mostrado para abrirlo en Excel.

## Como leer el costo promedio
- Sube **solo** cuando entran unidades a un precio distinto del vigente:
  `nuevo promedio = (valor anterior + valor de la entrada) / cantidad total`.
- Las **salidas no cambian** el costo promedio: se valorizan al promedio vigente.
- Los **traslados** entre bodegas tampoco lo cambian: solo mueven el saldo.

> **Nota:** sin filtrar por bodega, la columna *Saldo bodega* muestra el saldo de cada
> bodega por separado. Filtra por una bodega para ver un saldo continuo.
"""),

("Ajustes de inventario", r"""
# Ajustes de inventario

**Donde:** Inventario -> **Ajustes**  ·  Necesitas: crear ajustes (para verlos basta con
estar autenticado)

Los ajustes corrigen el inventario cuando lo fisico no coincide con el sistema: danos,
robos, perdidas, errores de registro o diferencias de conteo. Todo queda trazado en el
Kardex con un numero unico.

## La pantalla
Filtra el historico por motivo (Todos, Dano, Robo, Perdida, Error operativo, Correccion
administrativa, Diferencia de conteo). Cada ajuste muestra numero, fecha, motivo, bodega y
notas. El boton **Nuevo ajuste** abre el formulario.

## Crear un ajuste — paso a paso
1. Clic en **Nuevo ajuste**.
2. Elige **Bodega** y **Motivo** (ambos obligatorios) y la **Fecha** (hoy por defecto).
3. (Opcional) **URL de evidencia**: enlace a una foto, acta o soporte.
4. **Productos a ajustar** (una o varias lineas):
   - Elige el **Producto**.
   - Escribe la **Cantidad** con signo: **+** entra (suma) / **-** sale (resta). Un
     indicador muestra "entra" o "sale".
   - El **Costo unitario** solo aplica a las entradas (en las salidas queda inactivo); se
     pre-llena con el costo promedio del producto.
   - Usa **Agregar producto** para mas lineas o la **X** para quitar.
5. (Opcional) **Notas**: causa, responsable, observaciones.
6. Clic en **Registrar ajuste**. Veras el aviso con el numero (ej. `ADJ-2026-0001`).

## Ejemplo: diferencia de conteo
Hiciste conteo fisico y el sistema dice 1.000 pero contaste 995: crea un ajuste con motivo
*Diferencia de conteo*, linea con cantidad **-5**, y en Notas el numero del acta.

> **Buena practica:** todo faltante o sobrante de un conteo se canaliza por aqui, nunca
> tocando el stock directamente. Asi queda el rastro y el responsable.
"""),

("Ordenes de compra", r"""
# Ordenes de compra

**Donde:** Inventario -> **Ordenes de compra**  ·  Necesitas: ver ordenes (crear:
administrar ordenes · aprobar: aprobar ordenes)

Gestiona las compras a proveedores con un flujo de aprobacion controlado.

## Ciclo de vida
```
BORRADOR  ->  PENDIENTE  ->  APROBADA  ->  PARCIAL / COMPLETADA      (o CANCELADA)
```
Filtra la lista por estado (Todas, Borrador, Pendientes, Aprobadas, Completadas). Cada
orden muestra numero, proveedor, fecha, numero de lineas, recepciones y total.

## Crear una orden — paso a paso
1. Clic en **Nueva orden de compra**.
2. Elige el **Proveedor** (obligatorio). Si es nuevo, escribe su nombre en *Proveedor
   nuevo* y pulsa **Crear proveedor**.
3. (Opcional) **Bodega destino**, **Fecha de la orden** (hoy) y **Entrega esperada**.
4. **Productos a pedir:** por cada linea elige producto, **cantidad** y **costo unitario**
   (se pre-llena con el costo conocido). Usa **Agregar producto** para mas lineas.
5. (Opcional) **Notas** con condiciones u observaciones.
6. **Crear orden**: nace en estado **Borrador**.

## Enviar, aprobar, cancelar
Abre una orden con **Ver**:
- **Enviar a aprobacion** (borrador -> pendiente).
- **Aprobar** (pendiente -> aprobada). Requiere el permiso de aprobacion: normalmente no
  aprueba quien creo la orden (control interno).
- **Cancelar** (en borrador o pendiente; es irreversible).

A medida que llega la mercancia (ver *Recepciones*), las lineas se marcan parciales o
completadas y la orden cambia de estado sola.

> **Numeracion sin huecos:** las ordenes usan un consecutivo controlado (ej. `OC-000123`),
> requisito de control interno.
"""),

("Recepciones de mercancia", r"""
# Recepciones de mercancia

**Donde:** Inventario -> **Recepciones**  ·  Necesitas: registrar recepciones

Registra la entrada fisica de mercancia. Normalmente se hace contra una orden de compra,
pero tambien admite recepciones directas. **Suma stock** automaticamente.

## Crear una recepcion — paso a paso
1. Clic en **Nueva recepcion**.
2. (Recomendado) Elige la **Orden de compra**: el sistema carga sus lineas pendientes con
   las cantidades y costos. Dejala vacia para una recepcion directa (sin orden).
3. Elige la **Bodega destino** (obligatorio) y la **Fecha** (hoy).
4. Revisa cada linea y ajusta la **cantidad** si llego distinto. En **Condicion** marca:
   - **OK** — entra al stock.
   - **Danado** o **Faltante** — **no** suma stock; queda el registro de la novedad con el
     proveedor.
5. (Opcional) **Notas**.
6. **Registrar recepcion**. Solo las lineas **OK** suman stock; el costo promedio del
   producto se recalcula con la entrada.

## Recepcion parcial
Si llega menos de lo pedido, registra lo que llego: la orden queda **Parcial** y luego
puedes recibir el resto en otra recepcion.

> **Calidad en la recepcion:** usar *Danado*/*Faltante* deja trazabilidad de las novedades
> para el reclamo al proveedor.
"""),

("Limites, reorden y sugerencias de compra", r"""
# Limites, reorden y sugerencias de compra

**Donde:** Inventario -> **Limites y reorden**  ·  Necesitas: ver existencias (editar
limites: administrar productos)

Evita quiebres de stock: defines cuanto debe haber como minimo y el sistema te sugiere que
comprar. La pantalla tiene dos vistas: **Limites** y **Sugerencias**.

## Definir un limite
1. Vista **Limites** -> **Nuevo limite**.
2. Elige **Producto** y **Bodega**.
3. Define los tres niveles:
   - **Minimo** — el piso que nunca deberia bajar.
   - **Punto de reorden** — cuando el stock llega aqui, se dispara la alerta y aparece en
     Sugerencias.
   - **Maximo** — el objetivo al reponer.
4. **Guardar limite**. (Lo recomendado es minimo <= punto de reorden <= maximo.)

## Usar las sugerencias
La vista **Sugerencias** lista los productos por debajo de su punto de reorden, con el
stock disponible, el consumo diario, los dias de stock restantes, la **cantidad sugerida**
a comprar y su costo estimado.

Desde ahi, el boton **Crear OC** abre una orden de compra con el producto, la bodega y la
cantidad sugerida ya cargados: solo eliges el **proveedor** y confirmas. Luego sigue el
flujo normal (enviar, aprobar, recibir).

> **Relacion con la campana:** estos mismos limites alimentan las alertas de stock bajo y
> agotado que ves en la campana de notificaciones.
"""),

("Asignar material a empleados (custodia)", r"""
# Asignar material a empleados (custodia)

**Donde:** Inventario -> **Asignaciones**  ·  Necesitas: **asignar material** (exclusivo
del Jefe de Bodega)

Entrega material o herramientas a un empleado bajo **custodia** y controla su devolucion.
Clave en campo, donde el personal recibe equipo que debe responder.

## Lo que ves
Por cada asignacion: el **funcionario** (con su documento y area), el **material**, la
cantidad, la bodega de origen, la fecha de entrega y el **estado** (Asignado, Devuelto,
Consumido, Perdido). Filtra por estado en la parte superior.

## Asignar — paso a paso
1. Clic en **Asignar material**.
2. Elige el **Funcionario** y el **Material** (obligatorios) y la **Cantidad**.
3. **Fecha de entrega** (hoy por defecto).
4. **Bodega de origen** (importante):
   - **Con bodega:** descuenta el stock real de esa bodega (movimiento de salida).
   - **Sin bodega (vacia):** solo registra la custodia, **no** descuenta stock (util para
     equipo que rota entre personas).
5. (Opcional) **Notas**. Clic en **Asignar**.

## Devolver o dar por consumido
En una fila **Asignada**:
- **Devolver** — el material **reingresa** al stock de su bodega (vuelve como entrada).
- **Consumir** — el material **no** regresa (se gasto/consumio).

> **Por que importa:** como la custodia mueve stock real, queda **valorizada y auditable**;
> no es solo un papel suelto. Solo el **Jefe de Bodega** puede asignar y cerrar
> asignaciones.
"""),

("Mantenimiento de equipos", r"""
# Mantenimiento de equipos

**Donde:** Inventario -> **Mantenimiento**  ·  Necesitas: gestionar mantenimientos

Registra el mantenimiento **preventivo** y **correctivo** de los equipos, con los repuestos
consumidos. Tiene tres pestanas: **Registros**, **Uso por area** y **Areas**.

## Registrar un mantenimiento — paso a paso
1. Pestana **Registros** -> **Nuevo mantenimiento**.
2. Elige el **Tipo**: *Preventivo* (planeado) o *Correctivo* (reparacion de falla).
3. Indica el **componente**: *Por producto* (del catalogo) o *Por numero de serie* (un
   equipo especifico).
4. (Opcional) **Area**, **Fecha** (hoy) y **Tecnico** responsable.
5. **Descripcion / falla atendida** (obligatorio): que se hizo.
6. (Opcional) **Materiales utilizados:** busca y marca los repuestos consumidos y elige la
   **Bodega de repuestos** — esos repuestos **descuentan stock** automaticamente.
7. **Registrar mantenimiento**. Veras el numero (ej. `MT-001`).

## Uso por area
La pestana **Uso por area** agrupa los mantenimientos por area y muestra cuanto se gasto en
mano de obra y repuestos, y que repuestos se consumieron. Sirve para ver donde se concentra
el mantenimiento.

## Areas
La pestana **Areas** administra el catalogo de areas (codigo opcional + nombre).

> **Diferencia con Ordenes de trabajo:** el mantenimiento registra algo **ya hecho**. Si
> necesitas asignar la tarea a un tecnico, con checklist, fotos y prioridad, usa **Ordenes
> de trabajo** (siguiente seccion).
"""),

("Ordenes de trabajo", r"""
# Ordenes de trabajo

**Donde:** Inventario -> **Ordenes de trabajo**  ·  El **Jefe** crea y asigna; el
**Tecnico** ejecuta solo las suyas.

Son tareas de mantenimiento asignables, con checklist, evidencia fotografica y consumo de
repuestos. La lista se filtra por estado: Todas, Pendientes, En progreso, Terminadas.

## El Jefe de Bodega: crear y asignar
1. Clic en **Nueva orden**.
2. Llena: **Titulo** (obligatorio) y, opcionalmente, descripcion, **Tipo** (correctivo,
   preventivo, instalacion, limpieza, inspeccion…), **Tecnico asignado**, **Prioridad**
   (baja, media, alta, urgente), **Fecha limite** (con atajos Hoy / Manana / 1 semana),
   **Area** y **Bodega de repuestos**.
3. (Opcional) Agrega un **checklist** de tareas, una por renglon.
4. **Crear orden**. Tambien puedes **Editar** o **Cancelar** una orden mientras este
   abierta (pendiente o en progreso).

## El Tecnico: ejecutar
El tecnico **solo ve las ordenes asignadas a el**. Al abrir una orden:
1. **Iniciar** (pasa a *En progreso*).
2. **Consumir repuestos:** elige producto y cantidad y pulsa Agregar (descuenta stock).
3. **Marcar tareas** del checklist a medida que las completa.
4. **Subir evidencia fotografica** (puede tomar la foto con la camara del celular).
5. **Terminar:** escribe una nota de cierre opcional y pulsa Terminar (pasa a *Terminada* y
   queda bloqueada). Para terminar se espera que haya evidencia.

> **Separacion de roles:** el tecnico no puede crear, editar ni cancelar ordenes; solo
> ejecuta las suyas. El jefe administra todas.
"""),

("Reportes de inventario", r"""
# Reportes de inventario

**Donde:** Inventario -> **Reportes**  ·  Necesitas: ver reportes

Reportes operativos y de control. Se cargan al abrir cada pestana; algunos se exportan a
CSV.

| Reporte | Para que sirve |
|---|---|
| **Valorizado** | Valor del inventario por bodega (exporta existencias a CSV) |
| **Rotacion** | Salidas vs. stock en mano: que tan rapido rota cada producto |
| **Reabastecimiento** | Productos bajo su punto de reorden y cuanto comprar |
| **Sin movimiento** | Productos quietos, candidatos a depurar |
| **Ajustes** | Historico de ajustes por motivo y estado |
| **Compras por proveedor** | Concentracion de compras por proveedor |
| **Consumo interno** | Material consumido (mantenimiento, asignaciones) |

## Como usarlos
- Abre la pestana del reporte; espera el icono de carga.
- En **Valorizado**, usa **Exportar existencias (CSV)** para trabajar los datos en Excel.
- Combina **Sin movimiento** + **Rotacion** para depurar el catalogo y no sobre-stockear
  repuestos que no rotan.
"""),

("Alertas y la campana", r"""
# Alertas y la campana

**Donde:** icono de **campana**, arriba a la derecha, en cualquier pantalla  ·  Necesitas:
ver existencias

El sistema vigila el stock y te avisa cuando algo necesita atencion, sin que tengas que
estar revisando.

## Como funciona
- Al entrar, el sistema **revisa el stock** y carga las alertas. La campana muestra un
  **punto rojo** si hay alertas sin leer.
- Tambien corre una **revision automatica diaria** (en la manana).
- Hay dos tipos de alerta:
  - **Agotado** — el producto quedo en cero (icono rojo).
  - **Stock bajo** — cayo por debajo del punto de reorden (icono naranja).

## Que puedes hacer
- Clic en la campana para ver la lista (titulo, mensaje y hace cuanto).
- Clic en una alerta te lleva a **Limites y reorden** para decidir la compra.
- **Marcar leidas** apaga el punto rojo.

## Otros canales
Ademas de la app, las alertas pueden enrutarse por **WhatsApp** al **responsable de la
bodega** (su numero sale de su ficha de empleado). La misma alerta no se repite dentro de
la semana, para no saturar.

> Si una bodega no tiene responsable con WhatsApp, veras un aviso naranja en la lista de
> bodegas: configuralo para que reciba las alertas.
"""),

("Asistente por WhatsApp", r"""
# Asistente por WhatsApp

**Donde:** Administracion -> **WhatsApp**  ·  Necesitas: administrar WhatsApp (es una
funcion de administrador)

Permite consultar el inventario por WhatsApp con un asistente de inteligencia artificial:
existencias, productos y bodegas, incluso con **notas de voz**.

## Para el administrador: dejarlo listo
1. Entra a **Administracion -> WhatsApp**. Arriba veras el estado de la conexion, de la API
   y de la IA.
2. **Conectar el telefono:** pulsa reintentar para mostrar un **codigo QR** y escanealo
   desde el celular (WhatsApp -> Dispositivos vinculados -> Vincular dispositivo).
3. **Autorizar usuarios:** en la tabla de usuarios, vincula el **numero de WhatsApp** de
   cada funcionario a su usuario del ERP. El asistente solo atiende numeros vinculados y
   **respeta los permisos** de cada quien.
4. (Opcional) **Enviar prueba** a un numero para confirmar que responde.

## Para el usuario: usarlo
Con tu numero vinculado, escribe (o manda una nota de voz) al numero del asistente:
*"cuantas unidades hay de X"*, *"stock de tornillos M4"*, *"bodegas disponibles"*. El
asistente responde solo lo que tu rol puede ver en el ERP.

> **Nota tecnica:** la conexion por libreria no oficial es para uso interno/demo; para
> produccion se usa la API oficial de WhatsApp. La IA requiere su clave configurada por el
> area de sistemas.
"""),

("Apendice: roles y permisos", r"""
# Apendice: roles y permisos

El sistema **muestra u oculta** cada pantalla y boton segun los permisos de tu rol. Esta
es la referencia rapida de quien hace que.

## Roles del area
| Rol | Alcance |
|---|---|
| **Jefe de bodega** | Control total del inventario; **unico** que asigna material en custodia y aprueba ordenes/ajustes |
| **Tecnico de mantenimiento** | Ejecuta las ordenes de trabajo asignadas y registra su consumo |
| **Consulta / auxiliar** | Solo lectura del catalogo, existencias, kardex y reportes |

## Permisos por accion
| Para… | Necesitas |
|---|---|
| Ver existencias / kardex | ver existencias · ver kardex |
| Administrar el catalogo (productos, categorias…) | administrar productos |
| Administrar bodegas | administrar bodegas |
| Registrar movimientos (entradas/salidas/traslados) | registrar movimientos |
| Crear ajustes | crear ajustes |
| Crear ordenes de compra | administrar ordenes de compra |
| Aprobar ordenes de compra | aprobar ordenes de compra |
| Registrar recepciones | registrar recepciones |
| Asignar material en custodia | **asignar material (exclusivo Jefe de Bodega)** |
| Crear / asignar ordenes de trabajo | administrar ordenes de trabajo |
| Ejecutar ordenes de trabajo | ejecutar ordenes de trabajo |
| Ver reportes | ver reportes |

> **Principio de control interno:** quien **registra** no siempre es quien **aprueba**. La
> separacion de funciones (crear vs. aprobar, asignar vs. consultar) protege la operacion.
"""),

("Glosario", r"""
# Glosario

| Termino | Que significa |
|---|---|
| **SKU** | Codigo unico que identifica un producto |
| **Bodega** | Lugar fisico donde se guarda el inventario |
| **Ubicacion** | Sitio dentro de una bodega (zona, pasillo, estante, casilla) |
| **En mano** | Unidades fisicas que hay de un producto |
| **Disponible** | En mano menos lo reservado |
| **Entrada / Salida / Traspaso** | Stock que aumenta / disminuye / se mueve entre bodegas |
| **Kardex** | Historial de movimientos y costos de un producto |
| **Costo promedio** | Costo unitario promedio ponderado que mantiene el sistema |
| **Valor del inventario** | Existencias multiplicadas por el costo promedio |
| **Punto de reorden** | Nivel de stock que dispara la alerta de reposicion |
| **Ajuste** | Correccion del stock por dano, robo, perdida, error o conteo |
| **Recepcion** | Registro de la entrada fisica de mercancia (suele venir de una OC) |
| **Orden de compra (OC)** | Solicitud formal de mercancia a un proveedor |
| **Custodia / Asignacion** | Material entregado a un empleado, que debe responder y devolver |
| **Serial / Trazabilidad** | Seguimiento de una unidad individual por su numero de serie |
| **Orden de trabajo** | Tarea de mantenimiento asignada a un tecnico |
"""),
]

# ============================================================================
#  RENDER  (identico al manual de modulo, marca BHDC)
# ============================================================================
def render_section(title, src):
    html = md.convert(clean(src))
    md.reset()
    return f'<section class="doc">{html}</section>'

sections_html = "\n".join(render_section(t, s) for t, s in SECTIONS)
toc_items = "\n".join(f'<li><span class="t">{t}</span></li>' for t, _ in SECTIONS)

DOC = f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><style>
@page {{
  size: A4; margin: 22mm 18mm 20mm 18mm;
  @bottom-center {{ content: "Manual de uso · Inventario · BHDC"; font-family: Arial, sans-serif; font-size: 8pt; color: {INK_3}; }}
  @bottom-right {{ content: "Pag. " counter(page) " / " counter(pages); font-family: Arial, sans-serif; font-size: 8pt; color: {INK_3}; }}
}}
@page :first {{ margin: 0; @bottom-center {{ content: ""; }} @bottom-right {{ content: ""; }} }}
* {{ box-sizing: border-box; }}
body {{ font-family: 'Helvetica Neue', 'Segoe UI', Arial, sans-serif; color: {INK}; font-size: 10.5pt; line-height: 1.5; margin: 0; }}

.cover {{ page-break-after: always; height: 297mm; width: 210mm; position: relative;
  background: radial-gradient(120% 80% at 100% 0%, {BRAND_SOFT} 0%, transparent 55%), linear-gradient(160deg, #ffffff 0%, {SURFACE} 70%, {CANVAS} 100%); padding: 38mm 24mm; }}
.cover .bar {{ position: absolute; top: 0; left: 0; right: 0; height: 12mm; background: linear-gradient(90deg, {GOLD} 0%, {BRAND} 45%, {RED} 100%); }}
.cover .logo {{ width: 78mm; margin-bottom: 16mm; }}
.cover .eyebrow {{ text-transform: uppercase; letter-spacing: .28em; font-size: 10pt; color: {BRAND_HOVER}; font-weight: 700; margin-bottom: 6mm; }}
.cover h1 {{ font-size: 34pt; line-height: 1.08; margin: 0 0 6mm 0; color: {INK}; font-weight: 800; border: none; padding: 0; }}
.cover h1 .accent {{ color: {BRAND}; }}
.cover .sub {{ font-size: 13pt; color: {INK_2}; max-width: 135mm; }}
.cover .meta {{ position: absolute; bottom: 28mm; left: 24mm; right: 24mm; border-top: 2px solid {BRAND}; padding-top: 5mm; display: flex; justify-content: space-between; font-size: 9.5pt; color: {INK_3}; }}
.cover .meta strong {{ color: {INK}; }}

.toc {{ page-break-after: always; }}
.toc h2 {{ font-size: 20pt; color: {INK}; border-bottom: 3px solid {GOLD}; padding-bottom: 3mm; margin-bottom: 8mm; }}
.toc .lead {{ font-weight: 600; color: {INK_2}; margin-bottom: 6mm; }}
ol.toc-list {{ list-style: none; counter-reset: toc; padding: 0; margin: 0; column-count: 2; column-gap: 8mm; }}
ol.toc-list li {{ counter-increment: toc; display: flex; align-items: center; gap: 4mm; padding: 3mm 4mm; margin-bottom: 3mm; border: 1px solid {BORDER}; border-left: 5px solid {BRAND}; border-radius: 8px; background: {SURFACE}; break-inside: avoid; }}
ol.toc-list li::before {{ content: counter(toc); flex: 0 0 auto; width: 9mm; height: 9mm; background: {BRAND}; color: #fff; border-radius: 50%; font-weight: 800; display: flex; align-items: center; justify-content: center; font-size: 10pt; }}
ol.toc-list li .t {{ font-weight: 600; font-size: 10.5pt; }}

.doc {{ page-break-before: always; }}
h1 {{ font-size: 19pt; color: {INK}; font-weight: 800; margin: 0 0 6mm 0; padding: 0 0 3mm 0; border-bottom: 3px solid {BRAND}; }}
h2 {{ font-size: 13.5pt; color: {BRAND_HOVER}; font-weight: 700; margin: 7mm 0 3mm 0; padding-left: 4mm; border-left: 4px solid {GOLD}; }}
h3 {{ font-size: 11.5pt; color: {INK}; margin: 5mm 0 2mm 0; }}
p {{ margin: 0 0 3mm 0; }}
ul, ol {{ margin: 0 0 4mm 0; padding-left: 6mm; }}
li {{ margin-bottom: 1.5mm; }}
strong {{ color: {INK}; }}
code {{ background: {BRAND_SOFT}; color: {BRAND_HOVER}; padding: .5mm 1.5mm; border-radius: 3px; font-family: Consolas, monospace; font-size: 9pt; }}
pre {{ background: #7c2d12; color: {BRAND_SOFT}; padding: 3mm 4mm; border-radius: 6px; font-size: 9pt; white-space: pre; overflow: hidden; margin: 0 0 4mm 0; }}
pre code {{ background: none; color: inherit; padding: 0; }}
table {{ width: 100%; border-collapse: collapse; margin: 3mm 0 5mm 0; font-size: 9.5pt; }}
th {{ background: {BRAND}; color: #fff; text-align: left; padding: 2.5mm 3mm; font-weight: 700; border: 1px solid {BRAND}; }}
td {{ padding: 2.5mm 3mm; border: 1px solid {BORDER}; vertical-align: top; }}
tr:nth-child(even) td {{ background: {SURFACE}; }}
blockquote {{ margin: 4mm 0; padding: 3mm 5mm; background: {GOLD_SOFT}; border-left: 5px solid {GOLD}; border-radius: 0 8px 8px 0; color: {INK_2}; }}
blockquote p {{ margin: 0; }}
</style></head><body>

<div class="cover">
  <div class="bar"></div>
  <img class="logo" src="data:image/png;base64,{logo_b64}" />
  <div class="eyebrow">BHDC / Documentacion</div>
  <h1>Manual de uso<br><span class="accent">Inventario</span></h1>
  <div class="sub">Guia paso a paso para operar la bodega: productos y catalogo, bodegas,
  existencias y kardex, entradas y salidas, ajustes, compras y recepciones, limites y
  alertas, custodia de material, mantenimiento, ordenes de trabajo, reportes y el asistente
  por WhatsApp.</div>
  <div class="meta">
    <div><strong>BHDC</strong> / Modulo de Inventario</div>
    <div>{len(SECTIONS)} secciones · guia del usuario</div>
  </div>
</div>

<div class="toc">
  <h2>Contenido</h2>
  <p class="lead">Una seccion por pantalla o tarea. Cada una explica que ves, que botones
  hay, que pide cada formulario y el paso a paso de las tareas tipicas.</p>
  <ol class="toc-list">
  {toc_items}
  </ol>
</div>

{sections_html}

</body></html>"""

HTML(string=DOC, base_url=str(ROOT)).write_pdf(str(OUT))
print(f"OK -> {OUT}")
