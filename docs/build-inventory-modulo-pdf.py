#!/usr/bin/env python3
"""Genera el Manual de Inventario de Nexus ERP (un submódulo por sección),
reutilizando la paleta y el diseño de marca BHDC del Manual de Contabilidad."""
import base64
import re
from pathlib import Path

import markdown
from weasyprint import HTML

ROOT = Path("/home/dev/nexus-erp")
LOGO = ROOT / "LOGO BHDC Completo.png"
OUT = ROOT / "docs" / "Manual-Inventario-Nexus.pdf"

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
#  CONTENIDO — un submódulo por entrada (título corto, markdown)
# ============================================================================
SECTIONS = [
("Resumen de inventario", r"""
# Resumen de inventario

**Ruta:** `/inventario` · **Permiso:** `inventory.stock.read`

Es el tablero de entrada de la bodega. Reúne los indicadores clave del inventario
calculados en vivo desde los movimientos y existencias reales (no cifras digitadas a
mano).

## Qué muestra
- **Valor del inventario** (existencias × costo promedio).
- **Productos** activos, bajos de stock y agotados.
- **Alertas** pendientes y accesos rápidos a las operaciones del día.
- **Actividad reciente** de movimientos.

> **Contexto del negocio:** la operación es una **petrolera de perforación y servicios
> (BHDC)**. El inventario gira en torno a repuestos, materiales y equipos para campo y
> taller — por eso pesan el mantenimiento, la custodia de material a empleados y la
> trazabilidad por serial.
"""),

("Catálogo de productos", r"""
# Catálogo de productos

**Ruta:** `/inventario/productos` · **API:** `GET/POST/PATCH /inventory/products`

El maestro de artículos: lo que la bodega puede almacenar y mover. Sobre estos productos
se construye todo el inventario.

## Qué define cada producto
| Campo | Significado |
|---|---|
| `sku` / `internalCode` / `barcode` | Identificadores del artículo |
| `type` | Físico, materia prima, consumible, **repuesto**, herramienta, activo… |
| `category` / `brand` / `uom` | Categoría (árbol jerárquico), marca y unidad de medida |
| `trackSerials` | Si exige número de serie por unidad (trazabilidad) |
| `averageCost` / `lastCost` | Costos que mantiene el Kardex automáticamente |

## Organización
- **Categorías** jerárquicas (árbol padre-hijo) para clasificar el catálogo.
- **Marcas** y **unidades de medida** como catálogos de apoyo.
- Búsqueda y paginación del lado del servidor para catálogos grandes.

> **Regla:** los costos (`averageCost`) **no se editan a mano** en el producto; los
> calcula el Kardex con cada entrada. El catálogo define *qué* es el artículo, no *cuánto*
> stock hay (eso vive en existencias).
"""),

("Bodegas y ubicaciones", r"""
# Bodegas y ubicaciones

**Ruta:** `/inventario/bodegas` · **API:** `/inventory/warehouses` (+ `/locations`)

Define dónde se guarda el inventario: las bodegas y su estructura interna.

## Bodegas
Cada bodega tiene un tipo (principal, secundaria, producción, **taller**, **vehículo**,
consignación, tránsito) y un **responsable** (usuario). El responsable es a quien se
enrutan las alertas de su bodega.

## Ubicaciones internas
Dentro de cada bodega se define una jerarquía de ubicaciones:

```
Zona  →  Pasillo  →  Estante  →  Ubicación (bin)
```

El stock se registra por **(producto, bodega, ubicación)**, lo que permite saber no solo
cuánto hay sino exactamente dónde está.

> **Recomendación:** modela primero las bodegas reales (campo, taller, vehículos) y luego
> baja al detalle de ubicaciones solo donde de verdad ayude a encontrar el material.
"""),

("Existencias y Kardex (el motor de stock)", r"""
# Existencias y Kardex — el motor de stock

**Ruta:** `/inventario/existencias` (+ `/movimientos`, `/kardex`)
**API:** `/inventory/stock`, `/inventory/kardex`

Es el **corazón** del módulo. Toda entrada, salida o traslado de inventario pasa por aquí.

## Punto único de movimiento
Igual que en contabilidad el `JournalService`, en inventario el **`KardexService` es el
único punto que muta el stock**. Cada operación (recepción, ajuste, consumo, traslado,
asignación) termina llamándolo, lo que garantiza consistencia.

Cada movimiento genera:
1. Un **`InventoryMovement`** (encabezado del movimiento).
2. Una o dos **`KardexEntry`** (líneas valorizadas por bodega).
3. La actualización del **`StockLevel`** y de los costos del producto.
4. Si es **salida (OUT)**, emite el evento contable `inventory.cost.posted`.

## Tipos de movimiento
| Tipo | Uso |
|---|---|
| IN | Entrada (recepción, ajuste positivo, devolución) |
| OUT | Salida (consumo, ajuste negativo) → genera costo contable |
| TRANSFER | Traslado entre bodegas (crea salida en origen + entrada en destino) |

## Costeo: promedio ponderado móvil
El valor del inventario se lleva por **promedio ponderado**:

```
nuevoPromedio = (cantAnt × costoAnt + cantEntra × costoEntra) / (cantAnt + cantEntra)
```

El promedio se recalcula en las **entradas**; las salidas se valorizan al promedio
vigente.

## Robustez
- **Transaccional:** todo el movimiento ocurre dentro de una transacción de base de datos.
- **Serializado por producto:** dos movimientos del mismo producto no se pisan (bloqueo a
  nivel de fila); productos distintos avanzan en paralelo.
- **Idempotente:** un documento origen → un solo movimiento (`sourceType` + `sourceId`).

> **Kardex valorizado:** para un producto y rango de fechas muestra cada entrada/salida con
> saldo y costo corriente — la auditoría completa del movimiento del inventario.
"""),

("Órdenes de compra", r"""
# Órdenes de compra

**Ruta:** `/inventario/ordenes-compra` · **API:** `/inventory/purchase-orders`

Gestiona las compras a proveedores, con un flujo de aprobación controlado.

## Flujo de estados
```
BORRADOR  →  PENDIENTE  →  APROBADA  →  PARCIAL / COMPLETADA   (o CANCELADA)
```
- **Crear** la orden (borrador) con sus líneas (producto, cantidad, costo unitario).
- **Enviar a aprobación** y **aprobar** (permiso aparte).
- A medida que llega la mercancía, las líneas se marcan **parciales/completadas**.

## Datos
| Modelo | Campos clave |
|---|---|
| `PurchaseOrder` | número consecutivo, proveedor, bodega, fechas, quién solicita/aprueba, totales |
| `POLine` | producto, cantidad pedida, **cantidad recibida**, costo unitario |

## Permisos
| Acción | Permiso |
|---|---|
| Ver | `inventory.purchase-orders.read` |
| Crear/editar | `inventory.purchase-orders.write` |
| Aprobar | `inventory.purchase-orders.approve` |

> **Numeración sin huecos:** las órdenes usan un consecutivo gap-free (`OC-000001`),
> requisito de control interno.
"""),

("Recepciones de mercancía", r"""
# Recepciones de mercancía

**Ruta:** `/inventario/recepciones` · **API:** `/inventory/goods-receipts`

Registra la entrada física de mercancía, normalmente contra una orden de compra.

## Cómo funciona
Al registrar una recepción, por **cada línea**:
1. Valida que no supere la cantidad pendiente de la orden.
2. Crea un **movimiento de entrada (IN)** vía el Kardex.
3. El Kardex actualiza stock y recalcula el **promedio ponderado**.
4. Marca la línea de la orden como parcial o completada.

## Datos
| Modelo | Campos clave |
|---|---|
| `GoodsReceipt` | número, orden origen, bodega, fecha, quién recibe, evidencia |
| `GRLine` | línea de orden, producto, cantidad, costo, **condición** (OK / dañado / faltante) |

> **Calidad en recepción:** cada línea puede marcarse como dañada o faltante, dejando
> trazabilidad de las novedades con el proveedor.
"""),

("Ajustes de inventario", r"""
# Ajustes de inventario

**Ruta:** `/inventario/ajustes` · **API:** `/inventory/adjustments`

Corrige el stock cuando la realidad física no coincide con el sistema (conteos,
pérdidas, daños, errores).

## Cómo funciona
1. Se crea un ajuste con un **motivo** y sus líneas (diferencia por producto).
2. Por cada línea con diferencia:
   - Diferencia **positiva** → movimiento de **entrada (IN)**.
   - Diferencia **negativa** → movimiento de **salida (OUT)**.
3. El Kardex procesa cada movimiento y valoriza la diferencia.

## Motivos tipificados
Daño, robo, pérdida, error operativo, corrección administrativa, diferencia de conteo.

## Control
- Flujo con **aprobación** (permiso aparte de la creación).
- Soporta **evidencia** adjunta para soportar el ajuste.

| Acción | Permiso |
|---|---|
| Crear ajuste | `inventory.adjustments.write` |
| Aprobar ajuste | `inventory.adjustments.approve` |

> **Buena práctica:** todo faltante o sobrante de un conteo físico se canaliza por aquí,
> nunca tocando el stock directamente — así queda el rastro y el responsable.
"""),

("Límites, reorden y alertas", r"""
# Límites, reorden y alertas

**Ruta:** `/inventario/reorden` · **API:** `/inventory/reorder/*`, `/inventory/alerts/*`

Evita quiebres de stock avisando cuándo reponer.

## Reglas de reorden
Por cada **(producto, bodega)** se define:
| Campo | Significado |
|---|---|
| `minQty` | Mínimo absoluto |
| `reorderPoint` | Umbral que dispara la alerta |
| `maxQty` | Máximo deseado (referencia para reponer) |

Con esto, **sugerencias de compra** lista los productos cuyo stock cayó por debajo del
punto de reorden, para que el comprador genere la orden.

## Motor de alertas
- Corre **automáticamente a diario (7 a.m.)** y también bajo demanda.
- Detecta **stock bajo** y **agotado** comparando existencias vs. reglas.
- Crea notificaciones **idempotentes** (no repite la misma alerta dentro de la semana).
- Abanica a varios **canales**: en la app (campana), correo y **WhatsApp**.

## Canales
| Canal | Estado |
|---|---|
| En la app (campana) | Operativo |
| WhatsApp | Operativo vía librería no oficial (requiere conexión activa); enruta al responsable de la bodega |
| Correo | Punto de integración SMTP preparado |

> **Idempotencia:** la misma alerta para el mismo producto no satura; se deduplica por
> ventana semanal.
"""),

("Trazabilidad por serial", r"""
# Trazabilidad por serial

**API:** `/inventory/traceability` · modelo `SerialNumber`

Para los artículos críticos (equipos, herramientas), permite seguir **cada unidad
individual** por su número de serie.

## Cómo funciona
- Un producto marcado con `trackSerials = true` exige serie en sus movimientos.
- Cada unidad tiene un estado: en stock, asignada, en reparación, retirada, perdida.
- Los movimientos se enlazan al serial, de modo que se reconstruye **dónde estuvo cada
  unidad** y en manos de quién.

> **Valor:** ante una auditoría o un reclamo, se responde con certeza la pregunta *"¿dónde
> está y por dónde pasó esta herramienta/equipo?"*.
"""),

("Asignaciones de material (custodia)", r"""
# Asignaciones de material — custodia

**Ruta:** `/inventario/asignaciones` · **API:** `/inventory/material-assignments`

Entrega material a un empleado bajo **custodia**, descontándolo del stock, y permite su
**devolución**. Clave para una petrolera donde el personal de campo recibe herramientas
y consumibles.

## Flujo
1. El **Jefe de Bodega** asigna material a un empleado → genera un movimiento de **salida
   (OUT)** del stock.
2. Cuando el empleado lo devuelve → genera un movimiento de **entrada (IN)**.
3. El estado de la asignación evoluciona: asignado → devuelto / consumido / perdido.

Como mueve stock vía el Kardex, la custodia queda **valorizada y auditable**, no es solo
un registro suelto.

## Permiso exclusivo
| Acción | Permiso |
|---|---|
| Entregar/asignar material | `inventory.assets.assign` — **exclusivo del Jefe de Bodega** |

> **Diferencia con trazabilidad:** la asignación de material es por **cantidad**
> (consumibles); el serial sigue **unidades individuales**. Pueden combinarse.
"""),

("Mantenimiento", r"""
# Mantenimiento

**Ruta:** `/inventario/mantenimiento` · **API:** `/inventory/maintenance`

Registra el mantenimiento **preventivo y correctivo** de equipos, con el consumo de
repuestos asociado.

## Qué captura una orden
| Campo | Significado |
|---|---|
| `kind` | PREVENTIVO o CORRECTIVO |
| `area` | Área donde ocurre (perforación, taller, planta…) |
| `serial` / `product` | Equipo intervenido (por serie o por producto) |
| `technician` | Técnico responsable |
| `parts` | Repuestos consumidos (con costo) |

## Consumo de repuestos
Cada repuesto registrado puede **descontar stock** automáticamente (movimiento de salida
por consumo interno) vía el Kardex, ligando el costo del repuesto a la orden.

## Análisis
Reporte de **uso por área** para saber dónde se concentra el mantenimiento.

> **Nota:** existe también un módulo de **Órdenes de Trabajo** más flexible (checklist,
> fotos, prioridades) — ver la siguiente sección.
"""),

("Órdenes de trabajo", r"""
# Órdenes de trabajo

**Ruta:** `/inventario/mantenimiento/ordenes` · **API:** `/inventory/work-orders`

Órdenes de trabajo asignables: el **Jefe de Bodega** las crea y asigna a un **Técnico**,
y el técnico ejecuta solo las suyas.

## Qué incluye
- Tipo (correctivo, preventivo, instalación, limpieza, inspección…) y **prioridad**.
- **Checklist de tareas** que el técnico va marcando.
- **Evidencia fotográfica** (hasta 10 imágenes por carga, guardadas en disco).
- **Consumo de repuestos** que descuenta stock vía el Kardex.
- Estados: pendiente → en progreso → completada (o cancelada), con fechas y resolución.

## Quién hace qué
| Acción | Permiso |
|---|---|
| Crear / asignar / editar | `inventory.work-orders.write` (Jefe de Bodega) |
| Ejecutar las propias | `inventory.work-orders.execute` (Técnico) |

> **Separación de roles:** el técnico solo ve y ejecuta las órdenes asignadas a él; el
> jefe ve y administra todas.
"""),

("Reportes de inventario", r"""
# Reportes de inventario

**Ruta:** `/inventario/reportes` · **API:** `/inventory/reports/*`

Conjunto de reportes operativos y de control, varios exportables a CSV.

| Reporte | Para qué |
|---|---|
| Existencias | Stock actual por producto (exportable a CSV) |
| Stock valorizado | Cantidad × costo promedio = valor del inventario |
| Rotación | Productos con movimiento en los últimos N días |
| Sin movimiento | Productos quietos (candidatos a baja) |
| Movimientos | Entradas/salidas/traslados en un rango |
| Ajustes | Resumen de ajustes por motivo |
| Compras por proveedor | Concentración de compras |
| Consumo interno | Material consumido por mantenimiento/asignaciones |
| Material asignado | Qué tiene cada empleado bajo custodia |

> **Uso típico:** "sin movimiento" + "rotación" ayudan a depurar el catálogo y a no
> sobre-stockear repuestos que no rotan.
"""),

("Integración contable (el motor de costos)", r"""
# Integración contable — el motor de costos

**Componentes:** `KardexService`, eventos de dominio, `PostingService` (contabilidad).

Inventario y contabilidad están **integrados sin acoplarse**: inventario no sabe de
cuentas; solo emite un evento cuando sale mercancía, y contabilidad lo postea.

## El evento clave
| Evento | Cuándo | Asiento que genera |
|---|---|---|
| `inventory.cost.posted` | En cada **salida (OUT)** valorizada | Dr Costo / Cr Inventario |

El monto es el **costo promedio** de lo que salió. La cuenta destino se resuelve desde el
mapeo configurable (`COGS` / `INVENTORY`), nunca hardcodeada.

## Robustez
- **Idempotencia** por `(sourceType=INVENTORY, sourceId=movimiento)`: un movimiento → un
  solo asiento, los reintentos no duplican.
- Las entradas por compra impactan la contabilidad por el lado de **compras** (factura del
  proveedor), no por este evento.

> **Por qué importa:** el costo del inventario fluye solo a la contabilidad. El valor del
> almacén y el costo en el estado de resultados quedan siempre cuadrados con los
> movimientos reales.
"""),

("Roles y permisos", r"""
# Roles y permisos

**Archivo:** `backend/src/auth/permissions.catalog.ts`

El inventario tiene permisos **granulares** por acción, agrupados en roles.

## Roles principales
| Rol | Alcance |
|---|---|
| **Jefe de Bodega** | Control total del inventario; **único** que puede asignar material a empleados y aprobar OC/ajustes |
| **Técnico de Mantenimiento** | Ejecuta las órdenes de trabajo asignadas y registra consumo |
| **Consulta / Auxiliar** | Solo lectura del catálogo, existencias y kardex |

## Permisos representativos
| Permiso | Para qué |
|---|---|
| `inventory.stock.read` / `inventory.kardex.read` | Consultar existencias e historial |
| `inventory.products.write` | Administrar el catálogo |
| `inventory.purchase-orders.approve` | Aprobar órdenes de compra |
| `inventory.adjustments.approve` | Aprobar ajustes |
| `inventory.assets.assign` | **Entregar material en custodia (exclusivo Jefe de Bodega)** |
| `inventory.work-orders.write` / `.execute` | Crear/asignar vs. ejecutar órdenes de trabajo |
| `inventory.admin` | Control total del área |

> **Principio:** quien **registra** no siempre es quien **aprueba**. La separación de
> funciones (crear vs. aprobar, asignar vs. consultar) es parte del control interno.
"""),
]

# ============================================================================
#  RENDER
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
  @bottom-center {{ content: "Manual de Inventario · Nexus ERP"; font-family: Arial, sans-serif; font-size: 8pt; color: {INK_3}; }}
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
  <div class="eyebrow">Nexus ERP / Documentacion</div>
  <h1>Manual de <span class="accent">Inventario</span></h1>
  <div class="sub">Como funciona cada submodulo del modulo de inventario: catalogo,
  bodegas, kardex y existencias, compras y recepciones, ajustes, reorden y alertas,
  trazabilidad, custodia de material, mantenimiento, ordenes de trabajo, reportes y la
  integracion automatica con la contabilidad.</div>
  <div class="meta">
    <div><strong>BHDC</strong> / Modulo de Inventario</div>
    <div>{len(SECTIONS)} submodulos documentados</div>
  </div>
</div>

<div class="toc">
  <h2>Contenido</h2>
  <p class="lead">Una seccion por submodulo. Cada una explica que hace, como funciona,
  sus entradas y validaciones, y como se conecta con el resto del ERP.</p>
  <ol class="toc-list">
  {toc_items}
  </ol>
</div>

{sections_html}

</body></html>"""

HTML(string=DOC, base_url=str(ROOT)).write_pdf(str(OUT))
print(f"OK -> {OUT}")
