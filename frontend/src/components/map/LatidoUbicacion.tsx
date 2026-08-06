"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/context/AuthProvider";
import { esTecnicoDeCampo } from "@/lib/auth";
import { pedirUbicacion } from "@/lib/geo";

/**
 * Latido de ubicación del técnico.
 *
 * Mientras un técnico tiene la app abierta, su teléfono reporta dónde está una
 * vez por minuto. Es lo que hace que la capa "Técnicos" del mapa enseñe algo:
 * antes de esto, `GeoPing` solo se escribía cuando el técnico cerraba una orden,
 * subía evidencia o capturaba el GPS de un cliente, así que un técnico que no
 * hubiera tocado nada en el día no aparecía en ninguna parte.
 *
 * **El límite, para que quede escrito y nadie lo prometa de más:** esto NO es un
 * rastreador. Un navegador solo puede dar la ubicación con la página viva y en
 * primer plano. Si el técnico cierra el navegador, bloquea el teléfono o se
 * queda sin datos, deja de reportar — y no hay API web que lo evite. Lo que se
 * ve en el mapa es "dónde estaba la última vez que se supo de él", con la hora
 * al lado, nunca "dónde está ahora mismo" garantizado.
 *
 * Tres decisiones que evitan que esto se vuelva molesto o caro:
 *
 *  · **Se para con la pantalla apagada o la pestaña de fondo.** No tendría
 *    sentido pedir GPS cada minuto a un teléfono en el bolsillo: el navegador
 *    congela los temporizadores de todas formas y solo se gastaría batería. Al
 *    volver a primer plano se manda uno enseguida, que es justo cuando el dato
 *    vale (el técnico acaba de sacar el teléfono).
 *  · **Un fallo no se reintenta en bucle.** Dentro de una casa el GPS falla y no
 *    pasa nada: se pierde ese latido y se espera al siguiente. Insistir solo
 *    calienta el teléfono.
 *  · **Nunca bloquea ni avisa.** Si no hay señal o el permiso se revoca a mitad
 *    de la jornada, el técnico sigue trabajando sin un solo mensaje de error.
 *    Quien tiene que enterarse de que dejó de reportar es el jefe, mirando el
 *    "hace X" del mapa, no el técnico con un aviso que no puede resolver.
 */

/** Cada cuánto reporta. Ver `LATIDO_MINIMO_MS` en el backend, que descarta los repetidos. */
const CADA_MS = 60_000;

/**
 * Se acepta un punto de hasta 45 s de antigüedad en vez de exigir uno recién
 * medido. A un latido por minuto, forzar el GPS cada vez —que es lo que hace
 * `maximumAge: 0`— es la diferencia entre un teléfono que aguanta la jornada y
 * uno que no; y 45 s de desfase no cambian nada en un mapa que se mira para
 * saber por qué barrio anda alguien. Los otros usos de `pedirUbicacion` (fijar
 * la casa de un abonado, cerrar una orden dentro de la geo-cerca) siguen
 * exigiendo medida fresca: ahí el metro sí importa.
 */
const EDAD_ACEPTABLE_MS = 45_000;

export function LatidoUbicacion() {
  const { user, loading, authFetch } = useAuth();
  const activo = !loading && esTecnicoDeCampo(user);

  // Evita que dos latidos se solapen cuando el GPS tarda más que el intervalo
  // (dentro de un edificio, `pedirUbicacion` puede consumir sus 15 s enteros).
  const enVuelo = useRef(false);

  const latir = useCallback(async () => {
    if (enVuelo.current || document.visibilityState !== "visible") return;
    enVuelo.current = true;
    try {
      const r = await pedirUbicacion(15000, EDAD_ACEPTABLE_MS);
      if (!r.ok) return; // Sin señal o sin permiso: se calla y espera al siguiente.
      await authFetch("/geo/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: r.lat,
          lng: r.lng,
          accuracy: r.accuracy,
          reason: "heartbeat",
        }),
      });
    } catch {
      // Reportar la posición jamás puede estropearle la pantalla al técnico.
    } finally {
      enVuelo.current = false;
    }
  }, [authFetch]);

  useEffect(() => {
    if (!activo) return;

    void latir();
    const id = setInterval(() => void latir(), CADA_MS);

    // Volver a primer plano: el intervalo viene de estar congelado y el último
    // punto puede ser de hace rato.
    const alVolver = () => {
      if (document.visibilityState === "visible") void latir();
    };
    document.addEventListener("visibilitychange", alVolver);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [activo, latir]);

  return null;
}
