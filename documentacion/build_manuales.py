#!/usr/bin/env python3
"""Genera los MANUALES DE USO por rol del sistema SAVES (ISP Vestel) en PDF, con
el logo y el branding de Vestel (paleta teal/dorado/rojo de la marca).

Cada manual = portada + seccion comun ("Antes de empezar") + contenido del rol.
Las fuentes viven en documentacion/fuentes/*.md y los PDF salen a
documentacion/manuales/.

Uso:  python3 documentacion/build_manuales.py
"""
import base64
import re
from datetime import date
from pathlib import Path

import markdown
from weasyprint import HTML

ROOT = Path("/home/dev/saves")
SRC = ROOT / "documentacion" / "fuentes"
OUT = ROOT / "documentacion" / "manuales"
LOGO = ROOT / "frontend" / "public" / "logo-vestel.png"
COMUN = SRC / "_comun.md"

# --- Paleta de marca Vestel (de frontend/src/app/globals.css) ---
BRAND, BRAND_HOVER, BRAND_SOFT = "#0e7490", "#0b5a70", "#dff1f5"
GOLD, GOLD_SOFT = "#f2ae2e", "#fdf3da"
RED = "#bf303c"
INK, INK_2, INK_3 = "#0d1526", "#41506a", "#64748b"
BORDER, CANVAS, SURFACE = "#dbe2ea", "#eef2f7", "#f8fafc"

# Fecha de emision (es-CO)
MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
HOY = date.today()
FECHA = f"{HOY.day} de {MESES[HOY.month]} de {HOY.year}"

# Orden y metadatos de cada manual
ROLES = [
    ("superadministrador", "Manual del Superadministrador",
     "Usuarios, roles, acceso y seguridad"),
    ("gerencia", "Manual de Gerencia",
     "Direccion · Panel ejecutivo y reportes"),
    ("administracion", "Manual de Administracion",
     "Clientes, inventario, compras y personal"),
    ("contabilidad", "Manual de Contabilidad y Facturacion",
     "Facturacion, notas, factura electronica y contabilidad"),
    ("caja", "Manual de Caja y Ventas",
     "Caja diaria, cobros y ventas"),
    ("tecnicos", "Manual de Tecnicos",
     "Soporte tecnico y operacion de red"),
    ("sistemas", "Manual de Sistemas",
     "Configuracion, WhatsApp y automatizaciones"),
]

logo_b64 = base64.b64encode(LOGO.read_bytes()).decode()
md = markdown.Markdown(extensions=["tables", "sane_lists", "fenced_code", "toc"])

EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF\U00002B00-\U00002BFF\U0000FE0F\U000020E3]",
    flags=re.UNICODE,
)
clean = lambda s: EMOJI.sub("", s)

CSS = f"""
@page {{
  size: A4;
  margin: 22mm 18mm 20mm 18mm;
  @top-left {{
    content: element(runhdr);
    vertical-align: middle;
  }}
  @bottom-left {{
    content: "SAVES · ISP Vestel — Uso interno";
    font-size: 8pt; color: {INK_3};
  }}
  @bottom-right {{
    content: "Pagina " counter(page) " de " counter(pages);
    font-size: 8pt; color: {INK_3};
  }}
}}
@page cover {{ margin: 0; }}
@page cover {{ @top-left {{ content: none; }} @bottom-left {{ content: none; }} @bottom-right {{ content: none; }} }}

/* Encabezado corriente (repite en cada pagina salvo portada) */
#runhdr {{
  position: running(runhdr);
  font-size: 8.5pt; color: {INK_3};
  border-bottom: 0;
}}
#runhdr b {{ color: {BRAND}; }}

html {{ font-family: "DejaVu Sans", "Helvetica", sans-serif; color: {INK};
  font-size: 10.2pt; line-height: 1.5; }}

/* ---------- Portada ---------- */
.cover {{
  page: cover;
  height: 297mm; width: 210mm;
  position: relative;
  page-break-after: always;
  background: {SURFACE};
}}
.cover .band {{
  position: absolute; top: 0; left: 0; right: 0; height: 12mm;
  background: linear-gradient(90deg, {BRAND} 0%, {BRAND} 55%, {GOLD} 100%);
}}
.cover .footband {{
  position: absolute; bottom: 0; left: 0; right: 0; height: 8mm;
  background: linear-gradient(90deg, {RED} 0%, {GOLD} 100%);
}}
.cover .inner {{
  position: absolute; top: 78mm; left: 22mm; right: 22mm;
}}
.cover img.logo {{ width: 62mm; height: auto; margin-bottom: 16mm; }}
.cover .kicker {{
  font-size: 10pt; letter-spacing: 3px; text-transform: uppercase;
  color: {BRAND}; font-weight: 700; margin-bottom: 6mm;
}}
.cover h1.title {{
  font-size: 30pt; line-height: 1.1; color: {INK}; margin: 0 0 5mm 0;
  font-weight: 800;
  page-break-before: avoid; border-bottom: 0; padding: 0;
}}
.cover .subtitle {{
  font-size: 13pt; color: {INK_2}; margin: 0 0 22mm 0;
}}
.cover .rule {{ width: 40mm; height: 3px; background: {GOLD}; margin-bottom: 8mm; }}
.cover .meta {{ font-size: 10pt; color: {INK_3}; }}
.cover .meta b {{ color: {INK_2}; }}
.cover .badge {{
  display: inline-block; margin-top: 4mm; padding: 2mm 4mm;
  background: {BRAND_SOFT}; color: {BRAND_HOVER}; border-radius: 3mm;
  font-size: 9pt; font-weight: 700;
}}

/* ---------- Tipografia del contenido ---------- */
h1 {{
  font-size: 18pt; color: {BRAND}; font-weight: 800;
  margin: 0 0 4mm 0; padding-bottom: 2.5mm;
  border-bottom: 2.5px solid {GOLD};
  page-break-before: always; page-break-after: avoid;
  bookmark-level: 1;
}}
.content > h1:first-of-type {{ page-break-before: avoid; }}
h2 {{
  font-size: 13.5pt; color: {INK}; font-weight: 700;
  margin: 7mm 0 2.5mm 0; padding-left: 3mm;
  border-left: 4px solid {BRAND};
  page-break-after: avoid; bookmark-level: 2;
}}
h3 {{ font-size: 11.5pt; color: {BRAND_HOVER}; font-weight: 700;
  margin: 4.5mm 0 1.5mm 0; page-break-after: avoid; bookmark-level: 3; }}
p {{ margin: 0 0 2.5mm 0; }}
strong {{ color: {INK}; }}
a {{ color: {BRAND}; text-decoration: none; }}

ul, ol {{ margin: 0 0 3mm 0; padding-left: 6mm; }}
li {{ margin-bottom: 1.2mm; }}

/* Tablas */
table {{ width: 100%; border-collapse: collapse; margin: 2mm 0 4mm 0;
  font-size: 9.3pt; page-break-inside: avoid; }}
th {{ background: {BRAND}; color: #fff; text-align: left;
  padding: 2mm 2.5mm; font-weight: 700; }}
td {{ padding: 1.8mm 2.5mm; border-bottom: 0.5px solid {BORDER};
  vertical-align: top; }}
tr:nth-child(even) td {{ background: {CANVAS}; }}

/* Citas = consejos / advertencias */
blockquote {{
  margin: 3mm 0; padding: 2.5mm 4mm;
  background: {GOLD_SOFT}; border-left: 4px solid {GOLD};
  border-radius: 0 2mm 2mm 0; color: {INK_2};
}}
blockquote p {{ margin: 0; }}

code {{ font-family: "DejaVu Sans Mono", monospace; font-size: 9pt;
  background: {CANVAS}; padding: 0.3mm 1.2mm; border-radius: 1mm; color: {RED}; }}

hr {{ border: 0; border-top: 0.5px solid {BORDER}; margin: 5mm 0; }}

/* Bloque "Dónde:" y campos destacados se ven mejor con el estilo por defecto */
"""


def cover_html(title, subtitle):
    return f"""
    <div class="cover">
      <div class="band"></div>
      <div class="inner">
        <img class="logo" src="data:image/png;base64,{logo_b64}" alt="Vestel"/>
        <div class="kicker">Manual de uso</div>
        <h1 class="title">{clean(title)}</h1>
        <div class="subtitle">{clean(subtitle)}</div>
        <div class="rule"></div>
        <div class="meta">
          Sistema <b>SAVES</b> · ISP <b>Vestel</b><br/>
          Emitido el {FECHA}<br/>
          <span class="badge">Documento de uso interno</span>
        </div>
      </div>
      <div class="footband"></div>
    </div>
    """


def build(slug, title, subtitle):
    role_md = (SRC / f"{slug}.md").read_text(encoding="utf-8")
    comun_md = COMUN.read_text(encoding="utf-8")
    full_md = clean(comun_md) + "\n\n" + clean(role_md)
    md.reset()
    body = md.convert(full_md)
    html = f"""<!doctype html><html><head><meta charset="utf-8">
      <style>{CSS}</style></head><body>
      <div id="runhdr">SAVES · ISP Vestel — <b>{clean(title)}</b></div>
      {cover_html(title, subtitle)}
      <div class="content">{body}</div>
      </body></html>"""
    out = OUT / f"Manual SAVES Vestel - {clean(title).replace('Manual ', '').strip()}.pdf"
    HTML(string=html, base_url=str(ROOT)).write_pdf(str(out))
    size_kb = out.stat().st_size // 1024
    print(f"  ✓ {out.name}  ({size_kb} KB)")
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Generando manuales (fecha {FECHA})...")
    built = []
    for slug, title, subtitle in ROLES:
        if not (SRC / f"{slug}.md").exists():
            print(f"  · omitido (falta fuente): {slug}.md")
            continue
        built.append(build(slug, title, subtitle))
    print(f"\nListo: {len(built)} manuales en {OUT}")


if __name__ == "__main__":
    main()
