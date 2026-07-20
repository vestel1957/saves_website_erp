"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthProvider";

/**
 * Carga de datos con CANCELACIÓN y estado de error.
 *
 * El problema que resuelve: en todo el frontend no había ni un `AbortController`.
 * Los listados con filtros hacen debounce del *timer*, pero nunca cancelan la
 * petición en vuelo, así que con la red lenta una respuesta vieja puede llegar
 * DESPUÉS de una nueva y sobrescribir la tabla con resultados que ya no
 * corresponden a lo que el usuario ve escrito en el filtro. Es de los fallos que
 * el usuario reporta como "a veces me salen datos raros" y nunca se reproducen.
 *
 * Además distingue tres estados que antes se confundían: cargando, error y vacío.
 * Varias pantallas hacían `try/finally` sin `catch`, así que un fallo de red
 * apagaba el spinner y dejaba la tabla vacía, indistinguible de "no hay datos".
 */
export function useRequest<T>(
  construirRuta: () => string | null,
  deps: unknown[],
  opciones: { debounceMs?: number; saltar?: boolean } = {},
) {
  const { authFetch } = useAuth();
  const { debounceMs = 0, saltar = false } = opciones;

  const [data, setData] = useState<T | null>(null);
  const [cargando, setCargando] = useState(!saltar);
  const [error, setError] = useState<string | null>(null);

  // La ruta se recalcula en cada render; se guarda en una ref para no meterla en
  // las dependencias del efecto (sería una función nueva cada vez y recargaría en bucle).
  const rutaRef = useRef(construirRuta);
  rutaRef.current = construirRuta;

  const [recarga, setRecarga] = useState(0);
  const refrescar = useCallback(() => setRecarga((n) => n + 1), []);

  useEffect(() => {
    if (saltar) return;
    const ruta = rutaRef.current();
    if (!ruta) return;

    const ctrl = new AbortController();
    const temporizador = setTimeout(async () => {
      setCargando(true);
      setError(null);
      try {
        const res = await authFetch(ruta, { signal: ctrl.signal });
        if (!res.ok) {
          // Un 500 dejaba la tabla vacía como si no hubiera datos.
          const cuerpo = await res.json().catch(() => null);
          throw new Error(cuerpo?.message ?? `Error ${res.status}`);
        }
        setData((await res.json()) as T);
      } catch (e) {
        // Abortar es lo normal al teclear en un filtro: no es un error que mostrar.
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "No se pudieron cargar los datos");
      } finally {
        if (!ctrl.signal.aborted) setCargando(false);
      }
    }, debounceMs);

    return () => {
      clearTimeout(temporizador);
      // Esto es lo que evita que una respuesta vieja pise a una nueva.
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch, debounceMs, saltar, recarga, ...deps]);

  return { data, cargando, error, refrescar };
}
