# Documentación — SAVES · ISP Vestel

Manuales de uso del sistema **SAVES**, escritos en lenguaje sencillo (para personal no
técnico), uno por cada **rol / área** de acceso. Cada manual es autónomo: incluye la
sección común *"Antes de empezar"* y luego el detalle de las pantallas de ese rol.

## Manuales (PDF)

Se generan en `manuales/` con el logo y el branding de Vestel:

| Rol / área | Para quién | Archivo |
|---|---|---|
| **Superadministrador** | Administra usuarios, roles, acceso y seguridad | `Manual SAVES Vestel - del Superadministrador.pdf` |
| **Gerencia** | Dirección — panel ejecutivo y reportes (solo lectura) | `Manual SAVES Vestel - de Gerencia.pdf` |
| **Administración** | Clientes, inventario de material, compras, personal | `Manual SAVES Vestel - de Administracion.pdf` |
| **Contabilidad** | Facturación, notas, factura electrónica, contabilidad | `Manual SAVES Vestel - de Contabilidad y Facturacion.pdf` |
| **Caja y ventas** | Cajero/a — caja diaria y cobros | `Manual SAVES Vestel - de Caja y Ventas.pdf` |
| **Técnicos** | Soporte técnico y operación de red | `Manual SAVES Vestel - de Tecnicos.pdf` |
| **Sistemas** | Configuración, WhatsApp, automatizaciones | `Manual SAVES Vestel - de Sistemas.pdf` |

## Estructura

```
documentacion/
├── README.md              ← este índice
├── build_manuales.py      ← generador de los PDF (WeasyPrint)
├── fuentes/               ← contenido editable en Markdown
│   ├── _comun.md          ← sección "Antes de empezar" (va en TODOS los manuales)
│   ├── gerencia.md
│   ├── administracion.md
│   ├── contabilidad.md
│   ├── caja.md
│   ├── tecnicos.md
│   ├── sistemas.md
│   └── superadministrador.md
└── manuales/              ← PDF generados (salida)
```

## Cómo regenerar los PDF

Tras editar cualquier archivo de `fuentes/`:

```bash
python3 documentacion/build_manuales.py
```

Requisitos: `python3` con `weasyprint` y `markdown` instalados (ya disponibles en el
servidor de desarrollo).

## Cómo agregar o cambiar contenido

- **Editar un manual:** modifica su `.md` en `fuentes/` y vuelve a generar.
- **Cambiar algo que aplica a todos** (cómo entrar, avisos, etc.): edita `fuentes/_comun.md`.
- **Agregar un rol nuevo:** crea `fuentes/<rol>.md` y añade su entrada en la lista `ROLES`
  de `build_manuales.py`.

El branding (logo, colores) sale de la marca Vestel definida en el generador; el logo es
`frontend/public/logo-vestel.png`.
