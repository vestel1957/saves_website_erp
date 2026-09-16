"use client";

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { CAPAS, CAPA_POR_DEFECTO } from "./tiles";
import { CENTRO_POR_DEFECTO } from "@/lib/geo";

export type TipoPunto = "abonado" | "nap" | "tecnico" | "yo";

export type PuntoMapa = {
  id: string;
  tipo: TipoPunto;
  lat: number;
  lng: number;
  titulo: string;
  /** Líneas "etiqueta: valor" del globo. */
  detalles?: { label: string; valor: string | null | undefined }[];
  /** Colorea el pin (estado del abonado). */
  color?: string;
  /** Enlace del botón "Abrir ficha" del globo. */
  href?: string;
  /** Círculo de incertidumbre en metros (precisión del GPS). */
  radioM?: number;
  /** Ofrece "Cómo llegar" en el globo (requiere `onComoLlegar`). */
  rutaHasta?: boolean;
};

/** Color por estado del abonado. El mapa se lee de un vistazo o no sirve. */
export const COLOR_ESTADO: Record<string, string> = {
  ACTIVO: "#10b981",
  CARTERA: "#f2ae2e",
  COMPROMISO: "#f28d35",
  CORTADO: "#bf303c",
  SUSPENDIDO: "#bf303c",
  REPORTADO: "#94252f",
  INSTALAR: "#0ea5e9",
  POR_RETIRAR: "#8b5cf6",
  RETIRADO: "#94a3b8",
  DEPURADO: "#94a3b8",
  EXONERADO: "#64748b",
  EVENTO: "#64748b",
};
const COLOR_NAP = "#0e7490";
const COLOR_TECNICO = "#7c3aed";
const COLOR_YO = "#0ea5e9";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function popupHtml(p: PuntoMapa): string {
  const filas = (p.detalles ?? [])
    .filter((d) => d.valor != null && String(d.valor).trim() !== "")
    .map(
      (d) =>
        `<div style="display:flex;gap:6px;font-size:12px;line-height:1.5"><span style="font-weight:600;color:#45525f">${esc(d.label)}:</span><span style="color:#0d1526">${esc(d.valor)}</span></div>`,
    )
    .join("");
  const boton = p.href
    ? `<a href="${esc(p.href)}" data-mapa-href="${esc(p.href)}" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:600;color:${esc(p.color ?? COLOR_NAP)};text-decoration:none">Abrir ficha →</a>`
    : "";
  // "Cómo llegar" traza la ruta DENTRO del mapa; ya no lanza una pestaña de
  // Google Maps. Se marca con data-* y lo recoge el manejador de `popupopen`.
  const comoLlegar = p.rutaHasta
    ? `<a href="#" data-mapa-ruta="${p.lat},${p.lng}" style="display:inline-block;margin-top:8px;margin-left:12px;font-size:12px;font-weight:600;color:#586576;text-decoration:none">Cómo llegar</a>`
    : "";
  return `<div style="min-width:170px"><div style="font-weight:700;font-size:13px;color:#0d1526;margin-bottom:4px">${esc(p.titulo)}</div>${filas}${boton}${comoLlegar}</div>`;
}

/**
 * Mapa sobre Leaflet, usado directamente (sin `react-leaflet`).
 *
 * Es deliberado: react-leaflet obliga a que cada marcador sea un componente de
 * React, y con ~2.000 abonados eso son 2.000 nodos reconciliándose en cada
 * cambio de filtro. Aquí los pines se pintan en un `<canvas>` (`L.canvas()`),
 * que dibuja miles de puntos sin coste por nodo. Además evita el clásico
 * problema de versiones entre react-leaflet y React 19.
 *
 * El componente NO puede renderizarse en el servidor (Leaflet toca `window`);
 * se importa siempre con `dynamic(..., { ssr: false })`.
 */
export function Mapa({
  puntos,
  ruta,
  rutaAproximada = false,
  centro,
  zoom = 13,
  alto = "100%",
  ajustarA = true,
  onAbrir,
  onComoLlegar,
}: {
  puntos: PuntoMapa[];
  /** Línea del trayecto a dibujar (origen → destino). */
  ruta?: { lat: number; lng: number }[] | null;
  /** La ruta es la línea recta, no el camino real: se dibuja punteada. */
  rutaAproximada?: boolean;
  centro?: { lat: number; lng: number };
  zoom?: number;
  alto?: string;
  /** Encuadra el mapa para que quepan todos los puntos (solo al cambiar el conjunto). */
  ajustarA?: boolean;
  /** Navegación interna al pulsar "Abrir ficha" (evita recargar la SPA entera). */
  onAbrir?: (href: string) => void;
  /** Pulsación de "Cómo llegar" en un globo. */
  onComoLlegar?: (destino: { lat: number; lng: number }) => void;
}) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const capaRef = useRef<L.LayerGroup | null>(null);
  const rendererRef = useRef<L.Renderer | null>(null);
  // El manejador se guarda en una ref para que el mapa (creado una sola vez) use
  // siempre el último sin tener que recrearse cuando la página lo redefine.
  const onAbrirRef = useRef(onAbrir);
  const onComoLlegarRef = useRef(onComoLlegar);
  useEffect(() => {
    onAbrirRef.current = onAbrir;
    onComoLlegarRef.current = onComoLlegar;
  });

  // Firma del conjunto: decide si hay que reencuadrar. Sin esto, el mapa vuelve
  // al encuadre general cada vez que el usuario lo ha movido a mano.
  const firma = useMemo(
    () =>
      puntos.map((p) => `${p.id}:${p.lat}:${p.lng}`).join("|") +
      "#" +
      (ruta ? `${ruta.length}:${ruta[0]?.lat},${ruta[0]?.lng}>${ruta[ruta.length - 1]?.lat},${ruta[ruta.length - 1]?.lng}` : ""),
    [puntos, ruta],
  );

  // --- Creación del mapa (una sola vez) ---
  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, {
      center: [centro?.lat ?? CENTRO_POR_DEFECTO.lat, centro?.lng ?? CENTRO_POR_DEFECTO.lng],
      zoom,
      zoomControl: true,
      // El scroll del ratón sobre el mapa secuestra el scroll de la página; con
      // Ctrl pulsado sigue funcionando y se avisa por pantalla.
      scrollWheelZoom: false,
    });

    const bases: Record<string, L.Layer> = {};
    CAPAS.forEach((c) => {
      const capa = c.overlayUrl
        ? L.layerGroup([
            L.tileLayer(c.url, { attribution: c.attribution, maxZoom: c.maxZoom }),
            L.tileLayer(c.overlayUrl, { maxZoom: c.maxZoom }),
          ])
        : L.tileLayer(c.url, { attribution: c.attribution, maxZoom: c.maxZoom });
      bases[c.label] = capa;
      if (c.id === CAPA_POR_DEFECTO.id) capa.addTo(map);
    });
    L.control.layers(bases, undefined, { position: "topright" }).addTo(map);

    rendererRef.current = L.canvas({ padding: 0.5 });
    capaRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Los globos son HTML plano (los pinta Leaflet, no React): la navegación
    // interna se engancha por delegación al abrirse el globo.
    map.on("popupopen", (e: L.PopupEvent) => {
      const raiz = e.popup.getElement() as HTMLElement | undefined;

      const ficha = raiz?.querySelector<HTMLAnchorElement>("[data-mapa-href]");
      ficha?.addEventListener("click", (ev) => {
        const href = ficha.getAttribute("data-mapa-href");
        if (href && onAbrirRef.current) {
          ev.preventDefault();
          onAbrirRef.current(href);
        }
      });

      const llegar = raiz?.querySelector<HTMLAnchorElement>("[data-mapa-ruta]");
      llegar?.addEventListener("click", (ev) => {
        ev.preventDefault();
        const [lat, lng] = (llegar.getAttribute("data-mapa-ruta") ?? "").split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          onComoLlegarRef.current?.({ lat, lng });
        }
      });
    });

    // El zoom con rueda arranca desactivado para que al bajar por la página el
    // puntero no caiga sobre el mapa y se lo trague. Con Ctrl pulsado se activa,
    // que es el gesto que ya usan Google Maps y Mapbox embebidos.
    const conCtrl = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") map.scrollWheelZoom.enable();
    };
    const sinCtrl = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") map.scrollWheelZoom.disable();
    };
    // Al cambiar de pestaña con Ctrl pulsado nunca llega el `keyup` y el mapa se
    // queda capturando la rueda para siempre.
    const alSalir = () => map.scrollWheelZoom.disable();
    window.addEventListener("keydown", conCtrl);
    window.addEventListener("keyup", sinCtrl);
    window.addEventListener("blur", alSalir);

    // Leaflet mide el contenedor al crearse; si el panel aún estaba plegado o
    // animándose, el mapa nace con 0px y aparece gris hasta que se toca.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(divRef.current);

    return () => {
      window.removeEventListener("keydown", conCtrl);
      window.removeEventListener("keyup", sinCtrl);
      window.removeEventListener("blur", alSalir);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      capaRef.current = null;
    };
    // Solo al montar: el centro/zoom iniciales no deben recrear el mapa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Pintado de los puntos ---
  useEffect(() => {
    const map = mapRef.current;
    const capa = capaRef.current;
    if (!map || !capa) return;
    capa.clearLayers();

    if (ruta && ruta.length > 1) {
      const linea = ruta.map((p) => [p.lat, p.lng] as [number, number]);
      // Trazo doble: uno grueso claro debajo y el de color encima. Sobre el mapa
      // de calles una línea suelta se confunde con las propias vías.
      L.polyline(linea, { color: "#ffffff", weight: 9, opacity: 0.9 }).addTo(capa);
      L.polyline(linea, {
        color: "#0e7490",
        weight: 5,
        opacity: 0.95,
        // Punteada = "esto no es el camino real, es la línea recta". Enseñar una
        // recta como si fuera la ruta haría calcular mal el tiempo de llegada.
        dashArray: rutaAproximada ? "1 10" : undefined,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(capa);
    }

    for (const p of puntos) {
      const color =
        p.color ??
        (p.tipo === "nap" ? COLOR_NAP : p.tipo === "tecnico" ? COLOR_TECNICO : p.tipo === "yo" ? COLOR_YO : "#64748b");

      if (p.radioM && p.radioM > 0) {
        L.circle([p.lat, p.lng], {
          radius: p.radioM,
          color,
          weight: 1,
          opacity: 0.35,
          fillColor: color,
          fillOpacity: 0.08,
        }).addTo(capa);
      }

      if (p.tipo === "tecnico" || p.tipo === "yo") {
        // Pocos y hay que distinguirlos a simple vista: pin con la inicial.
        const inicial = esc(p.titulo.trim().charAt(0).toUpperCase() || "?");
        const icono = L.divIcon({
          className: "",
          html: `<div style="width:28px;height:28px;border-radius:999px;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font:700 12px system-ui;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${inicial}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        L.marker([p.lat, p.lng], { icon: icono, title: p.titulo })
          .bindPopup(popupHtml(p))
          .addTo(capa);
      } else {
        L.circleMarker([p.lat, p.lng], {
          renderer: rendererRef.current ?? undefined,
          radius: p.tipo === "nap" ? 7 : 5,
          color: "#ffffff",
          weight: p.tipo === "nap" ? 2 : 1,
          fillColor: color,
          fillOpacity: 0.95,
        })
          .bindPopup(popupHtml(p))
          .addTo(capa);
      }
    }

    // Con una ruta activa se encuadra SOLO la ruta. Si se metieran también los
    // ~1.600 abonados del mapa, pedir "cómo llegar" alejaría la vista a toda la
    // ciudad y el trayecto quedaría en un hilo de dos píxeles.
    const paraEncuadrar: [number, number][] =
      ruta && ruta.length > 1
        ? ruta.map((p) => [p.lat, p.lng] as [number, number])
        : puntos.map((p) => [p.lat, p.lng] as [number, number]);
    if (ajustarA && paraEncuadrar.length) {
      map.fitBounds(L.latLngBounds(paraEncuadrar), { padding: [40, 40], maxZoom: 17 });
    }
    // `firma` es lo que decide un repintado real; `puntos` cambia de identidad en
    // cada render aunque el contenido sea idéntico.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma, ajustarA, rutaAproximada]);

  return (
    // `isolate` es lo que mantiene el mapa por debajo de los modales: Leaflet
    // reparte z-index propios (paneles 400-700, controles 1000) y, sin un
    // contexto de apilamiento aquí, compiten con el del buscador y el de los
    // modales (z-90) y les quedan encima.
    <div className="relative isolate h-full w-full">
      <div ref={divRef} style={{ height: alto, width: "100%" }} className="rounded-xl" />
      <p className="pointer-events-none absolute bottom-1 left-1/2 z-[400] -translate-x-1/2 rounded bg-surface/80 px-2 py-0.5 text-[10px] text-text-tertiary">
        Usa Ctrl + rueda para acercar
      </p>
    </div>
  );
}
