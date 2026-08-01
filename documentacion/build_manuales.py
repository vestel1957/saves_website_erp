#!/usr/bin/env python3
"""Genera los MANUALES DE USO por rol del sistema SAVES (ISP Vestel) en PDF.

Tema "Azul Vestel": el azul del logo como color principal, presentación
corporativa (portada con ficha del documento, índice con números de página,
capítulos numerados, encabezado y pie corridos) y CAPTURAS DE PANTALLA reales
del sistema incrustadas en la sección que corresponde.

Las capturas no se insertan a mano: cada sección de las fuentes ya declara su
ruta ("**Dónde:** ... (ruta `/tesoreria/apertura`)"), y si existe el PNG
correspondiente en documentacion/capturas/ se incrusta solo, numerado como
"Figura 3.2". Para generarlas:

    SAVES_USER=... SAVES_PASS=... node documentacion/capturar_pantallas.mjs

Uso:
    python3 documentacion/build_manuales.py                # todos
    python3 documentacion/build_manuales.py caja tecnicos  # solo esos
    python3 documentacion/build_manuales.py --out DIR --sin-figuras
"""
import argparse
import base64
import re
import sys
from datetime import date
from pathlib import Path

import markdown
from weasyprint import HTML

ROOT = Path("/home/dev/saves")
SRC = ROOT / "documentacion" / "fuentes"
OUT_DEFAULT = ROOT / "documentacion" / "manuales"
SHOTS = ROOT / "documentacion" / "capturas"
CACHE = SHOTS / ".opt"
LOGO = ROOT / "frontend" / "public" / "logo-vestel.png"
COMUN = SRC / "_comun.md"

VERSION = "1.0"

# --- Paleta "Azul Vestel", muestreada del logo ------------------------------
NAVY = "#0b2059"        # el azul oscuro del arranque del wordmark
NAVY_2 = "#132f74"      # navy a medio camino, para degradados
BRAND = "#0a5ca8"       # el azul medio del logo: color principal
BRAND_2 = "#1592d0"     # azul claro del final del degradado
BRAND_SOFT = "#eaf3fb"  # fondo suave para tablas y cintillos
BRAND_LINE = "#c3dcf0"  # bordes teñidos de azul
SILVER = "#aab8c6"      # la plata de "TEL"
INK, INK_2, INK_3 = "#0d1526", "#3d4a60", "#6b7a90"
BORDER, CANVAS = "#dde5ee", "#f6f9fc"
AMBER, AMBER_SOFT, AMBER_INK = "#d97706", "#fdf6e9", "#7c4a06"

MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
HOY = date.today()
FECHA = f"{HOY.day} de {MESES[HOY.month]} de {HOY.year}"
PERIODO = f"{HOY.year}.{HOY.month:02d}"

DOCS = [
    dict(slug="superadministrador", kicker="Manual de uso", code="SUP",
         title="Manual del Superadministrador",
         subtitle="Usuarios, roles, acceso y seguridad",
         dirigido="Superadministrador del sistema",
         filename="Manual SAVES Vestel - del Superadministrador.pdf"),
    dict(slug="gerencia", kicker="Manual de uso", code="GER",
         title="Manual de Gerencia",
         subtitle="Panel ejecutivo, reportes y aprobacion de compras",
         dirigido="Direccion y gerencia",
         filename="Manual SAVES Vestel - de Gerencia.pdf",
         anexos=["_reportes"]),
    dict(slug="administracion", kicker="Manual de uso", code="ADM",
         title="Manual de Administracion",
         subtitle="Clientes, inventario, compras y personal",
         dirigido="Personal administrativo",
         filename="Manual SAVES Vestel - de Administracion.pdf",
         anexos=["_reportes"]),
    dict(slug="contabilidad", kicker="Manual de uso", code="CON",
         title="Manual de Contabilidad y Facturacion",
         subtitle="Facturacion, notas, factura electronica y contabilidad",
         dirigido="Area de contabilidad y facturacion",
         filename="Manual SAVES Vestel - de Contabilidad y Facturacion.pdf",
         anexos=["_reportes"]),
    dict(slug="caja", kicker="Manual de uso", code="CAJ",
         title="Manual de Caja y Ventas",
         subtitle="Caja diaria, cobros y ventas",
         dirigido="Cajeros y personal de ventas",
         filename="Manual SAVES Vestel - de Caja y Ventas.pdf"),
    dict(slug="tecnicos", kicker="Manual de uso", code="TEC",
         title="Manual de Tecnicos",
         subtitle="Soporte tecnico y operacion de red",
         dirigido="Tecnicos de soporte y red",
         filename="Manual SAVES Vestel - de Tecnicos.pdf"),
    dict(slug="sistemas", kicker="Manual de uso", code="SIS",
         title="Manual de Sistemas",
         subtitle="Configuracion, WhatsApp y automatizaciones",
         dirigido="Area de sistemas",
         filename="Manual SAVES Vestel - de Sistemas.pdf"),
    dict(slug="contador", kicker="Manual de uso", code="CTD",
         title="Manual del Contador",
         subtitle="Libros, estados financieros y mapeo de cuentas",
         dirigido="Contador publico",
         filename="Manual SAVES Vestel - del Contador.pdf",
         anexos=["_reportes"]),
    dict(slug="jefe-bodega", kicker="Manual de uso", code="BOD",
         title="Manual del Jefe de Bodega",
         subtitle="Material, equipos y despacho de inventario",
         dirigido="Jefe de bodega",
         filename="Manual SAVES Vestel - del Jefe de Bodega.pdf"),
    dict(slug="rrhh", kicker="Manual de uso", code="RRH",
         title="Manual de Recursos Humanos",
         subtitle="Empleados, cuadrillas y accesos al sistema",
         dirigido="Direccion de recursos humanos",
         filename="Manual SAVES Vestel - de Recursos Humanos.pdf"),
    dict(slug="auditoria", kicker="Manual de uso", code="AUD",
         title="Manual de Auditoria y Consulta",
         subtitle="Revision de cifras y rastros de auditoria (solo lectura)",
         dirigido="Auditoria interna y consulta",
         filename="Manual SAVES Vestel - de Auditoria y Consulta.pdf",
         anexos=["_reportes"]),
    dict(slug="_matriz-roles", kicker="Referencia tecnica", code="MTZ",
         title="Matriz de Roles y Permisos",
         subtitle="Que rol puede que, en que pantalla y con que permiso",
         dirigido="Superadministrador y auditoria",
         filename="SAVES Vestel - Matriz de Roles y Permisos.pdf",
         comun=False),
]

logo_b64 = base64.b64encode(LOGO.read_bytes()).decode()
md = markdown.Markdown(extensions=["tables", "sane_lists", "fenced_code", "toc"])

# Las fuentes del PDF no traen pictogramas. El rango de flechas queda FUERA a
# propósito: "→" aparece en cada ruta de menú y borrarlo las dejaba ilegibles.
EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE0F\U000020E3]",
    flags=re.UNICODE,
)
clean = lambda s: EMOJI.sub("", s)

VINETA = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+")


def normaliza_md(texto: str) -> str:
    """Repara las listas que el redactor escribe sin línea en blanco delante.

    `sane_lists` exige un renglón vacío antes de una lista; sin él, python-markdown
    la pega al párrafo anterior y en el PDF salía "aclaraciones: - Caja: ... -
    Movimiento: ..." todo corrido, que es justo lo que hace ver un documento
    amateur. En vez de pedirle al redactor que recuerde la regla, se inserta la
    línea aquí (también dentro de las citas `>`), y de paso se lleva la sangría
    de las sublistas a los 4 espacios que la librería necesita para anidarlas.
    """
    salida, previa = [], ""
    for linea in texto.split("\n"):
        m_cita = re.match(r"^(>\s?)+", linea)
        pref = m_cita.group(0) if m_cita else ""
        cuerpo = linea[len(pref):]
        m = VINETA.match(cuerpo)
        if m:
            sangria = len(m.group(1))
            if sangria and sangria % 4:
                cuerpo = " " * (4 * round(sangria / 4) or 4) + cuerpo.lstrip()
            p_prev = re.sub(r"^(>\s?)+", "", previa)
            if (p_prev.strip() and not VINETA.match(p_prev)
                    and not p_prev.startswith(("    ", "\t"))):
                salida.append(pref.rstrip() if pref else "")
        linea = pref + cuerpo
        salida.append(linea)
        previa = linea
    return "\n".join(salida)

CSS = f"""
@page {{
  size: A4;
  margin: 26mm 18mm 20mm 18mm;
  @top-left {{ content: element(runhdr); vertical-align: middle; }}
  @bottom-left {{
    content: string(capitulo);
    font-size: 7.8pt; color: {INK_3}; vertical-align: top; padding-top: 3.5mm;
  }}
  @bottom-center {{
    content: "Uso interno";
    font-size: 7.8pt; color: {SILVER}; vertical-align: top; padding-top: 3.5mm;
  }}
  @bottom-right {{
    content: counter(page) " / " counter(pages);
    font-size: 8pt; font-weight: 700; color: {BRAND};
    vertical-align: top; padding-top: 3.4mm;
  }}
}}
@page cover {{
  margin: 0;
  @top-left {{ content: none; }} @bottom-left {{ content: none; }}
  @bottom-center {{ content: none; }} @bottom-right {{ content: none; }}
}}
@page indice {{ @bottom-left {{ content: "Contenido"; }} }}

#runhdr {{
  position: running(runhdr);
  width: 174mm;
  border-bottom: 0.75pt solid {BRAND_LINE};
  padding-bottom: 2mm;
  font-size: 8.2pt; color: {INK_3};
}}
#runhdr table {{ width: 100%; border-collapse: collapse; margin: 0; }}
#runhdr td {{ border: 0; padding: 0; vertical-align: middle; }}
/* El PNG del logo mide 200 px de ancho: pasado de ~24mm se ve pixelado. */
#runhdr img {{ width: 21mm; }}
#runhdr .doc {{ text-align: right; color: {NAVY}; font-weight: 700; }}
#runhdr .doc span {{ color: {SILVER}; font-weight: 400; }}

html {{
  /* Liberation Sans imprime más estrecha y neutra que DejaVu (que se lee como
     "el default de Linux"); DejaVu queda de respaldo por las flechas "→". */
  font-family: "Liberation Sans", "DejaVu Sans", sans-serif;
  color: {INK}; font-size: 10.3pt; line-height: 1.55;
}}
p {{ orphans: 2; widows: 2; }}

/* ---------- Portada ---------- */
.cover {{
  page: cover; height: 297mm; width: 210mm; position: relative;
  page-break-after: always;
  /* La portada es una sola pieza de color de borde a borde: el degradado va en
     la propia página (@page cover no tiene margen) en vez de en una franja
     superior con el resto en blanco. */
  background:
    radial-gradient(70mm 46mm at 82% 16%, rgba(255,255,255,0.17), rgba(255,255,255,0) 72%),
    radial-gradient(90mm 60mm at 8% 92%, rgba(21,146,208,0.30), rgba(21,146,208,0) 70%),
    linear-gradient(152deg, {NAVY} 0%, {NAVY_2} 38%, {BRAND} 76%, {BRAND_2} 100%);
}}
.cover .kicker {{
  position: absolute; left: 24mm; top: 112mm;
  font-size: 9pt; letter-spacing: 3.6px; text-transform: uppercase;
  color: rgba(255,255,255,0.78); font-weight: 700;
}}
.cover h1.tit {{
  position: absolute; left: 24mm; right: 24mm; top: 122mm;
  font-size: 30pt; line-height: 1.12; color: #fff; font-weight: 700;
  margin: 0; padding: 0; border: 0;
}}
/* Tarjeta blanca para el logo: el wordmark es azul oscuro y sobre el degradado
   se perdería. La tarjeta lo aísla y de paso ancla la portada. */
.cover .card {{
  position: absolute; left: 24mm; top: 34mm;
  background: #fff; padding: 7mm 9mm; border-radius: 2mm;
  box-shadow: 0 2mm 7mm rgba(11,32,89,0.30);
}}
/* 38 mm, no más: el PNG mide 200 px de ancho y a 50 mm caía a ~100 ppp, que en
   papel se ve dentado. A 38 mm son ~134 ppp y el wordmark queda limpio. Con un
   logo vectorial o un PNG grande esto se puede volver a subir. */
.cover .card img {{ width: 38mm; height: auto; display: block; }}
.cover .body {{ position: absolute; left: 24mm; right: 24mm; top: 166mm; }}
.cover .subtitle {{
  font-size: 12.5pt; color: rgba(255,255,255,0.86); margin: 0 0 7mm 0; line-height: 1.45;
}}
.cover .rule {{ width: 30mm; height: 3.5px; background: {BRAND_2}; margin-bottom: 8mm; }}

/* Ficha del documento: da el aire de documento controlado de empresa. Sobre el
   azul va en un panel translúcido — un recuadro blanco encima del degradado
   partiría la portada justo lo que se quiere evitar. */
.cover .ficha {{
  width: 100%; border-collapse: collapse; font-size: 9pt;
  background: rgba(255,255,255,0.07);
}}
.cover .ficha td {{
  padding: 2.6mm 4mm; border-bottom: 0.5pt solid rgba(255,255,255,0.18);
  vertical-align: top;
}}
.cover .ficha tr:last-child td {{ border-bottom: 0; }}
/* Mata el rayado de las tablas del cuerpo: sobre el azul, la banda clara de las
   filas pares dejaba el texto blanco ilegible. */
.cover .ficha tr:nth-child(even) td {{ background: transparent; }}
.cover .ficha td.k {{
  color: rgba(255,255,255,0.62); width: 34mm; text-transform: uppercase;
  font-size: 7.6pt; letter-spacing: 0.7px; padding-top: 3.2mm;
}}
.cover .ficha td.v {{ color: #fff; font-weight: 700; }}
.cover .clasif {{
  display: inline-block; padding: 1.6mm 4mm;
  background: rgba(255,255,255,0.14); color: #fff;
  border: 0.75pt solid rgba(255,255,255,0.35);
  border-radius: 8mm; font-size: 8pt; font-weight: 700; letter-spacing: 0.4px;
}}
.cover .footband {{
  position: absolute; bottom: 0; left: 0; right: 0; height: 3mm;
  background: linear-gradient(90deg, {BRAND_2} 0%, {SILVER} 100%);
}}
.cover .empresa {{
  position: absolute; bottom: 12mm; left: 24mm; right: 24mm;
  font-size: 8pt; color: rgba(255,255,255,0.60);
}}

/* ---------- Índice ---------- */
.indice {{ page: indice; page-break-after: always; }}
.indice h2.tit {{
  border: 0; padding: 0; margin: 0 0 5mm 0;
  font-size: 19pt; color: {NAVY}; font-weight: 700;
}}
.indice h2.tit {{ margin-bottom: 5mm; }}
.indice ul {{ list-style: none; margin: 0; padding: 0; }}
.indice li.n1 {{
  margin: 2.9mm 0 0.9mm 0; font-weight: 700; font-size: 10.4pt; color: {NAVY};
  border-top: 0.75pt solid {BORDER}; padding-top: 1.5mm;
}}
.indice li.n2 {{ margin: 0 0 0.3mm 6mm; font-size: 9.2pt; color: {INK_2}; }}
.indice li.n3 {{ margin: 0 0 0.35mm 13mm; font-size: 8.5pt; color: {INK_3}; }}
.indice a {{ text-decoration: none; color: inherit; }}
/* WeasyPrint resuelve el número de página del destino: el índice se mantiene
   solo, sin que nadie lo actualice a mano. */
.indice a::after {{
  content: " " leader('.') " " target-counter(attr(href), page);
  color: {INK_3}; font-weight: 400;
}}
.indice li.n1 a::after {{ color: {BRAND}; font-weight: 700; }}

/* Clave de lectura al pie del índice. */
.leyenda {{
  margin: 0 0 6mm 0; padding: 3mm 4mm;
  /* Cuando cae al final del índice no debe quedar pegada al último renglón. */
  background: {CANVAS}; border: 0.75pt solid {BORDER}; border-radius: 2mm;
  page-break-inside: avoid;
}}
.leyenda .tt {{
  font-size: 7.6pt; font-weight: 700; letter-spacing: 1.1px;
  text-transform: uppercase; color: {BRAND}; margin-bottom: 2.5mm;
}}
.leyenda table {{ width: 100%; border-collapse: collapse; margin: 0; font-size: 8.5pt; }}
.leyenda td {{ border: 0; padding: 0.9mm 0; vertical-align: middle; background: none; }}
.leyenda td.s {{ width: 8mm; }}
.leyenda td.k {{ width: 26mm; color: {NAVY}; font-weight: 700; }}
.leyenda .ic {{
  display: inline-block; width: 4.5mm; height: 4.5mm; border-radius: 1mm;
  vertical-align: middle;
}}
.leyenda .ic.ruta {{ background: {BRAND_SOFT}; border-left: 1.6mm solid {BRAND}; }}
.leyenda .ic.tip {{ background: {BRAND_SOFT}; border-left: 1.6mm solid {BRAND_2}; }}
.leyenda .ic.warn {{ background: {AMBER_SOFT}; border-left: 1.6mm solid {AMBER}; }}
.leyenda .ic.fig {{ background: #fff; border: 0.75pt solid {BRAND_LINE}; }}

/* ---------- Capítulos ---------- */
.content {{ counter-reset: cap; }}
/* Todo cuelga de .content a propósito: el <h1> de la portada NO es capítulo. */
.content h1 {{
  font-size: 17pt; color: {NAVY}; font-weight: 700;
  margin: 0 0 5mm 0; padding: 0 0 3.5mm 0;
  border-bottom: 2.5px solid {BRAND_2};
  page-break-before: always; page-break-after: avoid;
  bookmark-level: 1; string-set: capitulo content(text);
  counter-increment: cap; counter-reset: fig;
}}
.content > h1:first-of-type {{ page-break-before: avoid; }}
/* Número de capítulo en cuadro navy: permite citar "capítulo 3" en soporte. */
.content h1::before {{
  content: counter(cap);
  display: inline-block; min-width: 8.5mm; margin-right: 4mm;
  padding: 1mm 2mm; text-align: center;
  background: {NAVY}; color: #fff; border-radius: 1.5mm;
  font-size: 13pt;
}}
.content h2 {{
  font-size: 12.8pt; color: {NAVY}; font-weight: 700;
  margin: 7.5mm 0 2.5mm 0; padding: 0 0 0 3.5mm;
  border-left: 4px solid {BRAND_2};
  page-break-after: avoid; bookmark-level: 2;
}}
.content h3 {{
  font-size: 11pt; color: {BRAND}; font-weight: 700;
  margin: 5mm 0 1.5mm 0; page-break-after: avoid; bookmark-level: 3;
}}
/* PROBADO Y DESCARTADO: pegar el primer párrafo de una sección a lo que viene
   detrás (`.content h2 + p {{ page-break-after: avoid }}`) evita el título
   huérfano al pie, pero arrastra la tabla entera al otro lado del salto. En la
   matriz de roles pasó de 1 a 5 páginas casi vacías. El título huérfano ocasional
   sale más barato. */
p {{ margin: 0 0 2.6mm 0; }}
strong {{ color: {NAVY}; }}
a {{ color: {BRAND}; text-decoration: none; }}
ul {{ margin: 0 0 3mm 0; padding-left: 6.5mm; }}
li {{ margin-bottom: 1.4mm; }}
ul > li::marker {{ color: {BRAND_2}; }}
ol {{ margin: 0 0 3mm 0; padding-left: 6.5mm; }}
ol > li::marker {{ color: {BRAND}; font-weight: 700; }}

/* Los pasos numerados de primer nivel llevan viñeta circular azul: son lo que
   el empleado sigue con el dedo mientras opera el sistema. */
.content > ol {{ list-style: none; counter-reset: paso; padding-left: 9.5mm; }}
.content > ol > li {{ counter-increment: paso; position: relative; margin-bottom: 2mm; }}
.content > ol > li::before {{
  content: counter(paso);
  position: absolute; left: -9.5mm; top: 0.2mm;
  width: 6.2mm; height: 6.2mm; line-height: 6.2mm; text-align: center;
  background: {BRAND}; color: #fff; border-radius: 3.1mm;
  font-size: 8pt; font-weight: 700;
}}

/* Rótulos de arranque de párrafo ("Para qué sirve:", "Paso a paso:"). */
p.lead > strong:first-child {{
  color: {BRAND}; text-transform: uppercase;
  font-size: 8.4pt; letter-spacing: 0.9px;
}}

/* La línea "Dónde:" es lo que más se busca en estos manuales: se convierte en
   una barra de ruta en vez de un párrafo más. */
p.ruta {{
  background: {BRAND_SOFT}; border-left: 4px solid {BRAND};
  border-radius: 0 2mm 2mm 0; padding: 2.2mm 3.5mm; margin: 0 0 3mm 0;
  font-size: 9.5pt; color: {NAVY}; page-break-inside: avoid;
  /* La barra de ruta y la foto de esa pantalla son una sola cosa: separarlas
     deja la ruta colgando al pie de una página y la captura al principio de la
     siguiente. */
  page-break-after: avoid;
}}
p.ruta strong {{ color: {BRAND}; }}
p.ruta em {{ font-style: normal; font-weight: 700; }}

/* ---------- Capturas de pantalla ---------- */
figure.shot {{
  margin: 3mm 0 5mm 0; padding: 0; counter-increment: fig;
  page-break-inside: avoid;
}}
/* El tope de altura es lo que decide cuántos huecos deja el documento: una
   captura de 1440x900 a 174 mm de ancho mide 109 mm de alto y, cuando no cabe,
   se lleva media página en blanco. Limitada a 96 mm entra en casi cualquier
   resto de página y el texto de la interfaz se sigue leyendo. */
figure.shot img {{
  max-width: 100%; max-height: 88mm; display: block; margin: 0 auto;
  border: 0.75pt solid {BRAND_LINE}; border-radius: 1.5mm;
  box-shadow: 0 1mm 3mm rgba(11,32,89,0.13);
}}
figure.shot figcaption {{
  margin-top: 2mm; font-size: 8.2pt; color: {INK_3}; line-height: 1.35;
  text-align: center;
}}
figure.shot figcaption .ref {{ color: {SILVER}; }}
/* La numeración es por capítulo (Figura 3.2) y la lleva el contador, no el
   texto: así reordenar secciones no obliga a renumerar nada a mano. */
figure.shot figcaption::before {{
  content: "Figura " counter(cap) "." counter(fig) " · ";
  color: {BRAND}; font-weight: 700;
}}
figure.shot figcaption b {{ color: {NAVY}; font-weight: 700; }}

/* ---------- Tablas ---------- */
table {{
  width: 100%; border-collapse: collapse; margin: 2.5mm 0 4.5mm 0;
  font-size: 9.2pt; page-break-inside: avoid;
}}
/* Las tablas largas (el glosario, la matriz de roles) SÍ se parten: lo que no
   puede pasar es que la mitad de abajo quede sin encabezado, porque entonces la
   segunda página es una lista de casillas sin nombre. */
thead {{ display: table-header-group; }}
tr {{ page-break-inside: avoid; }}
th {{
  background: {NAVY}; color: #fff; text-align: left;
  padding: 2.3mm 2.6mm; font-weight: 700; font-size: 8.8pt;
  letter-spacing: 0.3px;
}}
td {{ padding: 2mm 2.6mm; border-bottom: 0.5px solid {BORDER}; vertical-align: top; }}
tr:nth-child(even) td {{ background: {CANVAS}; }}
td:first-child {{ color: {NAVY}; font-weight: 700; }}

/* ---------- Avisos ---------- */
blockquote {{
  margin: 3.5mm 0; padding: 2.8mm 4mm 2.8mm 4mm;
  background: {BRAND_SOFT}; border-left: 4px solid {BRAND_2};
  border-radius: 0 2mm 2mm 0; color: {INK_2};
  page-break-inside: avoid;
  /* Un aviso NUNCA empieza página. Sin esto, el que no cabía al pie se iba
     entero a la hoja siguiente y —si justo después arrancaba un capítulo, que
     sí fuerza salto— se quedaba solo en una página en blanco. Al prohibir el
     corte por delante, el salto se busca antes y el aviso viaja con el texto
     que explica. */
  page-break-before: avoid;
}}
blockquote::before {{
  content: "Consejo"; display: block;
  font-size: 7.4pt; font-weight: 700; letter-spacing: 1.1px;
  text-transform: uppercase; color: {BRAND}; margin-bottom: 1.2mm;
}}
blockquote.warn {{ background: {AMBER_SOFT}; border-left-color: {AMBER}; color: {AMBER_INK}; }}
blockquote.warn::before {{ content: "Importante"; color: {AMBER}; }}
blockquote.warn strong {{ color: {AMBER_INK}; }}
blockquote p {{ margin: 0 0 1.5mm 0; }}
blockquote p:last-child {{ margin-bottom: 0; }}
blockquote ul, blockquote ol {{ margin-bottom: 0; }}
blockquote p.lead > strong:first-child {{
  text-transform: none; font-size: inherit; letter-spacing: 0; color: inherit;
}}

code {{
  font-family: "DejaVu Sans Mono", monospace; font-size: 8.6pt;
  background: #fff; color: {NAVY};
  padding: 0.4mm 1.4mm; border-radius: 1mm;
  border: 0.5px solid {BRAND_LINE};
}}
hr {{ border: 0; border-top: 0.75pt solid {BORDER}; margin: 6mm 0; }}
"""

# --- Realces sobre el HTML ya convertido ------------------------------------
RE_RUTA = re.compile(r"<p><strong>D[oó]nde:</strong>", re.I)
# "**Captura:** clientes-ficha — Ficha del cliente, pestaña Servicios."
RE_CAPTURA = re.compile(
    r"<p><strong>Captura:</strong>\s*([a-z0-9\-]+)\s*(?:[—–-]\s*(.*?))?</p>", re.S | re.I)
RE_LEAD = re.compile(r"<p>(<strong>[^<]{2,40}:</strong>)")
# Una cita es advertencia si la fuente avisa de un riesgo, no si da un consejo.
PAL_WARN = ("ojo", "nunca", "cuidado", "no se puede", "no borres", "irreversible",
            "regla de oro", "importante", "no elimin", "no se puede deshacer")


def optimiza(png: Path) -> Path:
    """Aligera la captura SIN tocar su resolución.

    Una pantalla del ERP es color plano: con 256 colores se ve idéntica y pesa
    un tercio. Reescalarla, en cambio, era contraproducente — el remuestreo mete
    ruido en las zonas planas y el PNG resultante pesaba MÁS que el original
    (701 KB contra 477 KB medidos), además de emborronar el texto de la interfaz.
    """
    try:
        from PIL import Image
    except ImportError:
        return png
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / png.name
    if dest.exists() and dest.stat().st_mtime >= png.stat().st_mtime:
        return dest
    im = recorta_vacio(Image.open(png).convert("RGB"))
    im.quantize(colors=256, method=Image.MEDIANCUT,
                dither=Image.FLOYDSTEINBERG).save(dest, "PNG", optimize=True)
    return dest


def recorta_vacio(im):
    """Quita el vacío del pie de la captura.

    Una pantalla de filtros ocupa media ventana y el resto es fondo liso. Sin
    recortar, el PDF reserva 96 mm para una imagen medio vacía: la interfaz se
    imprime pequeña y la página queda con un hueco. Se mide sólo a la derecha
    del menú lateral (que sí llega hasta abajo) y se deja un margen de aire.
    """
    ancho, alto = im.size
    px = im.load()
    x0 = int(ancho * 0.28)
    muestras = range(x0, ancho, 17)
    for y in range(alto - 1, int(alto * 0.35), -1):
        base = px[x0, y]
        if any(abs(px[x, y][c] - base[c]) > 6 for x in muestras for c in range(3)):
            corte = min(alto, y + int(alto * 0.03))
            return im if corte >= alto - 4 else im.crop((0, 0, ancho, corte))
    return im


NAV = ROOT / "frontend" / "src" / "lib" / "nav.ts"


def _norm(s: str) -> str:
    """Minúsculas sin tildes ni puntuación, para casar rótulos de menú."""
    s = s.lower().strip(" .:*")
    for a, b in zip("áéíóúüñ", "aeiouun"):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s)


def mapa_menu() -> dict:
    """Rótulo del menú → ruta, leído del propio nav del frontend.

    Muchas secciones de los manuales dicen solo "Menú lateral → CLIENTES →
    Administrar clientes" sin la URL entre backticks. En vez de pedirle al
    redactor que agregue rutas a mano, se resuelve el último tramo del camino
    contra el menú real: si mañana cambia el href, la captura sigue casando.
    """
    if not NAV.exists():
        return {}
    txt = NAV.read_text(encoding="utf-8")
    return {_norm(lab): href
            for lab, href in re.findall(r'label:\s*"([^"]+)",\s*href:\s*"([^"]+)"', txt)}


MENU = mapa_menu()


def ruta_de_bloque(bloque: str) -> str | None:
    """Saca la ruta de una barra "Dónde:": primero la URL literal, si no el menú."""
    literal = re.findall(r"<code>(/[^<]+)</code>", bloque)
    if literal:
        return literal[0]
    texto = re.sub(r"<[^>]+>", "", bloque)
    texto = texto.split(":", 1)[-1]
    # El último tramo del camino es la pantalla; los anteriores son secciones.
    tramos = [t for t in re.split(r"→|->|›", texto) if t.strip()]
    for tramo in reversed(tramos):
        href = MENU.get(_norm(tramo))
        if href:
            return href
    return None


def figura(ruta: str, titulo: str, con_figuras: bool) -> str:
    """Devuelve el <figure> de la captura de esa ruta, si existe el PNG."""
    if not con_figuras:
        return ""
    png = SHOTS / (ruta.strip("/").replace("/", "-") + ".png")
    if not png.exists() and "[" in ruta:
        # `/clientes/[id]` no se puede abrir a ciegas: el capturador la saca
        # entrando al primer registro de la lista y la guarda como -ficha.png.
        base = ruta.split("[")[0].strip("/").replace("/", "-").rstrip("-")
        png = SHOTS / f"{base}-ficha.png"
    if not png.exists():
        return ""
    src = optimiza(png).as_uri()
    pie = f"Pantalla <b>{titulo}</b>" if titulo else "Pantalla del sistema SAVES"
    return (f'<figure class="shot"><img src="{src}"/>'
            f'<figcaption>{pie} <span class="ref">· {ruta}</span></figcaption></figure>')


def figura_slug(slug: str, pie: str, con_figuras: bool) -> str:
    """Figura pedida a mano por la fuente: ventanas emergentes y fichas.

    Una parte del manual explica cosas que no son una URL — el modal de
    "Registrar egreso", la ficha de un cliente, la pestaña de permisos — y para
    esas no basta con la ruta. La fuente las pide por nombre y el capturador
    sabe llegar a ellas desde `capturas-extra.json`.
    """
    if not con_figuras:
        return ""
    png = SHOTS / f"{slug}.png"
    if not png.exists():
        print(f"    aviso: falta la captura '{slug}.png'")
        return ""
    src = optimiza(png).as_uri()
    return (f'<figure class="shot"><img src="{src}"/>'
            f'<figcaption>{pie or "Pantalla del sistema SAVES"}</figcaption></figure>')


def realza(body: str, con_figuras: bool) -> tuple[str, int]:
    """Marca rutas, rótulos y avisos, e incrusta la captura de cada pantalla."""
    extra = [0]

    def _cap(m):
        fig = figura_slug(m.group(1), (m.group(2) or "").strip(), con_figuras)
        if fig:
            extra[0] += 1
        return fig

    body = RE_CAPTURA.sub(_cap, body)
    body = RE_RUTA.sub('<p class="ruta"><strong>Dónde:</strong>', body)
    body = RE_LEAD.sub(r'<p class="lead">\1', body)
    # Reponer la clase de las rutas que el paso anterior pudo pisar.
    body = body.replace('<p class="lead"><strong>Dónde:</strong>',
                        '<p class="ruta"><strong>Dónde:</strong>')

    def marca(m):
        interior = m.group(1)
        texto = re.sub(r"<[^>]+>", " ", interior).lower()
        clase = ' class="warn"' if any(p in texto for p in PAL_WARN) else ""
        return f"<blockquote{clase}>{interior}</blockquote>"

    body = re.sub(r"<blockquote>(.*?)</blockquote>", marca, body, flags=re.S)

    # La captura va justo después de la barra "Dónde:", que es donde el lector
    # ya está mirando; el título de la sección (el <h2> anterior) es el pie.
    puestas = [0]
    # Sirve de pie de foto el título más cercano, del nivel que sea. Mirando
    # sólo los <h2> pasaban dos cosas: en el capítulo de reportes las catorce
    # figuras se llamaban igual ("Gerencia - la plata"), y la primera figura de
    # un capítulo heredaba el título de una sección del capítulo ANTERIOR.
    ultimo_h2 = [""]

    def tras_h2(m):
        ultimo_h2[0] = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        return m.group(0)

    def inserta(m):
        bloque = m.group(0)
        ruta = ruta_de_bloque(bloque)
        if not ruta:
            return bloque
        fig = figura(ruta, ultimo_h2[0], con_figuras)
        if fig:
            puestas[0] += 1
        return bloque + fig

    # Un solo barrido en orden para que `ultimo_h2` sea de verdad el anterior.
    body = re.sub(r'<h[123][^>]*>(.*?)</h[123]>|<p class="ruta">.*?</p>',
                  lambda m: tras_h2(m) if m.group(1) is not None else inserta(m),
                  body, flags=re.S)
    return body, puestas[0] + extra[0]


def indice_html(toc_tokens, con_figuras) -> str:
    """Índice de dos niveles. Los números de página los pone WeasyPrint."""
    # El tercer nivel casi no se usa, salvo donde más falta hace: en el capítulo
    # de reportes cada pantalla es un <h3> y sin él los 14 reportes quedan
    # invisibles bajo un solo renglón. Pero un índice de dos páginas deja la
    # segunda con cuatro líneas y el resto en blanco, así que el tercer nivel se
    # incluye SOLO si el índice sigue cabiendo en una hoja. Alturas medidas
    # sobre el PDF, en milímetros.
    def arma(con_n3: bool):
        filas, alto = [], 0.0
        for h1 in toc_tokens:
            filas.append(f'<li class="n1"><a href="#{h1["id"]}">{h1["name"]}</a></li>')
            alto += 8.6
            for h2 in h1.get("children", []):
                filas.append(f'<li class="n2"><a href="#{h2["id"]}">{h2["name"]}</a></li>')
                alto += 5.7
                for h3 in (h2.get("children", []) if con_n3 else []):
                    filas.append(f'<li class="n3"><a href="#{h3["id"]}">{h3["name"]}</a></li>')
                    alto += 5.2
        return filas, alto

    # Caja de texto útil (251 mm) menos el título del índice. Alturas medidas
    # sobre el PDF, no calculadas: sirven para decidir el formato, no para
    # maquetar — de eso se encarga WeasyPrint.
    HOJA, LEYENDA = 239.0, 30.0
    filas, alto = arma(True)
    if alto + LEYENDA > HOJA:
        filas, alto = arma(False)
    # Si aun sin el tercer nivel el índice se sale de la hoja, la leyenda se va
    # al final: al principio empujaba la cola del listado a una segunda página
    # que quedaba con cuatro renglones y el resto en blanco.
    leyenda_arriba = alto + LEYENDA <= HOJA
    # La clave de lectura va ARRIBA, antes de la lista: al pie quedaba a merced
    # de lo que midiera el índice y, en cuanto éste llenaba la página, se
    # marchaba sola a la siguiente con el resto en blanco. La frase suelta que
    # había bajo "Contenido" sobraba —la leyenda dice lo mismo mejor— y esos
    # milímetros son justo los que hacen que el índice quepa en una hoja.
    leyenda = leyenda_html(con_figuras)
    lista = "<ul>" + "".join(filas) + "</ul>"
    cuerpo = (leyenda + lista) if leyenda_arriba else (lista + leyenda)
    return '<div class="indice"><h2 class="tit">Contenido</h2>' + cuerpo + "</div>"


def leyenda_html(con_figuras: bool) -> str:
    """Clave de lectura: qué significa cada recuadro del documento.

    Va al pie del índice, que es la única página que todo el mundo mira antes de
    buscar su pantalla. Sin esto, los recuadros de color se leen como adorno.
    """
    filas = [
        ('<span class="ic ruta"></span>', "Dónde",
         "La ruta exacta del menú para llegar a esa pantalla."),
        ('<span class="ic tip"></span>', "Consejo",
         "Una recomendación para hacer el trabajo más rápido o más seguro."),
        ('<span class="ic warn"></span>', "Importante",
         "Un riesgo real: algo que no se puede deshacer o que descuadra cifras."),
    ]
    if con_figuras:
        filas.append(('<span class="ic fig"></span>', "Figura 3.2",
                      "Foto real de la pantalla. El número es capítulo y orden."))
    celdas = "".join(
        f'<tr><td class="s">{ico}</td><td class="k">{k}</td><td>{v}</td></tr>'
        for ico, k, v in filas)
    return ('<div class="leyenda"><div class="tt">Cómo leer este manual</div>'
            f'<table>{celdas}</table></div>')


def cover_html(doc):
    return f"""
    <div class="cover">
      <div class="kicker">{clean(doc.get("kicker", "Manual de uso"))}</div>
      <h1 class="tit">{clean(doc["title"])}</h1>
      <div class="card"><img src="data:image/png;base64,{logo_b64}" alt="Vestel"/></div>
      <div class="body">
        <div class="subtitle">{clean(doc["subtitle"])}</div>
        <div class="rule"></div>
        <table class="ficha">
          <tr><td class="k">Sistema</td><td class="v">SAVES · ISP Vestel</td></tr>
          <tr><td class="k">Dirigido a</td><td class="v">{clean(doc.get("dirigido", "Personal de Vestel"))}</td></tr>
          <tr><td class="k">Codigo</td><td class="v">SAVES-MAN-{doc["code"]}-{PERIODO}</td></tr>
          <tr><td class="k">Version</td><td class="v">{VERSION} &nbsp;·&nbsp; Emitido el {FECHA}</td></tr>
          <tr><td class="k">Clasificacion</td>
              <td class="v"><span class="clasif">Documento de uso interno</span></td></tr>
        </table>
      </div>
      <div class="empresa">VESGA TELEVISION S.A.S · NIT 813.001.768-1 · Documento generado por SAVES</div>
      <div class="footband"></div>
    </div>
    """


def build(doc, out_dir: Path, con_figuras: bool):
    def fuente(slug):
        return normaliza_md(clean((SRC / f"{slug}.md").read_text(encoding="utf-8")))

    partes = []
    if doc.get("comun", True):
        partes.append(fuente(COMUN.stem))
    partes.append(fuente(doc["slug"]))
    # Capítulos compartidos (Reportes): se escriben una vez y se anexan a los
    # manuales de quien los usa, en vez de copiarlos en cada rol y que se
    # desincronicen a la primera corrección.
    for anexo in doc.get("anexos", []):
        partes.append(fuente(anexo))
    md.reset()
    body, figs = realza(md.convert("\n\n".join(partes)), con_figuras)
    indice = indice_html(md.toc_tokens, con_figuras) if doc.get("indice", True) else ""
    title = clean(doc["title"])

    html = f"""<!doctype html><html><head><meta charset="utf-8">
      <style>{CSS}</style></head><body>
      <div id="runhdr"><table><tr>
        <td><img src="data:image/png;base64,{logo_b64}" alt=""/></td>
        <td class="doc">{title} <span>· v{VERSION}</span></td>
      </tr></table></div>
      {cover_html(doc)}
      {indice}
      <div class="content">{body}</div>
      </body></html>"""

    out = out_dir / doc["filename"]
    HTML(string=html, base_url=str(ROOT)).write_pdf(str(out))
    kb = out.stat().st_size // 1024
    print(f"  ok {out.name}  ({kb} KB, {figs} capturas)")
    return figs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slugs", nargs="*", help="solo estos manuales (por slug)")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--sin-figuras", action="store_true",
                    help="no incrustar las capturas de pantalla")
    a = ap.parse_args()

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    docs = [d for d in DOCS if not a.slugs or d["slug"] in a.slugs]
    if not docs:
        sys.exit(f"Ningún manual coincide con {a.slugs}")

    con_figuras = not a.sin_figuras
    n_shots = len(list(SHOTS.glob("*.png"))) if SHOTS.exists() else 0
    print(f"Tema Azul Vestel · {FECHA} → {out_dir}")
    print(f"Capturas disponibles: {n_shots}"
          + ("" if con_figuras else " (desactivadas por --sin-figuras)"))

    total = hechos = 0
    for d in docs:
        if not (SRC / f"{d['slug']}.md").exists():
            print(f"  · omitido (falta fuente): {d['slug']}.md")
            continue
        total += build(d, out_dir, con_figuras)
        hechos += 1
    print(f"\nListo: {hechos} documentos, {total} capturas incrustadas")


if __name__ == "__main__":
    main()
