/**
 * Utilidades de geolocalización del navegador.
 *
 * Estaban copiadas dentro de `/soporte/[id]/page.tsx`; al aparecer el mapa y el
 * botón de capturar GPS en la ficha del cliente pasaban a estar en tres sitios.
 */

export type Punto = { lat: number; lng: number };

/** Resultado de pedir la ubicación: o sale bien, o hay que decir POR QUÉ no. */
export type ResultadoGeo =
  | { ok: true; lat: number; lng: number; accuracy: number }
  | { ok: false; motivo: "sin-soporte" | "inseguro" | "denegado" | "no-disponible" | "timeout" };

/** Mensaje para el usuario. El fallo más común no es técnico: es que dijo que no. */
export const MOTIVO_GEO: Record<Exclude<ResultadoGeo, { ok: true }>["motivo"], string> = {
  "sin-soporte": "Este navegador no puede dar la ubicación.",
  // Los navegadores bloquean la geolocalización fuera de HTTPS y no lo explican:
  // el callback de error llega igual que un permiso denegado. Detectarlo antes de
  // pedirla evita que el técnico crea que el sistema falla.
  inseguro: "La ubicación requiere HTTPS. Entra por el dominio seguro, no por la IP.",
  denegado: "Permiso de ubicación denegado. Actívalo en los ajustes del navegador.",
  "no-disponible": "El dispositivo no pudo obtener la ubicación. Revisa que el GPS esté activo.",
  timeout: "El GPS tardó demasiado. Sal al exterior e inténtalo de nuevo.",
};

/** ¿El navegador va a permitir siquiera pedir la ubicación? */
export function geoDisponible(): boolean {
  if (typeof window === "undefined" || !navigator.geolocation) return false;
  return window.isSecureContext;
}

/**
 * Pide la ubicación del dispositivo.
 *
 * `enableHighAccuracy` fuerza el GPS en vez de triangular por wifi/antenas: es
 * más lento y gasta más batería, pero un punto de ±2 km no sirve para decir
 * dónde vive un abonado, que es justo para lo que se usa esto.
 */
export function pedirUbicacion(timeoutMs = 15000): Promise<ResultadoGeo> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      return resolve({ ok: false, motivo: "sin-soporte" });
    }
    if (!window.isSecureContext) return resolve({ ok: false, motivo: "inseguro" });

    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          ok: true,
          lat: Number(p.coords.latitude.toFixed(6)),
          lng: Number(p.coords.longitude.toFixed(6)),
          accuracy: Math.round(p.coords.accuracy),
        }),
      (err) =>
        resolve({
          ok: false,
          motivo:
            err.code === err.PERMISSION_DENIED
              ? "denegado"
              : err.code === err.TIMEOUT
                ? "timeout"
                : "no-disponible",
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/** Distancia aproximada en metros entre dos coordenadas (haversine). */
export function distMetros(a: Punto, b: Punto): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

/** "120 m" / "3,4 km" */
export function formatearDistancia(m: number): string {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}

/**
 * Una precisión peor que esto significa que el punto NO viene del GPS sino de la
 * red: sirve para situar la ciudad, no la casa. Se avisa antes de guardarlo como
 * la coordenada de un abonado.
 */
export const PRECISION_DUDOSA_M = 50;

/** Coordenadas de las sedes, para centrar el mapa cuando aún no hay puntos. */
export const CENTRO_POR_DEFECTO: Punto = { lat: 5.3378, lng: -72.3959 }; // Yopal, Casanare
