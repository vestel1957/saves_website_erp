# Documentación — SAVES · ISP Vestel

Documentación de uso del sistema **SAVES**, escrita en lenguaje sencillo (para personal no
técnico), **una por cada rol** de acceso. Cada manual es autónomo: incluye la sección común
*"Antes de empezar"* y luego el detalle de las pantallas de ese rol.

## Manuales por rol (PDF)

Se generan en `manuales/` con el logo y el branding de Vestel.

### Áreas de acceso

| Rol / área | Para quién | Archivo |
|---|---|---|
| **Superadministrador** | Administra usuarios, roles, acceso y seguridad | `Manual SAVES Vestel - del Superadministrador.pdf` |
| **Gerencia** | Dirección — panel, reportes y aprobación de compras | `Manual SAVES Vestel - de Gerencia.pdf` |
| **Administración** | Clientes, inventario de material, compras, personal | `Manual SAVES Vestel - de Administracion.pdf` |
| **Contabilidad** | Facturación, notas, factura electrónica, contabilidad | `Manual SAVES Vestel - de Contabilidad y Facturacion.pdf` |
| **Caja y ventas** | Cajero/a — caja diaria y cobros | `Manual SAVES Vestel - de Caja y Ventas.pdf` |
| **Técnicos** | Soporte técnico y operación de red | `Manual SAVES Vestel - de Tecnicos.pdf` |
| **Sistemas** | Configuración, WhatsApp, automatizaciones | `Manual SAVES Vestel - de Sistemas.pdf` |

### Roles funcionales

| Rol | Para quién | Archivo |
|---|---|---|
| **Contador** | Libros, estados financieros y mapeo de cuentas | `Manual SAVES Vestel - del Contador.pdf` |
| **Jefe de bodega** | Material, equipos y despacho de inventario | `Manual SAVES Vestel - del Jefe de Bodega.pdf` |
| **Recursos Humanos** | Empleados, cuadrillas y accesos | `Manual SAVES Vestel - de Recursos Humanos.pdf` |
| **Auditoría / Consulta** | Revisión de cifras y rastros (solo lectura) | `Manual SAVES Vestel - de Auditoria y Consulta.pdf` |

### Referencia técnica

| Documento | Para qué sirve | Archivo |
|---|---|---|
| **Matriz de Roles y Permisos** | Quién puede qué: roles, permisos, pantallas y coherencia del catálogo | `SAVES Vestel - Matriz de Roles y Permisos.pdf` |

> La matriz **se genera del código** (`gen_matriz.ts`), no se escribe a mano. Los manuales sí son
> contenido editable en `fuentes/`.

El capítulo **Reportes** (los 14 reportes, uno por uno, con su captura) se escribe una sola vez en
`fuentes/_reportes.md` y se anexa a los manuales de Gerencia, Administración, Contabilidad,
Contador y Auditoría.

## Estructura

```
documentacion/
├── README.md              ← este índice
├── build_manuales.py      ← generador de los PDF (WeasyPrint)
├── capturar_pantallas.mjs ← toma las capturas del sistema (Playwright)
├── capturas-extra.json    ← capturas que no son una URL: modales y fichas
├── capturas/              ← PNG de cada pantalla, uno por ruta
├── gen_matriz.ts          ← genera fuentes/_matriz-roles.md desde el código
├── fuentes/               ← contenido editable en Markdown
│   ├── _comun.md          ← sección "Antes de empezar" (va en TODOS los manuales)
│   ├── _reportes.md       ← capítulo "Reportes" (anexo de varios manuales)
│   ├── _matriz-roles.md   ← GENERADO: no editar a mano
│   ├── gerencia.md
│   ├── administracion.md
│   ├── contabilidad.md
│   ├── caja.md
│   ├── tecnicos.md
│   ├── sistemas.md
│   ├── superadministrador.md
│   ├── contador.md
│   ├── jefe-bodega.md
│   ├── rrhh.md
│   └── auditoria.md
└── manuales/              ← PDF generados (salida)
```

## Cómo regenerar los PDF

Tras editar cualquier archivo de `fuentes/`:

```bash
python3 documentacion/build_manuales.py
```

Requisitos: `python3` con `weasyprint` y `markdown` instalados (ya disponibles en el
servidor de desarrollo). Añade `--sin-figuras` para generar sin capturas.

## Cómo regenerar las capturas de pantalla

Cada sección con una línea "**Dónde:**" lleva incrustada una foto real de esa pantalla.
Las capturas **no se listan a mano**: el capturador saca las rutas de las propias fuentes
(la URL entre backticks, o el rótulo del menú resuelto contra `frontend/src/lib/nav.ts`),
así que una pantalla nueva en el manual trae su captura sola.

```bash
# 1. cuenta temporal para navegar el sistema (imprime la clave)
cd backend && node scripts/usuario-capturas.js crear --completo

# 2. tomar las fotos (BASE debe ser el dominio real: por IP el backend rechaza el CORS)
SAVES_USER=capturas@vestel.com.co SAVES_PASS=<la clave> \
  node documentacion/capturar_pantallas.mjs --base https://app.saves.com.co

# 3. BORRAR la cuenta y regenerar los PDF
cd backend && node scripts/usuario-capturas.js borrar
python3 documentacion/build_manuales.py
```

### Capturas que no son una URL

Buena parte de lo que explican los manuales no vive en una ruta: la ventana de *Registrar
egreso*, la ficha de un cliente, la pestaña *Permisos y accesos*. Esas se declaran en
**`capturas-extra.json`** —ruta de partida más los clics que hay que dar— y la fuente las pide
por nombre con una línea propia:

```markdown
**Captura:** tesoreria-egresos-modal — Ventana Registrar egreso, con el comprobante.
```

Los pasos disponibles son `clic` (un botón o enlace por su texto), `fila` (abrir el registro N
de la primera tabla, que es como se llega a `/clientes/[id]`) y `pestana`.

```bash
# rehacer SOLO las fichas y ventanas emergentes (lo que toca repetir cuando
# cambia el enmascarado de datos personales)
node documentacion/capturar_pantallas.mjs --base https://app.saves.com.co --solo-extras
```

> Las rutas con parámetro (`/clientes/[id]`) buscan el PNG `<base>-ficha.png`, así que basta con
> declarar esa ficha en `capturas-extra.json` para que la sección la muestre.

### Por qué las capturas ya no salen vacías

Media docena de pantallas arranca pidiendo filtros ("elige sede y caja y pulsa **Ver**") y su
captura era un recuadro en blanco justo donde el manual explica cómo leer el informe. El
capturador detecta esa frase, elige el primer valor de cada filtro y pulsa el botón de consulta
antes de disparar la foto.

Dos cosas de ahí no son negociables:

- **Sólo interviene si la pantalla lo pide.** Rellenar filtros en todas era peor: los reportes
  abren con el periodo completo y elegir una sede al azar mostraba menos, además de disparar una
  recarga que dejaba la foto llena de bloques grises de carga.
- **El botón se busca por coincidencia exacta** contra una lista de tres: *Ver*, *Consultar*,
  *Buscar*. La lista es corta a propósito — en este sistema existe un botón "Generar facturas del
  mes", y un generador de manuales no puede permitirse pulsar cosas así.

> Las páginas se esperan con `domcontentloaded`, **no** con `networkidle`: la campana de avisos
> consulta sola cada pocos segundos, la red nunca queda quieta y pantallas perfectamente sanas
> (los reportes de IVA, órdenes y recaudo) se perdían por agotar el tiempo de espera.

Antes de cada foto se **enmascaran los datos personales** (nombres, cédulas, teléfonos,
direcciones y correos se reemplazan por datos ficticios estables). No lo desactives con
`--sin-mascara` para manuales que se vayan a repartir: estos PDF los leen más de cien
empleados y circulan por WhatsApp.

> **Las fichas de detalle son el punto débil del enmascarado.** El nombre no está en una tabla ni
> junto a un rótulo: es el título de la pantalla (`ERIKA CRUZ CASTRO` en grande), la cédula viene
> partida en dos nodos del DOM y el usuario PPPoE es el nombre pegado y en mayúsculas. Hay reglas
> para las tres cosas, pero **si agregas una ficha nueva a `capturas-extra.json`, ábrela y
> compruébala antes de repartir el PDF.**

## Cómo regenerar la matriz de roles

La matriz se deriva del catálogo de permisos, del menú y de la base de datos, así que hay que
regenerarla cuando cambien los roles, los permisos o las pantallas:

```bash
cd backend && node_modules/.bin/ts-node --transpile-only \
  -O '{"module":"commonjs","target":"es2020","esModuleInterop":true}' \
  ../documentacion/gen_matriz.ts
python3 documentacion/build_manuales.py    # y luego el PDF
```

Cruza cuatro fuentes: `backend/src/auth/permissions.catalog.ts` (roles y permisos),
`frontend/src/lib/nav.ts` (el menú real), el código del backend y el frontend (dónde se exige cada
permiso) y la base de datos (usuarios por rol, y los roles personalizados creados desde la UI). Si
la base no está disponible, el documento se genera igual, sin las columnas de usuarios.

## Cómo agregar o cambiar contenido

- **Editar un manual:** modifica su `.md` en `fuentes/` y vuelve a generar.
- **Cambiar algo que aplica a todos** (cómo entrar, avisos, etc.): edita `fuentes/_comun.md`.
- **Agregar un rol nuevo:** crea `fuentes/<rol>.md` y añade su entrada en la lista `DOCS`
  de `build_manuales.py` (slug, kicker, título, subtítulo y nombre del PDF).
- **Un capítulo que va en varios manuales** (como *Reportes*): se escribe una sola vez en
  `fuentes/_<nombre>.md` y se añade `anexos=["_<nombre>"]` a los roles que lo usan. Copiarlo en
  cada rol es lo que hace que las correcciones se apliquen solo en la mitad de los PDF.

> No hace falta dejar una línea en blanco antes de una lista: el generador la inserta
> (`normaliza_md`). Sin eso, python-markdown pegaba las viñetas al párrafo anterior y salían
> párrafos corridos del tipo "aclaraciones: - Caja: … - Movimiento: …".

El branding sale del tema "Azul Vestel" definido en el generador: la paleta está muestreada
del propio logo (`frontend/public/logo-vestel.png`) — navy `#0b2059`, azul `#0a5ca8`, azul
claro `#1592d0` y la plata del degradado. Es la misma paleta del kit de los PDF operativos
(`backend/src/common/pdf/brand.ts`), para que manual y factura se vean de la misma empresa.

> Ese PNG mide 200×50 px. Es el techo de calidad de la portada: si aparece el vector o un
> PNG grande, reemplazarlo mejora todos los documentos sin tocar código.

> **Cuidado con el filtro de emoji** de `build_manuales.py`: quita los pictogramas que las fuentes
> del PDF no traen. Su rango **no debe incluir las flechas** (U+2190–U+21FF), porque los manuales
> usan `→` en todas las rutas de menú.
