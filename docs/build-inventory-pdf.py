#!/usr/bin/env python3
"""Genera un PDF con todo el Manual de Bodega (módulo de Inventario) de Nexus ERP,
usando la paleta de marca BHDC."""
import base64
import re
from pathlib import Path

import markdown
from weasyprint import HTML

ROOT = Path("/home/dev/nexus-erp")
DOCS = ROOT / "docs" / "manual-bodega"
LOGO = ROOT / "LOGO BHDC Completo.png"
OUT = ROOT / "docs" / "Manual-Inventario-BHDC.pdf"

# --- Paleta de marca (de frontend/src/app/globals.css) ---
BRAND        = "#ea580c"   # naranja primario
BRAND_HOVER  = "#c2410c"   # naranja profundo
BRAND_SOFT   = "#ffedd5"
GOLD         = "#f2ae2e"   # oro (rayos del sol)
GOLD_SOFT    = "#fdf3da"
RED          = "#bf303c"   # rojo del emblema
RED_SOFT     = "#f9e9ea"
GREEN        = "#10b981"
INK          = "#0f172a"
INK_2        = "#475569"
INK_3        = "#64748b"
BORDER       = "#dbe2ea"
CANVAS       = "#eef1f6"
SURFACE      = "#f7f9fc"

# Orden y títulos cortos para el índice
ORDER = [
    ("01-ingreso-y-alertas.md",      "Ingresar y leer alertas"),
    ("02-recepciones.md",            "Recibir mercancía"),
    ("03-solicitudes-internas.md",   "Solicitudes internas"),
    ("04-ajustes.md",                "Ajustes de existencias"),
    ("05-conteos-fisicos.md",        "Conteos físicos"),
    ("06-limites-y-reorden.md",      "Límites y reorden"),
    ("07-consultar-existencias.md",  "Consultar existencias"),
]

logo_b64 = base64.b64encode(LOGO.read_bytes()).decode()
md = markdown.Markdown(extensions=["tables", "sane_lists"])

# Sin fuente de emoji en el sistema: los quitamos para una impresión limpia.
EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF\U00002B00-\U00002BFF\U0000FE0F\U000020E3]",
    flags=re.UNICODE,
)
def clean(s: str) -> str:
    return EMOJI.sub("", s)

# --- Índice (portada) ---
index_src = clean((DOCS / "00-indice.md").read_text(encoding="utf-8"))
# Nos quedamos solo con la intro + la tabla de roles + las reglas de oro.
# (La lista "Las tareas" la reemplaza nuestro índice de píldoras.)
index_src = re.sub(r'## Las tareas.*?(?=## Reglas de oro)', '', index_src, flags=re.S)
index_html = md.convert(index_src)
md.reset()
index_html = re.sub(r'<a href="[^"]*\.md">([^<]*)</a>', r'\1', index_html)
index_html = re.sub(r'<h1>.*?</h1>', '', index_html, count=1, flags=re.S)

# --- Secciones ---
sections_html = []
for i, (fname, short) in enumerate(ORDER, start=1):
    src = clean((DOCS / fname).read_text(encoding="utf-8"))
    html = md.convert(src)
    md.reset()
    sections_html.append(f'<section class="doc">{html}</section>')

body = "\n".join(sections_html)

DOC = f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><style>
@page {{
  size: A4;
  margin: 22mm 18mm 20mm 18mm;
  @bottom-center {{
    content: "Manual de Bodega · Módulo de Inventario · Nexus ERP";
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 8pt; color: {INK_3};
  }}
  @bottom-right {{
    content: "Pág. " counter(page) " / " counter(pages);
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 8pt; color: {INK_3};
  }}
}}
@page :first {{ margin: 0; @bottom-center {{ content: ""; }} @bottom-right {{ content: ""; }} }}

* {{ box-sizing: border-box; }}
body {{
  font-family: 'Helvetica Neue', 'Segoe UI', Arial, sans-serif;
  color: {INK}; font-size: 10.5pt; line-height: 1.5; margin: 0;
}}

/* ---------- PORTADA ---------- */
.cover {{
  page-break-after: always;
  height: 297mm; width: 210mm; position: relative;
  background:
    radial-gradient(120% 80% at 100% 0%, {BRAND_SOFT} 0%, transparent 55%),
    linear-gradient(160deg, #ffffff 0%, {SURFACE} 70%, {CANVAS} 100%);
  padding: 38mm 24mm;
}}
.cover .bar {{
  position: absolute; top: 0; left: 0; right: 0; height: 12mm;
  background: linear-gradient(90deg, {GOLD} 0%, {BRAND} 45%, {RED} 100%);
}}
.cover .logo {{ width: 78mm; margin-bottom: 16mm; }}
.cover .eyebrow {{
  text-transform: uppercase; letter-spacing: .28em; font-size: 10pt;
  color: {BRAND_HOVER}; font-weight: 700; margin-bottom: 6mm;
}}
.cover h1 {{
  font-size: 34pt; line-height: 1.08; margin: 0 0 6mm 0; color: {INK};
  font-weight: 800; border: none; padding: 0;
}}
.cover h1 .accent {{ color: {BRAND}; }}
.cover .sub {{ font-size: 13pt; color: {INK_2}; max-width: 130mm; }}
.cover .meta {{
  position: absolute; bottom: 28mm; left: 24mm; right: 24mm;
  border-top: 2px solid {BRAND}; padding-top: 5mm;
  display: flex; justify-content: space-between; font-size: 9.5pt; color: {INK_3};
}}
.cover .meta strong {{ color: {INK}; }}

/* ---------- ÍNDICE ---------- */
.toc {{ page-break-after: always; }}
.toc h2 {{
  font-size: 20pt; color: {INK}; border-bottom: 3px solid {GOLD};
  padding-bottom: 3mm; margin-bottom: 8mm;
}}
ol.toc-list {{ list-style: none; counter-reset: toc; padding: 0; margin: 0; }}
ol.toc-list li {{
  counter-increment: toc; display: flex; align-items: center; gap: 5mm;
  padding: 4mm 5mm; margin-bottom: 3mm; border: 1px solid {BORDER};
  border-left: 5px solid {BRAND}; border-radius: 8px; background: {SURFACE};
}}
ol.toc-list li::before {{
  content: counter(toc); flex: 0 0 auto; width: 11mm; height: 11mm;
  background: {BRAND}; color: #fff; border-radius: 50%; font-weight: 800;
  display: flex; align-items: center; justify-content: center; font-size: 12pt;
}}
ol.toc-list li .t {{ font-weight: 600; font-size: 12pt; }}
.toc .intro {{
  background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 10px;
  padding: 2mm 6mm 5mm; margin-bottom: 8mm; color: {INK_2};
}}
.toc .intro h2 {{
  font-size: 13.5pt; color: {BRAND_HOVER}; border: none; padding-left: 4mm;
  border-left: 4px solid {GOLD}; margin: 6mm 0 3mm 0;
}}
.toc .intro table {{ width: 100%; border-collapse: collapse; margin-top: 2mm; }}
.toc .lead {{ font-weight: 600; color: {INK}; margin-bottom: 5mm; }}

/* ---------- SECCIONES ---------- */
.doc {{ page-break-before: always; }}
h1 {{
  font-size: 19pt; color: {INK}; font-weight: 800; margin: 0 0 6mm 0;
  padding: 0 0 3mm 0; border-bottom: 3px solid {BRAND};
}}
h2 {{
  font-size: 13.5pt; color: {BRAND_HOVER}; font-weight: 700;
  margin: 7mm 0 3mm 0; padding-left: 4mm; border-left: 4px solid {GOLD};
}}
h3 {{ font-size: 11.5pt; color: {INK}; margin: 5mm 0 2mm 0; }}
p {{ margin: 0 0 3mm 0; }}
ul, ol {{ margin: 0 0 4mm 0; padding-left: 6mm; }}
li {{ margin-bottom: 1.5mm; }}
strong {{ color: {INK}; }}
code {{
  background: {BRAND_SOFT}; color: {BRAND_HOVER}; padding: .5mm 1.5mm;
  border-radius: 3px; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 9pt;
}}

/* Tablas */
table {{ width: 100%; border-collapse: collapse; margin: 3mm 0 5mm 0; font-size: 9.5pt; }}
th {{
  background: {BRAND}; color: #fff; text-align: left; padding: 2.5mm 3mm;
  font-weight: 700; border: 1px solid {BRAND};
}}
td {{ padding: 2.5mm 3mm; border: 1px solid {BORDER}; vertical-align: top; }}
tr:nth-child(even) td {{ background: {SURFACE}; }}

/* Citas / consejos */
blockquote {{
  margin: 4mm 0; padding: 3mm 5mm; background: {GOLD_SOFT};
  border-left: 5px solid {GOLD}; border-radius: 0 8px 8px 0; color: {INK_2};
}}
blockquote p {{ margin: 0; }}
</style></head><body>

<div class="cover">
  <div class="bar"></div>
  <img class="logo" src="data:image/png;base64,{logo_b64}" />
  <div class="eyebrow">Nexus ERP · Documentación</div>
  <h1>Manual de <span class="accent">Inventario</span><br>y Bodega</h1>
  <div class="sub">Guía operativa del módulo de inventario: recepciones, solicitudes,
  ajustes, conteos, límites de reorden y consulta de existencias. Una página por tarea.</div>
  <div class="meta">
    <div><strong>BHDC</strong> · Módulo de Inventario</div>
    <div>Versión del manual · {len(ORDER)} procesos</div>
  </div>
</div>

<div class="toc">
  <h2>Contenido</h2>
  <ol class="toc-list">
    {''.join(f'<li><span class="t">{short}</span></li>' for _, short in ORDER)}
  </ol>
  <div class="intro">{index_html}</div>
</div>

{body}

</body></html>"""

HTML(string=DOC, base_url=str(ROOT)).write_pdf(str(OUT))
print(f"PDF generado: {OUT} ({OUT.stat().st_size/1024:.0f} KB)")
