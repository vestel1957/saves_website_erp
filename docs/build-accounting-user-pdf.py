#!/usr/bin/env python3
"""Manual de USUARIO de Contabilidad (BHDC) — orientado a tareas y pantallas,
sin jerga técnica. Reutiliza la plantilla/paleta de marca de los demás manuales."""
import base64
import re
from pathlib import Path

import markdown
from weasyprint import HTML

ROOT = Path("/home/dev/nexus-erp")
LOGO = ROOT / "LOGO BHDC Completo.png"
OUT = ROOT / "docs" / "Manual-Contabilidad-Usuario.pdf"

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
#  CONTENIDO — orientado a USUARIO (qué hace y cómo, paso a paso)
# ============================================================================
SECTIONS = [
("Antes de empezar", r"""
# Antes de empezar

Bienvenido al módulo de **Contabilidad** de Nexus. Esta guía está pensada para el día a
día del contador y el auxiliar contable: explica **qué hace cada pantalla y cómo usarla**,
paso a paso, sin tecnicismos.

## Cómo ingresar
1. Abre el sistema e **inicia sesión** con tu usuario y contraseña.
2. En el menú lateral, entra a la sección **Contabilidad**.
3. Verás el listado de pantallas (Resumen, Plan de cuentas, Compras y gastos, etc.).

## Cómo está organizado tu trabajo
La empresa es una **petrolera (BHDC)**: compra bienes y servicios, **no vende productos**.
Por eso tu trabajo gira alrededor de:

- **Registrar compras y gastos** de proveedores y contratistas (con sus retenciones).
- **Pagar** esas facturas.
- **Revisar** cuentas por pagar, informes y bancos.
- **Cerrar** cada mes y emitir los **certificados de retención**.

## Una idea clave que te ahorra trabajo
La mayoría de los registros contables (los "asientos") **se generan solos** cuando
registras una compra o un pago. Tú te enfocas en **capturar bien los documentos** y en
**revisar**; el sistema arma la contabilidad por ti.

> **Tip:** si una cifra se ve rara en un informe, casi siempre se resuelve revisando el
> documento que la originó (la factura o el pago).
"""),

("El panel de resumen", r"""
# El panel de resumen

**Dónde:** Contabilidad → **Resumen**

Es tu pantalla de inicio. Muestra la foto financiera del momento, calculada en vivo.

## Qué vas a ver
- **Total de activos, pasivos y patrimonio.**
- **Resultado del periodo** (positivo o negativo).
- **Cuentas por pagar** (lo que se le debe a proveedores).
- **Gastos y costos del periodo.**
- **Saldo en bancos.**
- **Accesos rápidos** a las pantallas que más usas (compras, certificados, informes…).

## Cómo usarlo
Úsalo como **chequeo diario**: una mirada para ver que todo va bien. Si algo llama la
atención, haz clic en el acceso rápido correspondiente para ir al detalle.

> **Tip:** los números salen de los asientos reales. No hay cifras escritas a mano: si
> registras una compra, el resumen cambia al instante.
"""),

("Plan de cuentas", r"""
# Plan de cuentas

**Dónde:** Contabilidad → **Plan de cuentas**

Es el catálogo de cuentas contables (el PUC). Aquí consultas y, si tienes permiso, creas
o ajustas cuentas.

## Qué puedes hacer
- **Explorar** el árbol de cuentas (Activo, Pasivo, Patrimonio, Ingreso, Costo, Gasto).
- **Buscar** una cuenta por código o nombre.
- **Crear** una cuenta nueva dentro de su grupo.

## Cómo crear una cuenta
1. Ubica el grupo donde debe ir (por ejemplo, dentro de "Gastos").
2. Haz clic en **agregar cuenta**.
3. Escribe el **código**, el **nombre** y marca si es una cuenta **de movimiento**
   (donde se registran valores) o **agrupadora** (solo suma a sus hijas).
4. Guarda.

> **Regla de oro:** solo las cuentas **de movimiento** reciben registros. Las cuentas
> agrupadoras (los títulos) nunca; solo totalizan. Si el sistema no te deja usar una
> cuenta, probablemente es agrupadora.
"""),

("Centros de costo", r"""
# Centros de costo

**Dónde:** Contabilidad → **Centros de costo**

Sirven para saber **en qué se gasta**: por pozo, campo, proyecto o área. Es la base para
medir costos por frente de trabajo.

## Cómo crear uno
1. Entra a Centros de costo y haz clic en **Nuevo centro**.
2. Escribe un **código** corto y un **nombre** (ej. `POZO-12`, "Pozo 12").
3. Si pertenece a otro centro mayor, elige su **centro padre**.
4. Guarda.

## Cómo se usan
Al registrar un gasto, puedes asignarle un centro de costo. Luego los informes te dejan
ver cuánto consumió cada centro.

> **Recomendación:** define pocos centros al inicio y mantenlos consistentes. Es mejor
> tener 10 centros bien usados que 50 a medias.
"""),

("Impuestos y retenciones", r"""
# Impuestos y retenciones

**Dónde:** Contabilidad → **Impuestos**

Aquí se definen los **porcentajes** de IVA y de retenciones que el sistema aplicará al
registrar compras. Se configuran una vez y se reutilizan siempre.

## Qué tipos hay
- **IVA descontable (compras):** el IVA que pagas a tus proveedores.
- **Retenciones (eres agente retenedor):** ReteFuente, ReteIVA, ReteICA.

## Cómo crear un código
1. Haz clic en **Nuevo impuesto**.
2. Escribe un **nombre** (ej. "ReteFuente servicios 4%").
3. Elige el **tipo** (IVA compras o Retención).
4. Pon la **tarifa** como fracción: `0.04` = 4%, `0.19` = 19%.
5. Si es retención, elige la **base de cálculo**:
   - **Subtotal** → para ReteFuente y ReteICA.
   - **Sobre el IVA** → para ReteIVA.
6. Elige la **cuenta contable** donde se acumula y guarda.

## Lo que ya viene listo
El sistema trae cargados los códigos típicos: ReteFuente compras 2.5%, servicios 4%,
honorarios 11%, arrendamientos 3.5%, ReteIVA 15% y ReteICA — todos editables.

> **Tip:** si cambia una tarifa (por ley o ciudad), solo ajustas el porcentaje aquí; no
> hay que tocar nada más.
"""),

("Registrar una compra o gasto", r"""
# Registrar una compra o gasto

**Dónde:** Contabilidad → **Compras y gastos**

Es tu tarea más frecuente: registrar la factura de un proveedor o contratista, con sus
retenciones. Al guardarla, **el asiento contable se genera solo**.

## Paso 1 — (si es nuevo) crea el proveedor
1. Entra a la pestaña **Proveedores**.
2. Haz clic en **Nuevo proveedor**, escribe **nombre/razón social** y **NIT**, y guarda.

## Paso 2 — registra la factura
1. En la pestaña **Facturas de compra**, haz clic en **Nueva factura**.
2. Elige el **proveedor**.
3. Escribe el **número** de la factura, la **fecha** y el **vencimiento**.
4. Escribe el **subtotal** (valor antes de IVA).
5. Elige el **IVA** descontable si aplica.
6. Indica la **naturaleza**: gasto/servicio o inventario/material.
7. Marca las **retenciones** a practicar. A la derecha verás el monto de cada una.

## Paso 3 — revisa y guarda
Antes de guardar, el sistema te muestra una **vista previa** con: subtotal, IVA, total de
la factura, retenciones y **neto a pagar** al proveedor. Verifica que cuadre con la
factura física y haz clic en **Registrar factura**.

> **Qué hace el sistema por ti:** descuenta las retenciones del pago al proveedor, las
> registra como impuestos por pagar a la DIAN, y arma el asiento contable completo y
> cuadrado — sin que tengas que digitarlo.
"""),

("Pagar a un proveedor", r"""
# Pagar a un proveedor

**Dónde:** Contabilidad → **Compras y gastos** (pestaña Facturas)

Cuando vas a pagar una factura registrada:

## Paso a paso
1. Ubica la factura en la lista (las pendientes tienen estado **Pendiente** o **Parcial**).
2. Haz clic en el botón **Pagar**.
3. Elige la **cuenta bancaria** desde la que sale el dinero.
4. Confirma el **monto** (viene precargado con el saldo; puedes pagar parcial).
5. Pon la **fecha** y, si quieres, una **referencia** (número de comprobante de egreso).
6. Haz clic en **Registrar pago**.

## Qué pasa después
- El **saldo** de la factura baja. Si pagas todo, queda en estado **Pagada**.
- Se registra la **salida del banco** y el abono a la cuenta por pagar, en su asiento.

> **Tip:** puedes hacer **pagos parciales**. La factura quedará "Parcial" y podrás
> completar el pago más adelante.
"""),

("Cuentas por pagar", r"""
# Cuentas por pagar

**Dónde:** Contabilidad → **Cuentas por pagar**

Muestra todo lo que la empresa le debe a proveedores y contratistas, ordenado por
antigüedad.

## Qué vas a ver
- El **saldo pendiente** de cada proveedor.
- Un **análisis de antigüedad** por rangos: corriente, 1–30, 31–60, 61–90 y +90 días.

## Cómo usarlo
Te ayuda a **priorizar pagos**: lo más vencido primero. Es la base para planear la caja
de la semana.

> **Tip:** revísalo antes de programar pagos. Lo que aparece en +90 días merece atención
> inmediata.
"""),

("Libros: diario y mayor", r"""
# Libros: diario y mayor

**Dónde:** Contabilidad → **Libros contables**

Es donde consultas los registros contables ("asientos"). Tiene dos vistas:

## Libro diario
La lista de **todos los asientos** en orden de fecha. Útil para revisar qué se registró
un día o de dónde viene un movimiento.

## Libro mayor
El detalle de **una sola cuenta**: eliges la cuenta y ves su saldo inicial, cada
movimiento y el saldo corriente.

## Cómo consultar el mayor de una cuenta
1. Entra a la pestaña **Mayor**.
2. Elige la **cuenta** que quieres revisar.
3. (Opcional) filtra por rango de fechas.

> **Importante:** los asientos **no se borran ni se editan**. Si algo quedó mal, se
> corrige con un asiento de **reversión**. Esto es a propósito: protege la auditoría.
"""),

("Asientos recurrentes", r"""
# Asientos recurrentes

**Dónde:** Contabilidad → **Asientos recurrentes**

Para registros que se repiten cada mes (arriendos, amortizaciones, provisiones), defines
una **plantilla** y el sistema los genera solo.

## Cómo crear una plantilla
1. Haz clic en **Nueva plantilla**.
2. Ponle un **nombre** (ej. "Arriendo oficina").
3. Elige la **frecuencia** (mensual, trimestral, anual) y la **fecha de la primera
   ejecución**.
4. Agrega las **líneas** del asiento (cuentas con su débito o crédito). Abajo verás si
   **cuadra** (débito = crédito).
5. Guarda.

## Cómo se ejecutan
El sistema las genera automáticamente cuando llega su fecha. También puedes adelantarlas
con el botón **Ejecutar vencidas**.

> **Beneficio:** eliminas el trabajo repetitivo y los errores de digitar lo mismo cada
> mes.
"""),

("Activos fijos y depreciación", r"""
# Activos fijos y depreciación

**Dónde:** Contabilidad → **Activos fijos**

Maneja los equipos y bienes de la empresa: alta, **depreciación mensual automática** y
baja o venta.

## Registrar un activo
1. Haz clic en **Nuevo activo**.
2. Escribe **código** y **nombre**, elige la **categoría** (define la vida útil).
3. Pon el **costo de adquisición**, el **valor residual** y la **fecha de compra**.
4. (Opcional) deja marcada la casilla para generar el asiento de capitalización.
5. Guarda.

## Depreciación
El sistema deprecia **solo, una vez al mes**. También puedes ejecutarla manualmente desde
la pestaña **Depreciación** eligiendo año y mes.

## Dar de baja o vender
Desde la lista, usa **Dar de baja** e indica la fecha y el valor de venta (0 si es
retiro). El sistema calcula la utilidad o pérdida y arma el asiento.

> **Tranquilidad:** la depreciación no se duplica si la ejecutas dos veces; el sistema
> lleva el control por activo y mes.
"""),

("Conciliación bancaria", r"""
# Conciliación bancaria

**Dónde:** Contabilidad → **Conciliación**

Sirve para cuadrar lo que dice el **banco** (extracto) contra lo que dice tu
**contabilidad**.

## Cómo conciliar
1. Elige la **cuenta bancaria**.
2. Verás dos columnas: los **movimientos del libro** y las **líneas del extracto**.
3. Usa **conciliación automática** para que el sistema empareje por monto.
4. Lo que quede suelto, **emparéjalo manualmente** (movimiento ↔ línea del extracto).
5. Lo que no concilie (comisiones, cheques no cobrados, GMF) queda pendiente para
   investigar.

> **Tip:** concilia bancos **antes de cerrar el mes**. Es la mejor forma de detectar
> movimientos faltantes o dobles.
"""),

("Informes financieros", r"""
# Informes financieros

**Dónde:** Contabilidad → **Balance y estados** (Informes)

Aquí están los estados financieros oficiales, calculados en vivo. Pestañas disponibles:

| Informe | Te responde |
|---|---|
| Balance de comprobación | ¿Cuadra la contabilidad? |
| Balance general | ¿Qué tengo, qué debo, mi patrimonio? |
| Estado de resultados | ¿Cómo va el resultado del periodo? |
| Flujo de efectivo | ¿Cómo se movió el efectivo? |

## Exportar
En cada pestaña tienes botones **PDF** y **Excel**:
- **PDF:** abre una vista lista para imprimir o guardar.
- **Excel:** descarga el informe para trabajarlo en hoja de cálculo.

> **Tip:** el **balance de comprobación** es tu validación maestra. Si no cuadra, revisa
> antes de cerrar el mes.
"""),

("Certificados de retención", r"""
# Certificados de retención

**Dónde:** Contabilidad → **Certificados de retención**

Como la empresa es **agente retenedor**, debe entregar a sus proveedores el certificado
de las retenciones que les practicó en el año. Aquí los generas.

## Cómo generar un certificado
1. Elige el **año gravable**.
2. Verás la lista de **proveedores** con retenciones y su total.
3. Haz clic en **Certificado** junto al proveedor.
4. Se abre el certificado **listo para imprimir o guardar como PDF**.

## Qué incluye
El certificado muestra los datos de la empresa, los del proveedor y el total retenido por
concepto (ReteFuente, ReteIVA, ReteICA), con el detalle de los documentos.

> **Nota:** si los datos de la empresa (razón social, NIT) salen vacíos, pídele al área
> de sistemas que los configure una sola vez.
"""),

("Cierre de mes y de año", r"""
# Cierre de mes y de año

**Dónde:** Contabilidad → **Cierre contable**

Controla qué meses están abiertos para registrar y ejecuta los cierres.

## Estados de un periodo
- **Abierto:** admite registros.
- **Cerrado:** no admite registros (se puede reabrir).
- **Bloqueado:** cerrado definitivo.

## Rutina de cierre mensual sugerida
1. **Conciliar** los bancos.
2. Correr la **depreciación** del mes.
3. Registrar **provisiones / recurrentes**.
4. Revisar el **balance de comprobación** (debe cuadrar).
5. **Cerrar el mes**.

## Cierre de año
La opción de **cierre anual** lleva los resultados del año (ingresos, costos, gastos) a
resultados acumulados y deja las cuentas listas para el nuevo año.

> **Por qué importa:** cerrar un mes **protege la información** ya reportada: impide que
> alguien modifique periodos pasados por error.
"""),

("Preguntas frecuentes", r"""
# Preguntas frecuentes

**¿Por qué no puedo registrar en un mes anterior?**
Probablemente ese mes ya está **cerrado**. Pídele al responsable que lo reabra si de
verdad necesitas registrar ahí.

**Registré una factura con un error, ¿la borro?**
No se borran asientos. Se corrige con una **reversión** o registrando el ajuste correcto.
Esto mantiene la trazabilidad para auditoría.

**¿Por qué el saldo del proveedor es menor que el total de la factura?**
Porque se le **retuvo** (ReteFuente/ReteIVA/ReteICA). Al proveedor se le paga el **neto**;
la diferencia es de la DIAN y aparece como impuesto por pagar.

**¿Dónde veo cuánto le retuve a un proveedor en el año?**
En **Certificados de retención**: elige el año y genera su certificado.

**Un informe muestra una cifra rara, ¿qué hago?**
Baja al detalle: revisa el **libro mayor** de la cuenta o el documento que originó el
movimiento (factura o pago).

**¿Tengo que digitar los asientos?**
No. Al registrar compras y pagos, **el sistema arma los asientos solo**. Tu rol es
capturar bien y **revisar**.

> **Regla de oro:** captura el documento tal como es, revisa la vista previa antes de
> guardar, y concilia/valida antes de cerrar el mes. El resto lo hace el sistema.
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
  @bottom-center {{ content: "Manual de Usuario · Contabilidad · Nexus ERP"; font-family: Arial, sans-serif; font-size: 8pt; color: {INK_3}; }}
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
.cover h1 {{ font-size: 33pt; line-height: 1.08; margin: 0 0 6mm 0; color: {INK}; font-weight: 800; border: none; padding: 0; }}
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
  <div class="eyebrow">Nexus ERP / Manual de Usuario</div>
  <h1>Contabilidad <span class="accent">paso a paso</span></h1>
  <div class="sub">Guia practica para el contador y el auxiliar: como registrar compras y
  gastos con retenciones, pagar proveedores, revisar informes, emitir certificados y
  cerrar el mes — pantalla por pantalla, sin tecnicismos.</div>
  <div class="meta">
    <div><strong>BHDC</strong> / Manual de Usuario - Contabilidad</div>
    <div>{len(SECTIONS)} temas</div>
  </div>
</div>

<div class="toc">
  <h2>Contenido</h2>
  <p class="lead">Cada tema explica para que sirve la pantalla y como usarla paso a paso,
  con consejos practicos.</p>
  <ol class="toc-list">
  {toc_items}
  </ol>
</div>

{sections_html}

</body></html>"""

HTML(string=DOC, base_url=str(ROOT)).write_pdf(str(OUT))
print(f"OK -> {OUT}")
