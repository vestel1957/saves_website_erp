/* eslint-disable */
// Genera manuales de usuario en PDF (branding BHDC) para Inventario y Contabilidad.
// Uso: node scripts/gen-manuals.js   (desde la carpeta backend; usa pdfkit ya instalado)
const PDFDocument = require('pdfkit');
const { createWriteStream, existsSync, mkdirSync } = require('fs');
const { join } = require('path');

// --- Paleta de marca (misma que el desprendible de nómina) ---
const BRAND = '#ea580c', GOLD = '#f2ae2e', RED = '#bf303c';
const INK = '#0f172a', INK2 = '#475569', INK3 = '#94a3b8';
const TINT = '#fff7ed', TINT_INK = '#9a3412';

const PAGE = { w: 595.28, h: 841.89 };
const M = 50;
const CW = PAGE.w - M * 2;
const BOTTOM = PAGE.h - 60;

function logoPath() {
  for (const p of [
    join(process.cwd(), '..', 'LOGO BHDC Completo.png'),
    join(process.cwd(), 'LOGO BHDC Completo.png'),
    '/home/dev/nexus-erp/LOGO BHDC Completo.png',
  ]) if (existsSync(p)) return p;
  return null;
}

function fechaLarga() {
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const d = new Date();
  return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function buildManual(content, outPath) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: M, size: 'A4', autoFirstPage: false });
    const stream = createWriteStream(outPath);
    doc.pipe(stream);

    let pageNum = 0;
    // Cromos (accent superior + pie) en cada página añadida.
    doc.on('pageAdded', () => {
      pageNum += 1;
      if (pageNum === 1) return; // la portada se dibuja aparte
      // Anular el margen inferior mientras dibujamos el pie: si escribimos texto
      // por debajo del margen, pdfkit añadiría otra página → recursión infinita.
      const oldBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.rect(0, 0, PAGE.w, 4).fill(BRAND);
      doc.fillColor(INK3).font('Helvetica').fontSize(8)
        .text(`BHDC · Manual de Usuario — ${content.module}`, M, PAGE.h - 38, { width: CW, align: 'left', lineBreak: false });
      doc.fillColor(INK3).font('Helvetica').fontSize(8)
        .text(`Página ${pageNum - 1}`, M, PAGE.h - 38, { width: CW, align: 'right', lineBreak: false });
      doc.page.margins.bottom = oldBottom;
      doc.x = M; doc.y = M;
    });

    // ---------- PORTADA ----------
    doc.addPage();
    doc.rect(0, 0, PAGE.w, 10).fill(GOLD);
    doc.rect(0, 0, PAGE.w * 0.6, 10).fill(BRAND);
    doc.rect(0, 0, PAGE.w * 0.25, 10).fill(RED);
    let y = 150;
    const logo = logoPath();
    if (logo) { try { doc.image(logo, (PAGE.w - 190) / 2, y, { width: 190 }); y += 140; } catch (e) {} }
    else { y += 20; }
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(30).text('Manual de Usuario', M, y, { width: CW, align: 'center' });
    y = doc.y + 6;
    doc.rect((PAGE.w - 70) / 2, y, 70, 3).fill(BRAND);
    y += 22;
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(20).text(`Módulo de ${content.module}`, M, y, { width: CW, align: 'center' });
    y = doc.y + 10;
    doc.fillColor(INK2).font('Helvetica').fontSize(11).text(content.tagline, M, y, { width: CW, align: 'center' });
    // pie de portada
    doc.fillColor(INK3).font('Helvetica').fontSize(9)
      .text(`BHDC · Documento generado el ${fechaLarga()}`, M, PAGE.h - 80, { width: CW, align: 'center' });
    doc.fillColor(INK3).fontSize(8)
      .text('Guía de uso para el personal. Las pantallas se acceden desde el menú lateral.', M, PAGE.h - 64, { width: CW, align: 'center' });

    // ---------- CONTENIDO (índice simple) ----------
    doc.addPage();
    sectionBar(doc, 'Contenido');
    doc.moveDown(0.3);
    content.chapters.forEach((c, i) => {
      need(doc, 16);
      const yy = doc.y;
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text(`${i + 1}.`, M, yy, { width: 22 });
      doc.fillColor(INK2).font('Helvetica').fontSize(10).text(c.title, M + 22, yy, { width: CW - 22 });
      doc.moveDown(0.2);
    });

    // ---------- INTRO ----------
    if (content.intro && content.intro.length) {
      doc.addPage();
      sectionBar(doc, 'Antes de empezar');
      content.intro.forEach((p) => para(doc, p));
    }

    // ---------- CAPÍTULOS ----------
    content.chapters.forEach((c, i) => {
      doc.addPage();
      chapterTitle(doc, i + 1, c.title);
      meta(doc, c.menu, c.route);
      doc.moveDown(0.5);
      if (c.purpose) { sub(doc, 'Para qué sirve'); para(doc, c.purpose); }
      if (c.actions && c.actions.length) { sub(doc, 'Acciones principales'); bullets(doc, c.actions); }
      if (c.steps && c.steps.length) { sub(doc, 'Paso a paso'); steps(doc, c.steps); }
      if (c.tip) tip(doc, c.tip);
    });

    doc.end();
    stream.on('finish', () => resolve(outPath));
  });
}

// ---------- helpers de layout ----------
function need(doc, h) { if (doc.y + h > BOTTOM) doc.addPage(); }

function sectionBar(doc, title) {
  const yy = doc.y;
  doc.rect(M, yy, CW, 26).fill(TINT);
  doc.rect(M, yy, 4, 26).fill(BRAND);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(title, M + 14, yy + 6, { width: CW - 20 });
  doc.y = yy + 34;
}

function chapterTitle(doc, n, title) {
  const yy = doc.y;
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(11).text(`${n}`, M, yy + 2, { width: 22 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(title, M + 22, yy, { width: CW - 22 });
  doc.moveDown(0.1);
  const ly = doc.y + 2;
  doc.rect(M, ly, CW, 1.4).fill(BRAND);
  doc.y = ly + 8;
}

function meta(doc, menu, route) {
  doc.font('Helvetica').fontSize(8.5).fillColor(INK3)
    .text(`Menú lateral: ${menu}    ·    Ruta: ${route}`, M, doc.y, { width: CW });
}

function sub(doc, t) {
  need(doc, 26);
  doc.moveDown(0.45);
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10.5).text(t, M, doc.y, { width: CW });
  doc.moveDown(0.2);
}

function para(doc, t) {
  doc.font('Helvetica').fontSize(10).fillColor(INK2);
  const h = doc.heightOfString(t, { width: CW });
  need(doc, h);
  doc.text(t, M, doc.y, { width: CW });
  doc.moveDown(0.35);
}

function bullets(doc, items) {
  for (const it of items) {
    doc.font('Helvetica').fontSize(10).fillColor(INK2);
    const h = doc.heightOfString(it, { width: CW - 14 });
    need(doc, h + 2);
    const yy = doc.y;
    doc.circle(M + 3, yy + 5, 1.7).fill(GOLD);
    doc.fillColor(INK2).font('Helvetica').fontSize(10).text(it, M + 12, yy, { width: CW - 12 });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.1);
}

function steps(doc, items) {
  let i = 1;
  for (const it of items) {
    doc.font('Helvetica').fontSize(10).fillColor(INK2);
    const h = Math.max(16, doc.heightOfString(it, { width: CW - 22 }));
    need(doc, h + 4);
    const yy = doc.y;
    doc.circle(M + 7, yy + 6, 7.5).fill(BRAND);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8).text(String(i), M + 0.5, yy + 3, { width: 13, align: 'center' });
    doc.fillColor(INK2).font('Helvetica').fontSize(10).text(it, M + 22, yy, { width: CW - 22 });
    doc.moveDown(0.3);
    i += 1;
  }
  doc.moveDown(0.1);
}

function tip(doc, t) {
  const pad = 9;
  const innerW = CW - pad * 2;
  const full = 'Sugerencia:  ' + t;
  doc.font('Helvetica').fontSize(9);
  const h = doc.heightOfString(full, { width: innerW }) + pad * 2;
  need(doc, h + 6);
  doc.moveDown(0.2);
  const yy = doc.y;
  doc.roundedRect(M, yy, CW, h, 5).fill(TINT);
  doc.rect(M, yy, 3, h).fill(GOLD);
  doc.fillColor(TINT_INK).font('Helvetica-Bold').fontSize(9).text('Sugerencia:  ', M + pad + 3, yy + pad, { continued: true, width: innerW });
  doc.font('Helvetica').fillColor(TINT_INK).text(t);
  doc.y = yy + h;
  doc.moveDown(0.5);
}

// ==================== CONTENIDO ====================
const COMMON_INTRO = [
  'Esta guía explica, pantalla por pantalla, cómo usar el módulo en el día a día. Cada capítulo indica en qué parte del menú lateral encontrar la pantalla, para qué sirve, qué acciones ofrece y el paso a paso recomendado.',
  'Cómo navegar: inicia sesión con tu usuario y contraseña. En el menú lateral izquierdo verás las secciones agrupadas por área; haz clic en una opción para abrir su pantalla. En pantallas pequeñas (celular) el menú se contrae en un botón y las tablas se muestran como tarjetas.',
  'Permisos: cada usuario ve solo las pantallas y acciones que su rol permite. Si no ves un botón o una sección, es porque tu rol no tiene ese permiso; solicítalo al administrador.',
  'Convenciones: los botones de color naranja ejecutan la acción principal de cada pantalla (crear, guardar, registrar). Los filtros y buscadores están en la parte superior de cada listado. Las acciones sobre un registro (editar, ver, pagar, etc.) aparecen al final de su fila.',
];

const inventory = {
  module: 'Inventario',
  tagline: 'Catálogo, existencias, movimientos, compras, recepciones, alertas y mantenimiento',
  intro: COMMON_INTRO,
  chapters: [
    { title: 'Resumen de inventario', menu: 'Inventario › Resumen', route: '/inventario',
      purpose: 'Tablero de indicadores en tiempo real para ver de un vistazo la salud del inventario: valor total, stock disponible y comprometido, productos agotados, bajo mínimo, sin movimiento, ajustes, órdenes abiertas y recepciones pendientes.',
      actions: ['Visualización de tarjetas con los indicadores clave (no requiere crear nada).'],
      steps: ['Al entrar, revisa las tarjetas de indicadores.', 'Identifica focos de atención (agotados, bajo mínimo, recepciones pendientes).', 'Desde ahí decide la siguiente acción: reordenar, ajustar o revisar recepciones.'] },
    { title: 'Productos', menu: 'Inventario › Productos', route: '/inventario/productos',
      purpose: 'Catálogo de productos junto con sus categorías, marcas y unidades de medida. Es la base de todo el inventario.',
      actions: ['"Nuevo producto": crea un producto con SKU, nombre, tipo, categoría, marca, unidad, método de costeo, costo estándar, control por serie y, opcionalmente, stock inicial y límite de alerta.', 'Buscar por SKU o nombre y filtrar por fecha.', 'Editar, desactivar o reactivar productos desde la tabla.', 'Pestañas Categorías, Marcas y Unidades para mantener esos catálogos.'],
      steps: ['Haz clic en "Nuevo producto".', 'Completa los campos obligatorios (SKU y nombre) y los opcionales (categoría, marca, unidad).', 'Si aplica, asigna stock inicial y el límite de alerta.', 'Guarda. Usa las pestañas superiores para administrar categorías, marcas y unidades.'],
      tip: 'Define bien la unidad de medida y el método de costeo al crear el producto: son la base para que el kardex y los valores salgan correctos.' },
    { title: 'Existencias (inventario disponible)', menu: 'Inventario › Existencias', route: '/inventario/existencias',
      purpose: 'Muestra cuánto hay de cada producto y en qué bodega: en mano, disponible, último ingreso, costo promedio y valor.',
      actions: ['Buscar por producto o SKU.', 'Filtrar por bodega y por categoría.', 'Limpiar filtros para volver a ver todo.'],
      steps: ['Abre Existencias para ver el stock de todas las bodegas.', 'Busca un producto o filtra por bodega/categoría.', 'Revisa "Disponible" y "En mano", la fecha de último ingreso y el valor.'] },
    { title: 'Entradas y salidas (movimientos de existencias)', menu: 'Inventario › Existencias › Entradas y salidas', route: '/inventario/existencias/movimientos',
      purpose: 'Registra entradas, salidas y traspasos entre bodegas. Cada movimiento queda en el historial de costos (kardex).',
      actions: ['"Registrar movimiento": entrada (con bodega destino, costo unitario y motivo), salida (con bodega origen y motivo) o traspaso (origen y destino).', 'Filtrar por tipo y buscar por producto.'],
      steps: ['Haz clic en "Registrar movimiento".', 'Elige el tipo: entrada, salida o traspaso.', 'Selecciona producto, cantidad, motivo y las bodegas que correspondan.', 'Agrega referencia (factura, remisión) y notas si aplica.', 'Guarda: el movimiento impacta el kardex y el costo.'] },
    { title: 'Historial de costos (kardex)', menu: 'Inventario › Existencias › Historial de costos', route: '/inventario/existencias/kardex',
      purpose: 'Muestra cómo se han movido el stock y el costo de un producto en el tiempo, con saldo y costo promedio en cada movimiento.',
      actions: ['Seleccionar producto y filtrar por bodega y rango de fechas.', '"Exportar CSV" para análisis o auditoría.', 'Ver indicadores: stock actual, valor, costo promedio, total entradas y salidas.'],
      steps: ['Selecciona o busca el producto.', 'Si quieres, filtra por bodega y por rango de fechas.', 'Revisa los indicadores y la evolución del valor.', 'Exporta a CSV si necesitas el detalle por fuera.'] },
    { title: 'Bodegas', menu: 'Inventario › Bodegas', route: '/inventario/bodegas',
      purpose: 'Administra las bodegas (almacenes) y sus ubicaciones físicas internas (zona, pasillo, estante, casilla).',
      actions: ['"Nueva bodega": código, nombre, tipo, dirección y responsable.', '"Ver detalle": administra las ubicaciones internas de cada bodega.'],
      steps: ['Haz clic en "Nueva bodega".', 'Ingresa código, nombre y tipo; opcionalmente dirección.', 'Asigna un responsable (puede recibir alertas por WhatsApp).', 'Entra a "Ver detalle" para crear ubicaciones (zonas, pasillos, estantes).'] },
    { title: 'Movimientos', menu: 'Inventario › Movimientos', route: '/inventario/movimientos',
      purpose: 'Listado y registro de entradas, salidas y transferencias manuales entre bodegas; cada una pasa por el kardex.',
      actions: ['"Nuevo movimiento" con tipo, producto, cantidad, bodegas, motivo, fecha, referencia y notas.', 'Filtrar por tipo y bodega; buscar por producto.'],
      steps: ['Haz clic en "Nuevo movimiento".', 'Elige el tipo (entrada/salida/transferencia).', 'Selecciona producto, cantidad y bodegas según corresponda.', 'Indica el motivo para mantener la trazabilidad y guarda.'] },
    { title: 'Ajustes de inventario', menu: 'Inventario › Ajustes', route: '/inventario/ajustes',
      purpose: 'Corrige existencias por daño, robo, pérdida o error. Todo queda trazado en el kardex.',
      actions: ['"Nuevo ajuste" para una bodega con un motivo (daño, robo, pérdida, error operativo, corrección, diferencia de conteo).', 'Agregar varias líneas de producto con cantidad positiva (entra) o negativa (sale).', 'Adjuntar evidencia (foto, acta) y notas.'],
      steps: ['Haz clic en "Nuevo ajuste".', 'Selecciona la bodega y el motivo.', 'Agrega líneas de producto con el ajuste (+ entra / − sale).', 'Adjunta evidencia si aplica y guarda.'],
      tip: 'El costo unitario solo aplica a los ajustes de entrada. Usa siempre el motivo correcto: es lo que permite auditar después.' },
    { title: 'Recepciones de mercancía', menu: 'Inventario › Recepciones', route: '/inventario/recepciones',
      purpose: 'Registra la entrada de mercancía a bodega, con o sin orden de compra.',
      actions: ['"Nueva recepción" con (opcional) vínculo a una orden de compra que carga las líneas pendientes, bodega destino y fecha.', 'Líneas con cantidad, costo unitario y estado (OK, dañado, faltante).', '"Ver" para revisar el detalle de la recepción.'],
      steps: ['Haz clic en "Nueva recepción".', 'Si la compra tiene orden, selecciónala para cargar las líneas pendientes.', 'Verifica/edita cantidades, costos y el estado de cada ítem.', 'Agrega notas si hay daños o faltantes y guarda: la mercancía entra al stock.'] },
    { title: 'Órdenes de compra', menu: 'Inventario › Órdenes de compra', route: '/inventario/ordenes-compra',
      purpose: 'Crea órdenes a proveedores, envíalas a aprobación y recíbelas en bodega. Maneja estados: borrador, pendiente, aprobada y completada.',
      actions: ['"Nueva orden de compra" con proveedor, bodega destino, fechas y líneas (cantidad, costo).', 'Crear el proveedor al vuelo sin salir del formulario.', '"Enviar a aprobación", "Aprobar", "Cancelar" y "Ver".'],
      steps: ['Haz clic en "Nueva orden de compra".', 'Selecciona o crea el proveedor y agrega las líneas.', 'Guarda como borrador y revísala con "Ver".', 'Pulsa "Enviar a aprobación"; el responsable la "Aprueba".', 'Recibe la mercancía vinculando una recepción a la orden.'] },
    { title: 'Límites y reorden', menu: 'Inventario › Límites y reorden', route: '/inventario/reorden',
      purpose: 'Define el mínimo, el punto de reorden y el máximo por producto y bodega. El sistema alerta y sugiere reposición.',
      actions: ['Pestaña Límites: "Nuevo límite" y "Editar".', 'Pestaña Sugerencias: "Crear OC" para generar una orden de compra en borrador desde una sugerencia.'],
      steps: ['En Límites, haz clic en "Nuevo límite".', 'Define mínimo, punto de reorden (dispara alertas) y máximo; guarda.', 'Ve a Sugerencias para ver los productos bajo el punto de reorden.', 'Pulsa "Crear OC", elige proveedor y confirma para generar la orden en borrador.'] },
    { title: 'Alertas de inventario', menu: 'Inventario › Alertas', route: '/inventario/alertas',
      purpose: 'Muestra el stock bajo el límite y los productos agotados, según las reglas de reorden.',
      actions: ['Filtrar por estado (pendientes/leídas) y por tipo (stock bajo/agotado).', '"Marcar todas", "Marcar leída" y "Escanear ahora".'],
      steps: ['Abre Alertas para ver los problemas de stock.', 'Filtra por estado y tipo.', 'Lee el detalle (producto, bodega, cantidad bajo el límite).', 'Marca como leídas las atendidas o pulsa "Escanear ahora" para revisar al instante.'] },
    { title: 'Asignaciones de material', menu: 'Inventario › Asignaciones', route: '/inventario/asignaciones',
      purpose: 'Entrega de material a funcionarios con custodia y devolución. Mueve el stock al entregar y al devolver. Solo el jefe de bodega puede asignar.',
      actions: ['"Asignar material" a un funcionario (producto, cantidad, bodega origen, fecha, notas).', '"Devolver" (regresa al stock) o "Consumir" (no regresa).'],
      steps: ['Haz clic en "Asignar material".', 'Selecciona funcionario y material, indica cantidad y fecha.', 'Si descuentas de una bodega, selecciónala; guarda.', 'Al terminar, marca "Devolver" o "Consumir" según el caso.'] },
    { title: 'Mantenimiento', menu: 'Inventario › Mantenimiento', route: '/inventario/mantenimiento',
      purpose: 'Bitácora de mantenimientos preventivos y correctivos, con los repuestos consumidos por área.',
      actions: ['"Nuevo mantenimiento": tipo (preventivo/correctivo), componente, área, fecha, técnico, descripción y repuestos consumidos.', 'Pestañas "Uso por área" (costos agregados) y "Áreas" (administrar áreas).'],
      steps: ['Haz clic en "Nuevo mantenimiento".', 'Selecciona el componente (por producto o serie) y el área.', 'Indica fecha, técnico y descripción del trabajo.', 'Agrega los repuestos consumidos (y la bodega para descontarlos) y guarda.'] },
    { title: 'Órdenes de trabajo', menu: 'Inventario › Mantenimiento › Órdenes de trabajo', route: '/inventario/mantenimiento/ordenes',
      purpose: 'Gestión de órdenes de trabajo de mantenimiento. El jefe las crea y asigna; el técnico ejecuta solo las suyas, registra consumos y las cierra.',
      actions: ['"Nueva orden de trabajo" (jefes): título, tipo, prioridad, técnico asignado, área, vencimiento y descripción.', '"Iniciar", "Registrar consumo", "Completar", "Cancelar" y lista de tareas (checklist) con fotos.'],
      steps: ['El jefe crea la orden y la asigna a un técnico.', 'El técnico abre su orden y pulsa "Iniciar".', 'Registra los repuestos consumidos y marca las tareas del checklist.', 'Sube fotos si aplica y pulsa "Completar" con la nota de resolución.'] },
    { title: 'Reportes de inventario', menu: 'Inventario › Reportes', route: '/inventario/reportes',
      purpose: 'Análisis del inventario: valorizado, rotación, reabastecimiento, sin movimiento, ajustes, compras por proveedor y consumo interno.',
      actions: ['Pestañas por tipo de reporte.', 'Indicadores y desglose por bodega en "Valorizado".', '"Exportar existencias (CSV)".'],
      steps: ['Abre Reportes y elige la pestaña del reporte que necesitas.', 'Revisa indicadores y tablas (p. ej. valor total, rotación, sugerencias de compra).', 'Exporta a CSV cuando necesites el detalle por fuera.'] },
  ],
};

const accounting = {
  module: 'Contabilidad',
  tagline: 'Compras, impuestos, activos fijos, libros, informes, cierre y nómina',
  intro: COMMON_INTRO,
  chapters: [
    { title: 'Resumen de contabilidad', menu: 'Contabilidad › Resumen', route: '/contabilidad',
      purpose: 'Resumen financiero en tiempo real: total de activos, pasivos, patrimonio y resultado del período, además de cuentas por pagar, gastos y saldo en bancos.',
      actions: ['Tarjetas con las cifras clave.', 'Accesos rápidos a Compras, Cuentas por pagar, Certificados, Informes, Conciliación y Cierre.'],
      steps: ['Revisa las cifras principales al entrar.', 'Consulta cuentas por pagar y saldos de banco de un vistazo.', 'Usa los accesos rápidos para ir a la pantalla que necesites.'] },
    { title: 'Compras y gastos', menu: 'Contabilidad › Compras y pagos', route: '/contabilidad/compras',
      purpose: 'Facturas de proveedores y contratistas con sus retenciones. El sistema genera el asiento contable automáticamente.',
      actions: ['"Nueva factura": proveedor, fechas, subtotal e impuestos; agrega retenciones (ReteFuente, ReteIVA, ReteICA) y muestra el neto a pagar.', '"Pagar" sobre una factura abierta (banco, monto y fecha).', 'Pestaña Proveedores con "Nuevo proveedor".'],
      steps: ['En la pestaña Facturas, pulsa "Nueva factura".', 'Selecciona proveedor, fechas, subtotal y códigos de impuesto.', 'Agrega retenciones si aplican; revisa el neto a pagar y guarda.', 'Para pagar, pulsa "Pagar" en la factura e indica banco, monto y fecha.'],
      tip: 'Al guardar la factura, el asiento contable se genera solo. No necesitas registrarlo a mano en los libros.' },
    { title: 'Motor de impuestos', menu: 'Contabilidad › (buscar "Impuestos")', route: '/contabilidad/impuestos',
      purpose: 'Códigos de IVA y retenciones configurables, vinculados a cuentas contables. Son los que se aplican en las compras.',
      actions: ['"Nuevo impuesto": código, nombre, tipo, base (subtotal o impuesto), tasa y cuenta contable.'],
      steps: ['Pulsa "Nuevo impuesto".', 'Define el tipo (IVA o retención) y la base de cálculo.', 'Vincúlalo a la cuenta contable y guarda.', 'Úsalo al registrar compras para que el impuesto se aplique solo.'] },
    { title: 'Activos fijos', menu: 'Contabilidad › Activos fijos', route: '/contabilidad/activos-fijos',
      purpose: 'Propiedad, planta y equipo con depreciación automática y bajas con asiento contable.',
      actions: ['"Nuevo activo": código, nombre, categoría, costo, fecha y (opcional) asiento de capitalización.', '"Ejecutar depreciación" por año y mes.', '"Dar de baja" un activo (fecha y valor de venta; calcula utilidad/pérdida).', 'Pestañas Activos, Depreciación y Categorías.'],
      steps: ['En Categorías, define la vida útil (en meses) por categoría.', 'En Activos, pulsa "Nuevo activo" y registra costo y fecha.', 'En Depreciación, ejecuta el mes/año correspondiente.', 'Cuando un activo se retire, usa "Dar de baja".'] },
    { title: 'Centros de costo', menu: 'Contabilidad › (buscar "Centros de costo")', route: '/contabilidad/centros-costo',
      purpose: 'Clasifica gastos e ingresos por área, proyecto o unidad de negocio.',
      actions: ['"Nuevo centro" con código y nombre; opcionalmente un centro padre para armar jerarquías.'],
      steps: ['Pulsa "Nuevo centro".', 'Ingresa código (p. ej. ADM) y nombre.', 'Si aplica, asígnale un centro padre y guarda.'] },
    { title: 'Asientos recurrentes', menu: 'Contabilidad › (buscar "Recurrentes")', route: '/contabilidad/recurrentes',
      purpose: 'Plantillas que generan asientos automáticos según su frecuencia (mensual, trimestral, anual), con materialización diaria.',
      actions: ['"Nueva plantilla" con frecuencia, próxima ejecución y líneas (débito/crédito balanceadas).', '"Ejecutar vencidas" para materializar manualmente las pendientes.'],
      steps: ['Pulsa "Nueva plantilla" y define nombre y frecuencia.', 'Agrega las líneas del asiento (débitos = créditos).', 'Guarda: el sistema lo generará en las fechas previstas.', 'Si hay vencidas, pulsa "Ejecutar vencidas".'] },
    { title: 'Conciliación bancaria', menu: 'Contabilidad › Conciliación', route: '/contabilidad/conciliacion',
      purpose: 'Compara los movimientos del libro contra el extracto del banco para cuadrar saldos.',
      actions: ['Seleccionar la cuenta bancaria.', '"Conciliar automáticamente" por monto y fecha.', 'Conciliación manual: seleccionar un movimiento y una línea del extracto y "Conciliar selección".'],
      steps: ['Selecciona la cuenta bancaria.', 'Pulsa "Conciliar automáticamente".', 'Para lo que quede pendiente, empareja a mano un movimiento con su línea del extracto.', 'Repite hasta que la diferencia sea cero.'] },
    { title: 'Cuentas por pagar', menu: 'Contabilidad › (buscar "Cuentas por pagar")', route: '/contabilidad/cartera',
      purpose: 'Saldos pendientes con proveedores y contratistas, con análisis de antigüedad, derivado de las facturas de compra.',
      actions: ['Vista de saldos abiertos por proveedor con tramos de antigüedad.'],
      steps: ['Abre la pantalla para ver lo pendiente por proveedor.', 'Revisa los tramos de antigüedad (corriente, 30, 60, 90+ días).', 'Prioriza los pagos según vencimiento.'] },
    { title: 'Certificados de retención', menu: 'Contabilidad › (buscar "Certificados")', route: '/contabilidad/certificados',
      purpose: 'Certificados de ReteFuente / ReteIVA / ReteICA practicadas a proveedores, por año gravable.',
      actions: ['Seleccionar el año gravable.', 'Botón "Certificado" por proveedor (HTML listo para imprimir).'],
      steps: ['Elige el año gravable.', 'Ubica al proveedor en la lista.', 'Pulsa "Certificado" para abrir el documento e imprimirlo o guardarlo.'] },
    { title: 'Libros contables', menu: 'Contabilidad › Libros', route: '/contabilidad/libros',
      purpose: 'Los asientos vistos por fecha (libro diario) o por cuenta (libro mayor): la misma información en dos vistas.',
      actions: ['Pestaña Libro diario (cronológico).', 'Pestaña Libro mayor (selecciona una cuenta y ve sus movimientos).'],
      steps: ['Abre Libro diario para ver todos los asientos por fecha.', 'Cambia a Libro mayor y elige una cuenta.', 'Revisa débitos, créditos y saldo de esa cuenta.'] },
    { title: 'Informes financieros', menu: 'Contabilidad › Informes', route: '/contabilidad/informes',
      purpose: 'Balance de comprobación y estados financieros (balance general, estado de resultados y flujo de efectivo).',
      actions: ['Pestañas por informe.', 'Exportar a PDF y a Excel.'],
      steps: ['Elige la pestaña del informe que necesitas.', 'Revisa los datos en pantalla.', 'Exporta a PDF o Excel para compartir o archivar.'] },
    { title: 'Cierre contable', menu: 'Contabilidad › Cierre contable', route: '/contabilidad/cierre',
      purpose: 'Apertura y cierre de períodos fiscales mensuales y cierre anual de resultados.',
      actions: ['"Abrir mes" (año, mes y rango de fechas).', '"Cierre anual".', '"Cerrar" y "Reabrir" períodos.'],
      steps: ['Pulsa "Abrir mes" y define el período.', 'Registra todos los asientos del mes.', 'Cuando termine, pulsa "Cerrar" para bloquearlo.', 'A fin de año, usa "Cierre anual" para generar el asiento de cierre.'],
      tip: 'Cerrar un período impide registrar más asientos en él. Asegúrate de tener todo cargado antes de cerrar.' },
    { title: 'Nómina — Resumen', menu: 'Contabilidad › Resumen nómina', route: '/contabilidad/nomina',
      purpose: 'Punto de entrada a la nómina: indicadores del período más reciente y accesos a conceptos, períodos, novedades, desprendibles y Mi Nómina.',
      actions: ['Tarjetas de indicadores y accesos rápidos a las subpantallas de nómina.'],
      steps: ['Revisa el período más reciente y su costo.', 'Entra a la subpantalla que necesites desde los accesos.'] },
    { title: 'Nómina — Períodos (liquidación)', menu: 'Contabilidad › Liquidación', route: '/contabilidad/nomina/periodos',
      purpose: 'Abre, liquida y cierra los períodos de pago.',
      actions: ['"Nuevo período" (nombre, fechas y día de pago).', '"Liquidar", "Procesar", "Cerrar" y "Ver desprendibles".'],
      steps: ['Pulsa "Nuevo período" y define fechas y día de pago.', 'Pulsa "Liquidar" para calcular los desprendibles de los empleados con contrato activo.', 'Pulsa "Procesar" y luego "Cerrar" para dejar el período en firme.'] },
    { title: 'Nómina — Conceptos', menu: 'Contabilidad › Configuración nómina', route: '/contabilidad/nomina/conceptos',
      purpose: 'Devengados y deducciones configurables; las reglas viven en datos (no en código).',
      actions: ['"Nuevo concepto": tipo (devengado/deducción), naturaleza, cálculo (fijo/porcentaje/proporcional) y tasa/base.', '"Editar" y "Desactivar".'],
      steps: ['Pulsa "Nuevo concepto".', 'Define tipo, forma de cálculo y base.', 'Marca si se auto-aplica y si afecta salud/pensión; guarda.'] },
    { title: 'Nómina — Contratos', menu: 'Contabilidad › Configuración nómina › Contratos', route: '/contabilidad/nomina/contratos',
      purpose: 'Salario, jornada y vigencia que alimentan la liquidación de nómina.',
      actions: ['"Nuevo contrato": empleado, tipo, clase de pago (quincenal/roll), salario base, auxilio de transporte y vigencia.', '"Editar" y "Desactivar".'],
      steps: ['Pulsa "Nuevo contrato" y selecciona el empleado.', 'Define tipo, clase de pago y salario base.', 'Ingresa horas mensuales, auxilio de transporte y fechas; guarda.'] },
    { title: 'Nómina — Novedades', menu: 'Contabilidad › (buscar "Novedades")', route: '/contabilidad/nomina/novedades',
      purpose: 'Horas extras, bonos, comisiones, vacaciones y deducciones que afectan la liquidación.',
      actions: ['"Nueva novedad": empleado, concepto, cantidad/monto y fechas.', '"Aprobar" / "Rechazar" las pendientes (si tienes permiso).'],
      steps: ['Pulsa "Nueva novedad" y selecciona empleado y tipo.', 'Indica cantidad o monto y el rango de fechas; guarda.', 'El aprobador revisa y aprueba; así entra en el cálculo del desprendible.'] },
    { title: 'Nómina — Desprendibles', menu: 'Contabilidad › (buscar "Desprendibles")', route: '/contabilidad/nomina/desprendibles',
      purpose: 'Liquidaciones por período; abre el detalle para ver el desglose completo y descargar el PDF.',
      actions: ['Filtrar por período.', '"Ver desprendible" para el detalle y descarga en PDF.'],
      steps: ['Selecciona el período.', 'Ubica al empleado en la lista.', 'Pulsa "Ver desprendible" para ver devengados/deducciones y descargar el PDF.'] },
    { title: 'Nómina electrónica (DIAN)', menu: 'Contabilidad › Nómina electrónica', route: '/contabilidad/nomina/electronica',
      purpose: 'Documento Soporte de Pago de Nómina Electrónica (DIAN): vista previa por empleado y envío al proveedor tecnológico.',
      actions: ['Seleccionar período.', '"Generar vista previa", "Registrar (dry-run)" y "Enviar a la DIAN" (si hay proveedor configurado).'],
      steps: ['Selecciona el período y pulsa "Generar vista previa".', 'Revisa devengados y deducciones por empleado.', 'Usa "Registrar (dry-run)" para probar o "Enviar a la DIAN" para el envío real.'] },
    { title: 'Mi Nómina (portal del empleado)', menu: 'Contabilidad › Mi Nómina', route: '/contabilidad/nomina/mi-nomina',
      purpose: 'Cada empleado consulta sus propios desprendibles y acumulados (vacaciones, horas extras y bonificaciones).',
      actions: ['Tarjetas de acumulados.', 'Listado de desprendibles con "Ver detalle" y descarga de PDF.'],
      steps: ['Revisa tus acumulados en la parte superior.', 'Busca el desprendible por período.', 'Pulsa "Ver detalle" para el desglose y descarga el PDF si lo necesitas.'] },
    { title: 'Plan de cuentas', menu: 'Contabilidad › Configuración', route: '/contabilidad/plan-de-cuentas',
      purpose: 'Estructura jerárquica de cuentas: activos, pasivos, patrimonio, ingresos, costos y gastos. Es la referencia para registrar.',
      actions: ['Vista en árbol de todas las cuentas activas.'],
      steps: ['Abre el plan de cuentas.', 'Expande las ramas por tipo de cuenta.', 'Úsalo como referencia al registrar facturas, impuestos y asientos.'] },
  ],
};

(async () => {
  const outDir = join(process.cwd(), '..', 'docs', 'manuales');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const a = await buildManual(inventory, join(outDir, 'Manual de Usuario - Inventario.pdf'));
  const b = await buildManual(accounting, join(outDir, 'Manual de Usuario - Contabilidad.pdf'));
  console.log('OK:', a);
  console.log('OK:', b);
})();
