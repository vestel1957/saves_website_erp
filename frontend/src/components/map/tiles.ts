/**
 * Capa base del mapa, aislada en un solo módulo.
 *
 * Hoy se dibuja sobre OpenStreetMap: gratis, sin cuenta y sin tarjeta. Google
 * Maps NO se puede usar como capa de teselas suelta (su licencia solo permite
 * consumirlas a través de su propia API de JavaScript), así que "cambiar a
 * Google" no es cambiar una URL: es montar su SDK. Lo que sí queda garantizado
 * al tener esto aparte es que ese cambio toca este archivo y el componente
 * `Mapa`, y ninguna de las pantallas que lo usan.
 *
 * Si algún día hace falta imagen satélite sin cuenta de Google, Esri World
 * Imagery ya está aquí abajo y funciona igual.
 */

export type CapaBase = {
  id: string;
  label: string;
  url: string;
  attribution: string;
  maxZoom: number;
  /** Alguna capa (satélite) pide etiquetas de calles encima para ser legible. */
  overlayUrl?: string;
};

export const CAPAS: CapaBase[] = [
  {
    id: "calles",
    label: "Calles",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
  {
    id: "satelite",
    label: "Satélite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
    overlayUrl:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  },
];

export const CAPA_POR_DEFECTO = CAPAS[0];
