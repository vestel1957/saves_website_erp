/**
 * La aritmética del calendario, sin JSX.
 *
 * Está aparte de las vistas porque las tres (mes, semana, día) hacen las MISMAS
 * cuentas —qué días entran en la rejilla, qué eventos cruzan un día, cómo se
 * reparten los que se solapan— y tenerlas escritas tres veces es cómo se consigue
 * que el mes diga que hay tres visitas y la semana enseñe dos.
 *
 * ── LA HORA ES LA DEL NAVEGADOR, Y ESO ES DELIBERADO ─────────────────────────
 * La rejilla se dibuja con `Date` local: "la casilla del martes" es el martes de
 * quien mira la pantalla. El backend, en cambio, recorta por DÍAS DE COLOMBIA
 * (`rangoDeDiasColombia`). En la práctica coinciden —la empresa opera en Colombia,
 * que es UTC-5 todo el año y sin horario de verano—, pero para que un navegador con
 * otra zona no pierda los eventos del borde, la ventana que se pide va con un día de
 * margen a cada lado (`ventanaDe`). Sobra información, nunca falta.
 */

export type Evento = {
  id: string;
  orderNo: number | null;
  title: string | null;
  description: string | null;
  color: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  priority: string | null;
  assignedBy: string | null;
};

export const MS_DIA = 86_400_000;
const MIN_DIA = 1440;

/** Duración que se le supone a un evento que no trae fin: una hora, como en Google. */
export const DURACION_POR_DEFECTO_MIN = 60;

export const inicioDeDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const sumarDias = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const sumarMeses = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const mismoDia = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `YYYY-MM-DD` de un `Date`, en la zona del navegador (la misma con la que se dibuja). */
export const diaISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** `YYYY-MM-DDTHH:mm` para un `<input type="datetime-local">`. */
export const paraInput = (d: Date) =>
  `${diaISO(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * El lunes de la semana de `d`.
 *
 * Lunes y no domingo: es el primer día de la semana en Colombia, y una rejilla que
 * parte la semana laboral en dos filas obliga a mirar dos sitios para saber cómo
 * viene el trabajo. (`getDay()` devuelve 0 para domingo, de ahí el ajuste.)
 */
export function inicioDeSemana(d: Date): Date {
  const dia = d.getDay();
  return sumarDias(d, dia === 0 ? -6 : 1 - dia);
}

/** Los 42 días de la rejilla del mes: seis semanas completas, empezando en lunes. */
export function rejillaDeMes(ancla: Date): Date[] {
  const primero = new Date(ancla.getFullYear(), ancla.getMonth(), 1);
  const arranque = inicioDeSemana(primero);
  return Array.from({ length: 42 }, (_, i) => sumarDias(arranque, i));
}

export const semanaDe = (ancla: Date): Date[] => {
  const lunes = inicioDeSemana(ancla);
  return Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i));
};

export const DIAS_CORTOS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

export const nombreDeMes = (d: Date) =>
  d.toLocaleDateString("es-CO", { month: "long", year: "numeric" });

export const horaCorta = (d: Date) =>
  d.toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" }).replace(/\s?[ap]\.?\s?m\.?/i, (m) => m.trim().replace(/\./g, ""));

export const esFinDeSemana = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

// ── Los eventos sobre la rejilla ────────────────────────────────────────────

export const inicioDe = (e: Evento): Date => new Date(e.start ?? 0);

/**
 * Cuándo ACABA un evento, para pintarlo.
 *
 * Un evento sin `end` es un instante y no un intervalo, pero un rectángulo de altura
 * cero no se ve ni se puede pulsar: se le da la hora por defecto. Los de todo el día
 * acaban al final de su día, o el rectángulo se comería la primera casilla del
 * siguiente.
 */
export function finDe(e: Evento): Date {
  const ini = inicioDe(e);
  if (e.allDay) return e.end ? new Date(e.end) : new Date(inicioDeDia(ini).getTime() + MS_DIA - 1);
  if (!e.end) return new Date(ini.getTime() + DURACION_POR_DEFECTO_MIN * 60_000);
  const fin = new Date(e.end);
  return fin.getTime() > ini.getTime() ? fin : new Date(ini.getTime() + DURACION_POR_DEFECTO_MIN * 60_000);
}

/** ¿El evento toca este día? (cruza, no necesariamente empieza en él). */
export function cruzaElDia(e: Evento, dia: Date): boolean {
  if (!e.start) return false;
  const desde = inicioDeDia(dia).getTime();
  const hasta = desde + MS_DIA;
  return inicioDe(e).getTime() < hasta && finDe(e).getTime() > desde;
}

/**
 * ¿Va en la BANDA de arriba en vez de en su hora?
 *
 * Los de todo el día, evidentemente; y también los que cruzan la medianoche, que no
 * caben en una columna de un solo día. Es la misma regla que usan Google y Apple, y
 * la que hace que una instalación de dos días se lea como una barra y no como dos
 * citas sueltas sin relación.
 */
export const vaEnLaBanda = (e: Evento) =>
  e.allDay || !mismoDia(inicioDe(e), new Date(finDe(e).getTime() - 1));

/** Minutos desde la medianoche de `dia` en que el evento entra y sale de ESE día. */
export function tramoDelDia(e: Evento, dia: Date): { desde: number; hasta: number } {
  const cero = inicioDeDia(dia).getTime();
  const desde = Math.max(0, Math.round((inicioDe(e).getTime() - cero) / 60_000));
  const hasta = Math.min(MIN_DIA, Math.round((finDe(e).getTime() - cero) / 60_000));
  // Un tramo de menos de 20 minutos se dibuja con 20: por debajo el rectángulo no
  // admite ni una línea de texto y el evento queda como una raya sin nombre.
  return { desde: Math.min(desde, MIN_DIA - 20), hasta: Math.max(hasta, Math.min(desde, MIN_DIA - 20) + 20) };
}

export type Reparto<T> = { item: T; columna: number; columnas: number };

/**
 * Reparte en COLUMNAS los eventos que se pisan, para que ninguno tape a otro.
 *
 * Es el mismo reparto de Google: se recorren en orden de inicio, se agrupan los que
 * forman una cadena de solapes (un «racimo») y dentro del racimo cada uno cae en la
 * primera columna libre. El ancho lo fija el racimo entero, no el par que se toca:
 * si tres citas coinciden a las 10, las tres miden un tercio aunque la tercera sólo
 * se pise con la segunda — repartir por pares deja columnas de anchos distintos que
 * se leen como si unas citas fueran más importantes que otras.
 */
export function repartirEnColumnas<T>(
  items: T[],
  tramo: (t: T) => { desde: number; hasta: number },
): Reparto<T>[] {
  const ordenados = [...items].sort((a, b) => tramo(a).desde - tramo(b).desde || tramo(b).hasta - tramo(a).hasta);
  const salida: Reparto<T>[] = [];

  let racimo: { item: T; columna: number }[] = [];
  let finDelRacimo = -1;

  const cerrar = () => {
    if (!racimo.length) return;
    const columnas = Math.max(...racimo.map((r) => r.columna)) + 1;
    for (const r of racimo) salida.push({ item: r.item, columna: r.columna, columnas });
    racimo = [];
    finDelRacimo = -1;
  };

  for (const item of ordenados) {
    const { desde, hasta } = tramo(item);
    if (desde >= finDelRacimo) cerrar();
    // La primera columna cuyo último evento ya terminó. `ocupadas` se recalcula
    // dentro del racimo, que es el único sitio donde puede haber choque.
    const ocupadas = new Set(racimo.filter((r) => tramo(r.item).hasta > desde).map((r) => r.columna));
    let columna = 0;
    while (ocupadas.has(columna)) columna++;
    racimo.push({ item, columna });
    finDelRacimo = Math.max(finDelRacimo, hasta);
  }
  cerrar();
  return salida;
}

/**
 * Coloca en CARRILES horizontales las barras de varios días de una semana.
 *
 * A diferencia del reparto en columnas, aquí no se estrecha nada: una barra ocupa sus
 * días de punta a punta y la siguiente que se pise baja un carril. Es lo que hace que
 * «del martes al viernes» se lea de un vistazo como una sola pieza.
 */
export function repartirEnCarriles<T>(
  items: T[],
  tramo: (t: T) => { col: number; ancho: number },
): { item: T; carril: number }[] {
  const ordenados = [...items].sort(
    (a, b) => tramo(a).col - tramo(b).col || tramo(b).ancho - tramo(a).ancho,
  );
  const carriles: number[] = []; // por carril, la primera columna libre
  return ordenados.map((item) => {
    const { col, ancho } = tramo(item);
    let carril = carriles.findIndex((libreDesde) => libreDesde <= col);
    if (carril === -1) carril = carriles.length;
    carriles[carril] = col + ancho;
    return { item, carril };
  });
}

// ── Color ───────────────────────────────────────────────────────────────────

/**
 * El color del evento, o la marca si no eligió ninguno.
 *
 * Se devuelve como `var()` y no como literal para que el evento sin color siga la
 * marca que el usuario haya elegido en Apariencia, en claro y en oscuro.
 */
export const colorDe = (e: Evento) => e.color || "var(--color-brand)";

/**
 * Qué tinta se lee sobre ese fondo.
 *
 * El color lo teclea el usuario en un `<input type="color">`, así que puede ser
 * cualquiera: sobre un amarillo, el blanco no se lee. Se decide por luminancia
 * relativa (la fórmula de la WCAG) en vez de por «claro/oscuro» a ojo. Sin color
 * propio manda `--color-on-brand`, que es el único token que la aplicación garantiza
 * legible sobre la marca — la calcula el selector de marca, blanca o negra según toque.
 */
export function tintaSobre(color: string | null): string {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return "var(--color-on-brand)";
  const canal = (i: number) => {
    const v = parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luz = 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
  // 0.198 es el punto en que las dos tintas contrastan IGUAL contra ese fondo, y sale
  // de despejar la fórmula de la WCAG con la tinta oscura REAL de la aplicación
  // (#0d1526, luminancia 0,0084 — no el negro puro, que daría 0,179 y mandaría el
  // índigo #6366f1 al lado equivocado). Por encima del corte gana la oscura.
  //
  // Elegirlo a ojo cuesta caro justo en los colores que más se usan: con el umbral en
  // 0,45 un ámbar #f59e0b se llevaba texto blanco, que sobre él queda en 2,2:1 —
  // ilegible, y es el color con el que la gente marca lo urgente.
  return luz > 0.198 ? "#0d1526" : "#ffffff";
}

// ── La ventana que se le pide al backend ────────────────────────────────────

/**
 * El rango de días a cargar para unos días visibles, con un día de margen a cada lado.
 *
 * El margen no es por si acaso: la rejilla se dibuja en hora del navegador y el
 * backend recorta por días de Colombia (ver la cabecera). Con las zonas alineadas
 * —el caso real— el margen sólo trae eventos que no se pintan; con una zona distinta,
 * es lo que impide que se pierda el primero y el último día de la vista.
 */
export function ventanaDe(dias: Date[]): { from: string; to: string } {
  return { from: diaISO(sumarDias(dias[0], -1)), to: diaISO(sumarDias(dias[dias.length - 1], 1)) };
}
