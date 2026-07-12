/**
 * Color primario elegible por el usuario.
 *
 * Solo tocamos dos variables CSS en <html>:
 *   --color-brand      → el color elegido
 *   --color-on-brand   → blanco u oscuro, el que dé más contraste sobre la marca
 *
 * Todo lo demás (brand-hover, brand-soft, sidebar-active, ring…) se deriva en
 * globals.css con color-mix(), así que no hace falta escribir esos tonos aquí.
 * La preferencia se guarda por usuario en localStorage; el script anti-FOUC de
 * layout.tsx la aplica antes de pintar para evitar el parpadeo.
 */

export const BRAND_STORAGE_KEY = "brandColor";
export const DEFAULT_BRAND = "#0e7490";

/** Presets accesibles (todos pasan AA con su texto autoseleccionado). */
export const BRAND_PRESETS: { hex: string; name: string }[] = [
  { hex: "#0e7490", name: "Teal (por defecto)" },
  { hex: "#2563c9", name: "Azul" },
  { hex: "#7c3aed", name: "Violeta" },
  { hex: "#0f9d6b", name: "Verde" },
  { hex: "#c2410c", name: "Naranja" },
  { hex: "#be185d", name: "Magenta" },
  { hex: "#b45309", name: "Ámbar" },
  { hex: "#475569", name: "Grafito" },
];

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

export function isValidHex(hex: string): boolean {
  return HEX6.test(hex.trim());
}

/** Normaliza a "#rrggbb" en minúsculas. */
export function normalizeHex(hex: string): string {
  return "#" + hex.trim().replace(/^#/, "").toLowerCase();
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Luminancia relativa WCAG. */
function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Razón de contraste entre dos colores (1..21). */
export function contrastRatio(a: string, b: string): number {
  const L1 = relLuminance(toRgb(a));
  const L2 = relLuminance(toRgb(b));
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

/** Devuelve el color de texto (blanco u oscuro) con mejor contraste sobre `brand`. */
export function onBrandColor(brandHex: string): string {
  const white = "#ffffff";
  const dark = "#0d1526";
  return contrastRatio(brandHex, white) >= contrastRatio(brandHex, dark)
    ? white
    : dark;
}

/** Aplica el color a <html> y (opcionalmente) lo persiste. */
export function applyBrandColor(hex: string, persist = true): void {
  if (!isValidHex(hex)) return;
  const brand = normalizeHex(hex);
  const root = document.documentElement;
  root.style.setProperty("--color-brand", brand);
  root.style.setProperty("--color-on-brand", onBrandColor(brand));
  if (persist) {
    try {
      localStorage.setItem(BRAND_STORAGE_KEY, brand);
    } catch {
      /* modo privado / storage bloqueado: se ignora */
    }
  }
}

/** Color guardado, o el default si no hay ninguno válido. */
export function readStoredBrand(): string {
  try {
    const v = localStorage.getItem(BRAND_STORAGE_KEY);
    if (v && isValidHex(v)) return normalizeHex(v);
  } catch {
    /* ignore */
  }
  return DEFAULT_BRAND;
}
