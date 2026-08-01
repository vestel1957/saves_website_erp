/**
 * Captura las pantallas del sistema que citan los manuales.
 *
 * Las rutas NO se listan aquí: se sacan de las propias fuentes
 * (documentacion/fuentes/*.md), donde cada sección ya dice
 * "**Dónde:** menú Tesorería → Apertura de caja (ruta `/tesoreria/apertura`)".
 * Así, cuando alguien agregue una pantalla al manual, su captura sale sola.
 *
 * El PNG se guarda como <ruta con guiones>.png, que es el nombre que
 * build_manuales_azul.py busca para incrustar la imagen bajo esa sección.
 *
 * Uso:
 *   SAVES_USER=correo SAVES_PASS=clave node documentacion/capturar_pantallas.mjs
 *   ... --base http://127.0.0.1:3060   (por defecto)
 *   ... --solo /tesoreria              (captura solo las que empiecen así)
 */
import { chromium } from '/home/dev/nexonext/node_modules/playwright/index.mjs';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = '/home/dev/saves';
const SRC = join(ROOT, 'documentacion', 'fuentes');
const OUT = join(ROOT, 'documentacion', 'capturas');
const EXTRA = join(ROOT, 'documentacion', 'capturas-extra.json');

const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : def;
};
const BASE = arg('--base', 'http://127.0.0.1:3060').replace(/\/$/, '');
const SOLO = arg('--solo', null);
const MASCARA = !process.argv.includes('--sin-mascara');
const USER = process.env.SAVES_USER;
const PASS = process.env.SAVES_PASS;

if (!USER || !PASS) {
  console.error('Faltan credenciales: SAVES_USER y SAVES_PASS.');
  process.exit(1);
}

/** `/tesoreria/apertura` → `tesoreria-apertura` (el nombre del PNG). */
export const slugDeRuta = (r) => r.replace(/^\//, '').replace(/\//g, '-') || 'inicio';

/** Saca de las fuentes toda ruta citada entre backticks. */
function rutas() {
  const vistas = new Map(); // ruta → manuales que la citan
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.md'))) {
    const txt = readFileSync(join(SRC, f), 'utf8');
    for (const m of txt.matchAll(/`(\/[a-z0-9\-/[\]]*)`/gi)) {
      const r = m[1];
      // Las rutas con parámetro (/empleados/[id]) no se pueden abrir a ciegas:
      // necesitan un registro concreto y eso lo decide quien arme el manual.
      if (r.includes('[')) continue;
      if (!vistas.has(r)) vistas.set(r, new Set());
      vistas.get(r).add(f.replace('.md', ''));
    }
  }
  return [...vistas.entries()]
    .map(([ruta, docs]) => ({ slug: slugDeRuta(ruta), ruta, docs: [...docs], pasos: [] }))
    .filter((x) => !SOLO || x.ruta.startsWith(SOLO))
    .sort((a, b) => a.ruta.localeCompare(b.ruta));
}

/**
 * Capturas que NO son "abrir una URL": ventanas emergentes, fichas de detalle y
 * pestañas. Se declaran en capturas-extra.json porque no hay forma de deducir
 * del texto que "Registrar egreso" abre un modal; el manual las referencia con
 * la línea `**Captura:** <slug> — <pie>`.
 */
function extras() {
  if (!existsSync(EXTRA)) return [];
  const lista = JSON.parse(readFileSync(EXTRA, 'utf8'));
  return lista
    .map((x) => ({ slug: x.slug, ruta: x.ruta, pasos: x.pasos || [], docs: ['extra'] }))
    .filter((x) => !SOLO || x.ruta.startsWith(SOLO));
}

/**
 * Deja la pantalla mostrando datos, no el formulario en blanco.
 *
 * Media docena de pantallas (cierres, informes, transferencias) arrancan
 * diciendo "elige sede y caja y pulsa Ver". Capturadas tal cual, el manual
 * enseñaba un recuadro vacío justo donde explica cómo leer el informe. Aquí se
 * eligen los primeros valores de cada filtro y se pulsa el botón de consulta,
 * que en todas estas pantallas sólo lee.
 */
// Deliberadamente corta y de coincidencia EXACTA: estos tres botones sólo leen.
// "Generar", "Aplicar" o "Actualizar" quedan fuera a propósito — en este sistema
// "Generar facturas del mes" existe de verdad, y un capturador de manuales no
// puede permitirse pulsarlo por su cuenta.
const BOTON_CONSULTA = /^(ver|consultar|buscar)$/i;

// Sólo se tocan los filtros de las pantallas que se declaran vacías a la espera
// de uno. Rellenarlos en todas era contraproducente: en los reportes, que ya
// abren con el periodo completo, elegir una sede al azar reduce lo que se ve y
// además dispara una recarga que dejaba la foto llena de bloques grises.
const PIDE_FILTRO = /(elige|elija|seleccion[ae]|escoge|escoja)[^.]{0,80}(pulsa|pulse|presiona|haga clic|para ver)/i;

async function rellenaFiltros(page) {
  // Dos pasadas: en las cascadas (sede → caja) el segundo selector sólo se
  // habilita cuando el primero ya tiene valor.
  // Todo lleva timeout corto y explícito: elegir un filtro re-renderiza la
  // pantalla, y preguntarle su texto a un elemento que React acaba de
  // reemplazar deja a Playwright esperando sus 30 s por defecto. Con veinte
  // botones en pantalla eso son diez minutos colgado en una sola captura.
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    const cuantos = await page.locator('select:visible:not([disabled])').count().catch(() => 0);
    for (let i = 0; i < cuantos; i++) {
      const sel = page.locator('select:visible:not([disabled])').nth(i);
      try {
        if (await sel.inputValue({ timeout: 2000 })) continue;
        const valores = await sel.evaluate(
          (el) => [...el.options].map((o) => o.value).filter(Boolean), { timeout: 2000 });
        if (valores.length) await sel.selectOption(valores[0], { timeout: 3000 });
      } catch { /* un filtro que no se deja tocar no debe tumbar la captura */ }
    }
    await page.waitForTimeout(350);
  }
  // Los textos se leen de una sola pasada en el navegador; así no hay locators
  // sueltos que se queden esperando a un elemento ya reemplazado.
  const textos = await page.evaluate(
    () => [...document.querySelectorAll('button')]
      .filter((b) => !b.disabled && b.offsetParent !== null)
      .map((b) => (b.textContent || '').trim()),
  ).catch(() => []);
  const texto = textos.find((t) => BOTON_CONSULTA.test(t));
  if (texto) {
    await page.getByRole('button', { name: texto, exact: true }).first()
      .click({ timeout: 5000 }).catch(() => {});
  }
  // Siempre, se haya pulsado o no: elegir un filtro ya recarga la pantalla por
  // su cuenta, y sin esta espera la foto sale con los bloques grises de carga.
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** Ejecuta los pasos declarados en capturas-extra.json. */
async function ejecutaPasos(page, pasos) {
  for (const paso of pasos) {
    if (paso.clic) {
      const loc = page.getByRole('button', { name: paso.clic, exact: false })
        .or(page.getByRole('link', { name: paso.clic, exact: false }))
        .first();
      await loc.click({ timeout: 12000 });
    } else if (paso.fila) {
      // Abrir el registro N de la primera tabla: el manual necesita la ficha de
      // detalle (/clientes/[id]) y esa URL no se puede escribir a ciegas.
      const fila = page.locator('table tbody tr').nth(paso.fila - 1);
      const enlace = fila.locator('a, button').first();
      await (await enlace.count() ? enlace : fila).click({ timeout: 12000 });
    } else if (paso.pestana) {
      await page.getByRole('tab', { name: paso.pestana, exact: false })
        .or(page.getByRole('button', { name: paso.pestana, exact: false }))
        .first().click({ timeout: 12000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(paso.espera ?? 1000);
  }
}

/**
 * Sustituye los datos personales por datos ficticios ANTES de la foto.
 *
 * El manual lo van a leer más de cien empleados y va a circular por WhatsApp:
 * no puede llevar el nombre, la cédula ni la dirección de clientes reales. No se
 * difumina nada —una captura borrosa no enseña— sino que se reemplaza por datos
 * verosímiles. El mismo valor real cae siempre en el mismo falso, así que las
 * pantallas siguen siendo coherentes entre sí.
 *
 * Se ejecuta dentro del navegador, por eso va todo en una función sin cierres.
 */
function enmascarar() {
  const NOMBRES = [
    'Ana Lucia Perez Rojas', 'Carlos Andres Mendez Silva', 'Marta Elena Ruiz Duarte',
    'Jorge Ivan Castillo Nino', 'Diana Patricia Molina Ortiz', 'Andres Felipe Gomez Leal',
    'Claudia Marcela Vargas Pena', 'Ricardo Alfonso Beltran Diaz', 'Sandra Milena Torres Cruz',
    'Oscar Javier Ramirez Soto', 'Paola Andrea Quintero Rios', 'Hernan Dario Suarez Melo',
    'Luz Adriana Naranjo Pardo', 'Fabian Eduardo Correa Vega', 'Yolanda Esther Pinzon Mora',
    'Mauricio Alberto Salazar Cano', 'Gloria Ines Cardenas Lugo', 'Julian Esteban Rivera Paez',
    'Beatriz Helena Osorio Gil', 'Nelson Ariel Guerrero Bello',
  ];
  const VIAS = ['Calle 12 # 8-45', 'Carrera 20 # 14-32', 'Calle 7 Sur # 22-18',
    'Carrera 5 # 30-11', 'Diagonal 18 # 9-27', 'Transversal 4 # 16-52'];
  const BARRIOS = ['Centro', 'La Esperanza', 'El Prado', 'Villa Nueva', 'San Jose'];
  // Frases de interfaz que también van en mayúscula y NO son nombres de persona.
  const UI = new Set(['SIN ASIGNAR', 'NO APLICA', 'SIN DATOS', 'POR DEFINIR', 'EN PROCESO',
    'DE CONTADO', 'SIN SEDE', 'TOTAL GENERAL', 'SALDO ANTERIOR', 'FORMA PAGO']);

  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const falsoNombre = (real) => NOMBRES[hash(real) % NOMBRES.length];
  const falsaDir = (real) =>
    `${VIAS[hash(real) % VIAS.length]}, ${BARRIOS[hash(real + 'b') % BARRIOS.length]}`;
  const falsoDoc = (real) => {
    const n = 10000000 + (hash(real) % 89999999);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };
  const falsoTel = (real) => {
    const n = 3000000000 + (hash(real) % 199999999);
    return String(n).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');
  };

  // Cosas que también van capitalizadas y en dos palabras pero NO son personas:
  // sin esto, "Caja Principal Yopal" acabaría convertida en un nombre propio.
  const NO_PERSONA = /^(caja|banco|sede|bodega|plan|factura|orden|nota|total|efectivo|transferencia|internet|television|televisión|servicio|servicios|producto|material|equipo|cuenta|categoria|categoría|mensualidad|reconexion|reconexión|abono|saldo|pago|recibo|deposito|depósito|ingreso|egreso|traslado|anulacion|anulación|sin|no|todos|todas|otros|varios|pendiente|activo|inactivo|nuevo|nueva)\b/i;

  // Bancos y pasarelas: van capitalizados y en dos palabras igual que un nombre
  // propio, y sin esta lista el resumen "por Banco" del cierre de caja salía
  // firmado por cuatro personas inventadas — una captura que confunde más de lo
  // que enseña.
  const ENTIDADES = /^(banco|banc|bbva|davivienda|daviplata|nequi|bancolombia|colpatria|scotiabank|itau|itaú|av villas|falabella|pichincha|bogota|bogotá|occidente|agrario|popular|caja social|sudameris|serfinanza|coltefinanciera|wompi|efecty|baloto|su red|gana|paypal|mercado pago|western union)\b/i;

  const esNombre = (t) => {
    const s = t.trim();
    if (s.length < 7 || s.length > 60 || UI.has(s.toUpperCase())) return false;
    if (/\d/.test(s) || NO_PERSONA.test(s) || ENTIDADES.test(s)) return false;
    const palabras = s.split(/\s+/);
    if (palabras.length < 2 || palabras.length > 5) return false;
    return /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ.]*(\s+[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ.]*)+$/.test(s);
  };

  // 1) Columnas de personas: se identifican por el encabezado de su tabla, que es
  //    mucho más fiable que adivinar si un texto "parece" un nombre.
  const COL_PERSONA = /cliente|abonado|suscriptor|titular|nombre|contacto|empleado|proveedor|usuario|cajero|tecnico|técnico|responsable|quien|payer|pagador|beneficiario|solicitante|autoriz|asignad|creado por|remitente|destinatario/i;
  const COL_DOC = /documento|cedula|cédula|nit|identificaci/i;
  const COL_TEL = /tel|celular|movil|móvil|whatsapp/i;
  const COL_DIR = /direcci|barrio|ubicaci/i;

  const pon = (celda, tipo, v) => {
    celda.textContent =
      tipo === 'per' ? falsoNombre(v)
        : tipo === 'doc' ? falsoDoc(v)
          : tipo === 'tel' ? falsoTel(v)
            : falsaDir(v);
  };

  for (const tabla of document.querySelectorAll('table')) {
    const ths = [...tabla.querySelectorAll('th')];
    const tipos = ths.map((th) => {
      const t = th.textContent || '';
      if (COL_DOC.test(t)) return 'doc';
      if (COL_TEL.test(t)) return 'tel';
      if (COL_DIR.test(t)) return 'dir';
      if (COL_PERSONA.test(t)) return 'per';
      return null;
    });
    // No se filtra por tbody: varias tablas de la app no lo declaran y las filas
    // cuelgan directo del <table>.
    for (const fila of tabla.querySelectorAll('tr')) {
      if (fila.querySelector('th')) continue; // fila de encabezado
      [...fila.children].forEach((celda, i) => {
        const v = (celda.textContent || '').trim();
        if (!v || v === '—' || v === '-') return;
        const tipo = tipos[i];
        if (tipo && (tipo !== 'per' || esNombre(v))) return pon(celda, tipo, v);
        // Red de seguridad: aunque el encabezado no se reconozca (o la tabla no
        // tenga), un nombre propio en una celda sigue siendo un dato personal.
        if (!tipo && esNombre(v)) pon(celda, 'per', v);
      });
    }
  }

  // 2) Fuera de las tablas (fichas de detalle, encabezados) el dato viene
  //    rotulado: "Cliente: X", "Dirección: Y".
  const ROTULO = /^(Cliente|Abonado|Suscriptor|Titular|Nombre|Documento|Cédula|Cedula|NIT|Teléfono|Telefono|Celular|Dirección|Direccion|Correo|Email)\s*:?\s*$/i;
  for (const el of document.querySelectorAll('dt, .label, label, span, p, div')) {
    if (el.children.length || !ROTULO.test((el.textContent || '').trim())) continue;
    const val = el.nextElementSibling;
    if (!val || val.children.length) continue;
    const rot = (el.textContent || '').toLowerCase();
    const v = (val.textContent || '').trim();
    if (!v || v.length > 70) continue;
    if (/direcci/.test(rot)) val.textContent = falsaDir(v);
    else if (/documento|cédula|cedula|nit/.test(rot)) val.textContent = falsoDoc(v);
    else if (/tel|celular/.test(rot)) val.textContent = falsoTel(v);
    else if (/correo|email/.test(rot)) val.textContent = 'cliente@ejemplo.com';
    else if (esNombre(v)) val.textContent = falsoNombre(v);
  }

  // 2.bis) Las FICHAS de detalle llevan el nombre de la persona como título, no
  //    dentro de una tabla ni junto a un rótulo: la ficha de un cliente se abre
  //    con "ERIKA CRUZ CASTRO" en grande. Sin esta pasada, las capturas de las
  //    fichas repartían nombre, cédula y usuario PPPoE reales.
  //
  //    Se exigen TRES palabras (los nombres completos las tienen; los títulos de
  //    pantalla como "Gestión OLT" o "Cierre de caja", no), para no acabar
  //    renombrando encabezados de la interfaz.
  const enmascarados = [];
  const tresPalabras = (s) => s.trim().split(/\s+/).length >= 3;
  for (const el of document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="Title"]')) {
    if (el.children.length) continue;
    const v = (el.textContent || '').trim();
    if (!tresPalabras(v) || !esNombre(v)) continue;
    enmascarados.push([v, falsoNombre(v)]);
    el.textContent = falsoNombre(v);
  }

  // 3) Barrido final de patrones inequívocos en cualquier nodo de texto suelto:
  //    correos, celulares colombianos, documentos de identidad y los restos del
  //    nombre ya enmascarado (el usuario PPPoE es el nombre pegado y en
  //    mayúsculas: ERIKACRUZCASTRO).
  const restos = enmascarados.flatMap(([real, falso]) => {
    const pega = (s) => s.replace(/\s+/g, '');
    return [
      [real, falso],
      [pega(real).toUpperCase(), pega(falso).toUpperCase()],
      [pega(real).toLowerCase(), pega(falso).toLowerCase()],
    ];
  });
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodos = [];
  while (w.nextNode()) nodos.push(w.currentNode);
  for (const n of nodos) {
    const p = n.parentElement;
    if (!p || ['SCRIPT', 'STYLE'].includes(p.tagName)) continue;
    let t = n.nodeValue;
    if (!t || t.length > 200) continue;
    const orig = t;
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'cliente@ejemplo.com');
    t = t.replace(/\b3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, (m) => falsoTel(m));
    // Cédula/NIT rotulados en la misma cadena: "CC 1117824630".
    t = t.replace(/\b(CC|C\.C\.|NIT|TI|CE|RC|PA)\s*\.?\s*[\d.,-]{6,15}\b/gi,
      (m, tipo) => `${tipo} ${falsoDoc(m)}`);
    for (const [real, falso] of restos) if (real) t = t.split(real).join(falso);
    if (t !== orig) n.nodeValue = t;
  }

  // 3.bis) La cédula suele venir partida en dos nodos ("CC" en un <span> y el
  //    número en otro), y entonces el barrido por texto no la ve. Aquí se busca
  //    el trozo de interfaz PEQUEÑO que menciona el tipo de documento y se
  //    sustituye cualquier número largo que cuelgue de él.
  const ROT_DOC = /\b(CC|C\.C\.|NIT|TI|CE|RC|PA|c[eé]dula|documento)\b/i;
  for (const el of document.querySelectorAll('span, div, p, li, td, dd, h1, h2, h3, small, strong, b')) {
    const texto = el.textContent || '';
    // El tope de longitud acota el destrozo: un bloque grande que mencione
    // "documento" de pasada no debe perder todos sus números.
    if (texto.length > 120 || !ROT_DOC.test(texto)) continue;
    const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w2.nextNode()) {
      const n2 = w2.currentNode;
      const v = n2.nodeValue || '';
      if (!/\d/.test(v)) continue;
      n2.nodeValue = v.replace(/\b\d[\d.]{5,14}\b/g, (m) => falsoDoc(m));
    }
  }

  // 4) La cuenta con la que se toman las fotos no debe salir en el manual.
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length === 0 && /Capturas de manuales/i.test(el.textContent || '')) {
      el.textContent = 'Usuario de ejemplo';
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // --solo-extras: rehacer únicamente las fichas y ventanas emergentes, que es
  // lo que hay que repetir cuando cambia el enmascarado de datos personales.
  const lista = process.argv.includes('--solo-extras')
    ? extras()
    : [...rutas(), ...extras()];
  console.log(`${lista.length} pantallas a capturar desde ${BASE}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // x2: en el PDF la captura se imprime a ~160 mm; a escala 1 se ve borrosa.
    deviceScaleFactor: 2,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
  });
  const page = await ctx.newPage();

  // --- Login ---
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  // La pantalla de entrada es la única que hay que fotografiar ANTES de la
  // sesión: una vez dentro, /login redirige y nunca se vuelve a ver.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'login.png') });
  await page.fill('input[type="email"]', USER);
  await page.fill('input[type="password"]', PASS);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]).catch(async () => {
    const err = await page.textContent('body').catch(() => '');
    throw new Error(`No entró al sistema. ¿Usuario o clave incorrectos?\n${err?.slice(0, 300)}`);
  });
  console.log(`  sesión iniciada como ${USER}`);

  // Las animaciones de entrada salían congeladas a medias en la captura.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important}
              ::-webkit-scrollbar{width:0;height:0}`,
  });

  const ok = [];
  const fallo = [];
  for (const { slug, ruta, docs, pasos } of lista) {
    const destino = join(OUT, `${slug}.png`);
    try {
      // `networkidle` no sirve en esta aplicación: la campana de avisos consulta
      // sola cada pocos segundos, así que la red nunca queda quieta y pantallas
      // perfectamente sanas (los reportes de IVA y de órdenes) se perdían por
      // agotar el tiempo de espera. Se carga el documento y se le da tiempo de
      // pintar más abajo, que es lo que de verdad importa para una foto.
      const res = await page.goto(`${BASE}${ruta}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      // Un 404 del router o un redirect al login = esa pantalla no existe o no
      // la ve este usuario; mejor no capturar nada que capturar un error.
      if (page.url().includes('/login')) throw new Error('redirigió al login');
      if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
      // Con timeout corto y tolerante: una pantalla que tarda en pintar (el
      // reporte de IVA sin filtro de fechas bloquea el navegador un buen rato)
      // no debe perder su captura por no poder leerle el texto al cuerpo.
      const cuerpo = (await page.textContent('body', { timeout: 8000 }).catch(() => '')) || '';
      if (/404|no encontrad|no tienes permiso|sin permiso/i.test(cuerpo.slice(0, 400))) {
        throw new Error('pantalla no disponible para este usuario');
      }
      await page.waitForTimeout(2200); // que terminen de pintar tablas y gráficas
      if (pasos.length) await ejecutaPasos(page, pasos);
      else if (PIDE_FILTRO.test(cuerpo)) await rellenaFiltros(page);
      if (MASCARA) await page.evaluate(enmascarar);
      await page.screenshot({ path: destino });
      ok.push(ruta);
      console.log(`  ok  ${ruta}  → ${slug}.png  [${docs.join(', ')}]`);
    } catch (e) {
      fallo.push([ruta, e.message]);
      console.log(`  --  ${ruta}  (${e.message})`);
    }
  }

  await browser.close();
  console.log(`\nCapturadas ${ok.length}/${lista.length} en ${OUT}`);
  if (fallo.length) {
    console.log('Sin captura:');
    for (const [r, m] of fallo) console.log(`  ${r} — ${m}`);
  }
}

if (!existsSync(SRC)) {
  console.error(`No existe ${SRC}`);
  process.exit(1);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
