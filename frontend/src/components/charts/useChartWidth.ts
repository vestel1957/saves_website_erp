"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Mide el ancho real del contenedor para poder dibujar el SVG 1:1.
 *
 * Antes los gráficos usaban un `viewBox` fijo de 660px estirado con `w-full`:
 * en una pantalla ancha el navegador escalaba TODO el dibujo (×2,4 en un
 * monitor de 1080p), así que las cifras de los ejes salían a 24px y una gráfica
 * de 210px de alto ocupaba media pantalla. Midiendo el ancho, el viewBox es el
 * ancho real y un `fontSize={11}` son 11px de verdad, tenga el tamaño que tenga
 * la tarjeta.
 */
export function useChartWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => setWidth(Math.round(el.getBoundingClientRect().width));
    medir();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", medir);
      return () => window.removeEventListener("resize", medir);
    }
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
