"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Filtros de un listado guardados EN LA URL.
 *
 * El problema que resuelve: los filtros vivían solo en `useState`, así que al
 * abrir un registro y volver atrás la pantalla arrancaba de cero — buscador
 * vacío, estado "todos", página 1 — y había que volver a armar el filtro. Con
 * los filtros en la dirección, volver atrás los devuelve tal cual, se puede
 * recargar sin perderlos, abrir la lista filtrada en otra pestaña y pasarle el
 * enlace a un compañero.
 *
 * Se escribe con `history.replaceState` y NO con `router.replace` a propósito:
 * `replaceState` no dispara una navegación de Next (nada de re-render ni de ida
 * al servidor por cada tecla del buscador) y, al reemplazar la entrada en vez de
 * apilarla, el botón "atrás" sigue llevando a la pantalla anterior y no
 * deshaciendo filtro por filtro.
 *
 * Uso:
 *
 *   const inicial = useFiltrosRecordados();
 *   if (!inicial) return <PageSkeleton />;
 *   // …y dentro, con `inicial.valores`:
 *   const [search, setSearch] = useState(valores.q ?? "");
 *   useFiltrosEnUrl({ q: search, estado: status, pag: page > 1 ? String(page) : "" });
 *
 * Los valores vacíos no se escriben: la URL solo lleva lo que de verdad está
 * filtrando.
 */

/** Igual, pero leyendo de `window` (sin Suspense): solo para código fuera de React. */
export function filtrosDeUrl(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/** Igual que `filtrosDeUrl` pero para un solo parámetro, con su valor por defecto. */
export function filtroDeUrl(clave: string, porDefecto = ""): string {
  if (typeof window === "undefined") return porDefecto;
  return new URLSearchParams(window.location.search).get(clave) ?? porDefecto;
}

/**
 * Dónde se guardan los filtros de cada pantalla para la PRÓXIMA visita.
 *
 * Es `localStorage` y no `sessionStorage` a propósito: la sesión del navegador
 * muere al cerrar la pestaña, así que quien filtraba su listado por la mañana lo
 * encontraba en blanco por la tarde.
 *
 * Y van CON EL DUEÑO en la clave (`filtros:<usuario>:<ruta>`) porque el navegador
 * es de la ventanilla y la sesión es de la persona: la cajera y el jefe se turnan
 * el mismo equipo y ninguno tiene por qué encontrarse la lista filtrada por el
 * otro. Sin dueño puesto (pantalla de login, o justo al cerrar sesión) no se lee
 * ni se escribe nada — eso último es lo que impide que el último repintado de un
 * listado, al salir, vuelva a dejar escritos los filtros del que se acaba de ir.
 */
let dueno: string | null = null;

/** Quién está mirando. Lo fija `AuthProvider`; `null` mientras no haya sesión. */
export function fijarDuenoDeFiltros(id: string | null) {
  if (dueno === id) return;
  dueno = id;
  // Limpieza del formato anterior (sin dueño), que sí era heredable.
  try {
    const viejas: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith("filtros:/")) viejas.push(k);
    }
    for (const k of viejas) window.localStorage.removeItem(k);
  } catch { /* modo privado */ }
}

const CLAVE = (ruta: string) => `filtros:${dueno}:${ruta}`;

function guardar(ruta: string, busqueda: string) {
  if (!dueno) return;
  try { window.localStorage.setItem(CLAVE(ruta), busqueda); } catch { /* modo privado */ }
}

function guardado(ruta: string): string {
  if (!dueno) return "";
  try { return window.localStorage.getItem(CLAVE(ruta)) ?? ""; } catch { return ""; }
}

export function useFiltrosEnUrl(valores: Record<string, string | number | boolean | null | undefined>) {
  // Sin lista de dependencias: `valores` es un objeto nuevo en cada render y
  // compararlo entero saldría más caro que lo que hace el efecto, que es armar
  // una cadena y compararla con la que ya está puesta.
  useEffect(() => {
    const qs = new URLSearchParams();
    for (const [clave, valor] of Object.entries(valores)) {
      const v = valor === null || valor === undefined || valor === false ? "" : String(valor);
      if (v) qs.set(clave, v);
    }
    const busqueda = qs.toString();
    // Se recuerda para el botón "Volver" de la ficha: el enlace de vuelta lleva
    // al listado TAL COMO ESTABA, no al listado en blanco. Ver `volverA`.
    guardar(window.location.pathname, busqueda);
    if (busqueda === window.location.search.replace(/^\?/, "")) return;
    window.history.replaceState(null, "", busqueda ? `${window.location.pathname}?${busqueda}` : window.location.pathname);
  });
}

/**
 * Dirección de vuelta a un listado, con los filtros que tenía puestos la última
 * vez en esta pestaña. Si no hay nada guardado devuelve la ruta pelada.
 */
export function volverA(ruta: string): string {
  if (typeof window === "undefined") return ruta;
  const busqueda = guardado(ruta);
  return busqueda ? `${ruta}?${busqueda}` : ruta;
}

/**
 * Los filtros con los que ARRANCA un listado, mirando primero la URL y, si viene
 * pelada, los que quedaron de la última visita.
 *
 * Por qué en dos tiempos (devuelve `null` en el primer render): lo recordado vive
 * en el navegador y el servidor no lo conoce, así que leerlo al construir el
 * estado haría que el HTML del servidor y el del cliente no coincidieran. Se
 * espera a estar montado y la pantalla enseña su esqueleto mientras tanto —que es
 * lo que ya hacía mientras cargaba la primera página de datos.
 *
 * La PÁGINA no se recuerda: se vuelve con los mismos filtros y el mismo orden,
 * pero por el principio. Volver a la página 7 de una lista que entretanto cambió
 * no es continuar donde uno estaba, es caer en cualquier parte.
 */
export function useFiltrosRecordados(): { valores: Record<string, string>; recordado: boolean } | null {
  // `useSearchParams` y no `window.location`: al llegar por un enlace de dentro
  // (el "Volver" de una ficha), Next renderiza la pantalla ANTES de cambiar la
  // barra de direcciones, así que leer de `window` en ese momento devuelve la
  // dirección vieja — y los filtros del enlace se perdían justo al volver.
  // Exige una frontera de Suspense en la pantalla que lo use.
  const sp = useSearchParams();
  const [inicial, setInicial] = useState<{ valores: Record<string, string>; recordado: boolean } | null>(null);
  useEffect(() => {
    const enUrl = Object.fromEntries(sp.entries());
    if (Object.keys(enUrl).length) return setInicial({ valores: enUrl, recordado: false });
    const previos = new URLSearchParams(guardado(window.location.pathname));
    previos.delete("pag");
    const valores = Object.fromEntries(previos.entries());
    setInicial({ valores, recordado: Object.keys(valores).length > 0 });
    // Solo al montar: si el usuario borra un filtro no hay que "recordárselo" otra vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return inicial;
}

/** Orden de tabla (`useOrden`) escrito como `"creado:desc"` → `{by, dir}`. */
export function ordenDeTexto(crudo?: string): { by: string; dir: "asc" | "desc" } | undefined {
  if (!crudo || !crudo.includes(":")) return undefined;
  const [by, dir] = crudo.split(":");
  if (!by) return undefined;
  return { by, dir: dir === "desc" ? "desc" : "asc" };
}

/** El orden que venga en la URL (fuera de React; dentro, usa `useFiltrosIniciales`). */
export function ordenDeUrl(clave = "ord") {
  return ordenDeTexto(filtroDeUrl(clave));
}
