/**
 * Tinte de fondo elegible por el usuario.
 *
 * Hermano de `@/lib/brand`, pero con una diferencia que lo cambia todo: el color
 * de marca se usa como FONDO DE ACENTO y lleva su propio color de texto encima
 * (`--color-on-brand`), así que puede ser cualquiera. El fondo de la interfaz es
 * el otro lado del par de contraste de TODO el texto de la app: dejar elegir un
 * fondo libre es dejar romper la legibilidad con un clic.
 *
 * Por eso aquí **se elige el TONO, no la luminosidad**:
 *
 *  1. `normalizarTono` conserva el matiz y fuerza saturación ≤ 75 % y
 *     luminosidad al 40–55 %. Un blanco puro o un negro puro entran como grises
 *     medios: dejan de poder aclarar u oscurecer el fondo.
 *  2. Para el modo claro ese tono se aclara al 65 % (queda pastel) y para el
 *     oscuro se oscurece al 50 %. Así el tinte aporta color sin mover la
 *     luminosidad de la superficie, que es lo que hundía el contraste.
 *  3. Sólo entonces se mezcla sobre los neutros de siempre, en la proporción del
 *     nivel elegido.
 *
 * Medido por barrido sobre los 360 matices en los tres niveles: el peor caso
 * queda en 4,56:1 (AA) contra el texto más débil. Si se sube el tope del nivel
 * "fuerte" por encima de 36 %, deja de cumplir — hay que rehacer el barrido.
 *
 * Los 16 colores resultantes (ocho tokens × dos modos) se calculan AQUÍ y se
 * escriben en línea sobre <html>; globals.css sólo los lee con `var(--ui-…,
 * literal)`. Se intentó al revés —dejar el `color-mix()` en el CSS— y no sirve:
 * al compilar, Lightning CSS emite para los navegadores sin `color-mix` un
 * respaldo que tira la mezcla y deja el tono crudo, o sea todas las superficies
 * iguales y los bordes invisibles. Con `var()` + literal el respaldo es el
 * diseño original.
 */

import { contrastRatio, isValidHex, normalizeHex } from "./brand";

export const TINT_STORAGE_KEY = "uiTint";
export const TINT_LEVEL_KEY = "uiTintLevel";
/**
 * Mapa `variable CSS → color` ya calculado, en JSON. Existe para que el script
 * anti-parpadeo de `layout.tsx` sólo tenga que copiarlo a <html> antes de
 * pintar, sin repetir en línea la conversión HSL ni las mezclas. Es CACHÉ, no
 * fuente de verdad: la elección del usuario son `uiTint` + `uiTintLevel`, y de
 * ahí se recalcula todo al guardar.
 */
export const TINT_VARS_KEY = "uiSurfaces";

export type TintLevel = "sutil" | "medio" | "fuerte";

/** Cuánto tiñe cada nivel, en porcentaje de mezcla sobre el neutro base. */
export const TINT_LEVELS: { key: TintLevel; label: string; mix: number }[] = [
  { key: "sutil", label: "Sutil", mix: 12 },
  { key: "medio", label: "Medio", mix: 24 },
  { key: "fuerte", label: "Fuerte", mix: 36 },
];

export const DEFAULT_LEVEL: TintLevel = "medio";

/** Cuánto se aclara el tono para el modo claro / se oscurece para el oscuro. */
const PASTEL_CLARO = 65;
const PROFUNDO_OSCURO = 50;

/** Tonos propuestos. El "sin tinte" no está aquí: es la ausencia de tinte (null). */
export const TINT_PRESETS: { hex: string; name: string }[] = [
  { hex: "#475569", name: "Grafito" },
  { hex: "#2563c9", name: "Azul" },
  { hex: "#0e7490", name: "Teal" },
  { hex: "#0f9d6b", name: "Verde" },
  { hex: "#b45309", name: "Arena" },
  { hex: "#c2410c", name: "Terracota" },
  { hex: "#7c3aed", name: "Violeta" },
  { hex: "#be185d", name: "Rosa" },
];

/**
 * Neutros base de cada modo — los MISMOS literales que globals.css.
 *
 * Están duplicados a sabiendas: se necesitan en JS para previsualizar el
 * resultado y medir el contraste, y no hay forma de leerlos del CSS sin haberlos
 * aplicado antes, que es justo lo que se quiere evitar. Si se tocan allá, hay
 * que tocarlos aquí.
 */
export const NEUTROS = {
  claro: {
    canvas: "#eaeef4",
    surface: "#f8fafc",
    surface2: "#eef2f7",
    sidebar: "#f8fafc",
    "sidebar-hover": "#eaeff5",
    "border-subtle": "#d9e0ea",
    "border-default": "#c3ccd8",
    "border-strong": "#93a0b2",
    textoDebil: "#586576",
  },
  oscuro: {
    canvas: "#080d18",
    surface: "#0f1728",
    surface2: "#18213a",
    sidebar: "#0a1120",
    "sidebar-hover": "#18223a",
    "border-subtle": "#1e293e",
    "border-default": "#2c3a52",
    "border-strong": "#4a5a72",
    textoDebil: "#93a2b8",
  },
} as const;

export type Modo = keyof typeof NEUTROS;

/** Tokens que se tiñen. `textoDebil` NO está: el texto nunca se tiñe. */
const TOKENS = [
  "canvas", "surface", "surface2", "sidebar", "sidebar-hover",
  "border-subtle", "border-default", "border-strong",
] as const;

/** Sufijo de la variable CSS de cada modo (`--ui-canvas-l` / `--ui-canvas-d`). */
const SUFIJO: Record<Modo, string> = { claro: "l", oscuro: "d" };

// ── color ────────────────────────────────────────────────────────────────────

const canal = (hex: string, i: number) =>
  parseInt(hex.replace(/^#/, "").slice(i * 2, i * 2 + 2), 16);

const aHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** Mezcla equivalente a `color-mix(in srgb, tinte pct%, base)`. */
export function mezclar(base: string, tinte: string, pct: number): string {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  return aHex(...([0, 1, 2].map((i) => canal(base, i) * (1 - p) + canal(tinte, i) * p) as [number, number, number]));
}

function aHsl(hex: string): [number, number, number] {
  const [r, g, b] = [0, 1, 2].map((i) => canal(hex, i) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  return [h, s, l];
}

function deHsl(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return aHex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
}

/** Conserva el matiz y acota saturación y luminosidad a la banda segura. */
export function normalizarTono(hex: string): string {
  const [h, s, l] = aHsl(normalizeHex(hex));
  return deHsl(h, Math.min(s, 0.75), Math.max(0.4, Math.min(0.55, l)));
}

/** Tono ya listo para mezclar en el modo indicado (pastel en claro, profundo en oscuro). */
export function tintePara(modo: Modo, hex: string): string {
  const base = normalizarTono(hex);
  return modo === "claro"
    ? mezclar(base, "#ffffff", PASTEL_CLARO)
    : mezclar(base, "#000000", PROFUNDO_OSCURO);
}

export const mixDe = (level: TintLevel): number =>
  TINT_LEVELS.find((l) => l.key === level)?.mix ?? 24;

// ── aplicación y medida ──────────────────────────────────────────────────────

/** Superficie resultante en un modo, para previsualizar y medir. */
export function superficieCon(
  modo: Modo,
  tinte: string | null,
  level: TintLevel,
  clave: (typeof TOKENS)[number] = "canvas",
): string {
  const base = NEUTROS[modo][clave];
  return tinte ? mezclar(base, tintePara(modo, tinte), mixDe(level)) : base;
}

/** Los 16 valores (8 tokens × 2 modos) listos para escribir en <html>. */
export function variablesDe(tinte: string, level: TintLevel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const modo of ["claro", "oscuro"] as const) {
    for (const t of TOKENS) out[`--ui-${t}-${SUFIJO[modo]}`] = superficieCon(modo, tinte, level, t);
  }
  return out;
}

/**
 * Contraste del texto más débil sobre las tarjetas resultantes, en el modo
 * indicado. Es el número que decide si una combinación es usable: los demás
 * textos (primary/secondary) tienen más contraste que éste por construcción.
 */
export function contrasteTexto(modo: Modo, tinte: string | null, level: TintLevel): number {
  return contrastRatio(NEUTROS[modo].textoDebil, superficieCon(modo, tinte, level, "surface"));
}

/** El peor de los dos modos: una elección sólo es buena si lo es en ambos. */
export function peorContraste(tinte: string | null, level: TintLevel): number {
  return Math.min(contrasteTexto("claro", tinte, level), contrasteTexto("oscuro", tinte, level));
}

/** Aplica el tinte a <html> y (opcionalmente) lo persiste. `null` = sin tinte. */
export function applyTint(tinte: string | null, level: TintLevel, persist = true): void {
  const root = document.documentElement;

  if (tinte && isValidHex(tinte)) {
    const hex = normalizeHex(tinte);
    const vars = variablesDe(hex, level);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    if (persist) {
      try {
        localStorage.setItem(TINT_STORAGE_KEY, hex);
        localStorage.setItem(TINT_LEVEL_KEY, level);
        localStorage.setItem(TINT_VARS_KEY, JSON.stringify(vars));
      } catch {
        /* modo privado / storage bloqueado: se ignora */
      }
    }
    return;
  }

  // Sin tinte: se QUITAN las declaraciones en línea para que cada `var()` caiga
  // en su literal, que es el color de siempre. Dejarlas puestas con el valor
  // neutro funcionaría igual, pero llena el atributo style de ruido al depurar.
  for (const modo of ["claro", "oscuro"] as const) {
    for (const t of TOKENS) root.style.removeProperty(`--ui-${t}-${SUFIJO[modo]}`);
  }
  if (persist) {
    try {
      for (const k of [TINT_STORAGE_KEY, TINT_LEVEL_KEY, TINT_VARS_KEY]) localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

/** Tinte guardado, o "sin tinte" si no hay ninguno válido. */
export function readStoredTint(): { tinte: string | null; level: TintLevel } {
  try {
    const v = localStorage.getItem(TINT_STORAGE_KEY);
    const l = localStorage.getItem(TINT_LEVEL_KEY) as TintLevel | null;
    const level = TINT_LEVELS.some((x) => x.key === l) ? (l as TintLevel) : DEFAULT_LEVEL;
    if (v && isValidHex(v)) return { tinte: normalizeHex(v), level };
  } catch {
    /* ignore */
  }
  return { tinte: null, level: DEFAULT_LEVEL };
}
