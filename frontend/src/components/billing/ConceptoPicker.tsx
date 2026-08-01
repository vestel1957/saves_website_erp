"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

/** Entrada del catálogo facturable (GET /billing/catalog). */
export type CatalogoItem = {
  key: string;
  kind: "PLAN" | "PRODUCTO";
  name: string;
  productId: number;
  code: string | null;
  price: number;
  taxRate: number;
  usos: number;
};

/** Posición fija de la lista, calculada contra el campo. */
type Pos = { left: number; width: number; top?: number; bottom?: number; alto: number };

/** Aire mínimo contra el borde de la ventana. */
const MARGEN = 8;

/**
 * Selector de concepto para una línea de factura: buscador sobre el catálogo
 * (planes vigentes + productos del legacy) que ADEMÁS admite texto libre.
 *
 * Elegir del catálogo trae nombre, precio e IVA de una vez; escribir a mano sigue
 * valiendo (hay cobros que no están en ningún catálogo) y en ese caso solo cambia
 * la descripción. Es la misma mecánica del legacy al facturar: se busca el producto
 * y él pone el precio.
 *
 * La lista se dibuja en un PORTAL con posición fija, no dentro del campo: el modal
 * que la contiene recorta lo que sobresale (`overflow-y-auto`), así que anclada al
 * campo salía cortada y tocaba desplazar el modal para leerla. Fuera del modal ocupa
 * todo el alto que le quepa en pantalla y se voltea hacia arriba si abajo no cabe.
 */
export function ConceptoPicker({
  value,
  onPick,
  onText,
  placeholder = "Buscar producto…",
  className = "",
}: {
  /** Descripción actual de la línea (lo que se ve en el campo). */
  value: string;
  /** Se eligió una entrada del catálogo. */
  onPick: (item: CatalogoItem) => void;
  /** Se escribió texto libre. */
  onText: (text: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const { authFetch } = useAuth();
  const [items, setItems] = useState<CatalogoItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Busca en servidor con respiro: el catálogo son ~2.800 entradas, no se baja entero.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await authFetch(`/billing/catalog?search=${encodeURIComponent(value.trim())}&limit=30`);
        const d = await r.json();
        setItems(d.items ?? []);
        setHi(0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [value, open, authFetch]);

  /** Recalcula dónde y de qué alto va la lista (abre hacia el lado con más sitio). */
  const medir = useCallback(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const abajo = window.innerHeight - r.bottom - MARGEN;
    const arriba = r.top - MARGEN;
    const haciaAbajo = abajo >= arriba;
    // Ancho: al menos el del campo, pero legible (los conceptos son largos) y sin
    // salirse por la derecha.
    const width = Math.min(Math.max(r.width, 320), window.innerWidth - 2 * MARGEN);
    const left = Math.min(Math.max(r.left, MARGEN), window.innerWidth - width - MARGEN);
    setPos(
      haciaAbajo
        ? { left, width, top: r.bottom + 4, alto: abajo - 4 }
        : { left, width, bottom: window.innerHeight - r.top + 4, alto: arriba - 4 },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    medir();
    // El modal se desplaza por dentro: la lista tiene que seguir al campo (captura,
    // para enterarse del scroll de cualquier contenedor, no solo del de la ventana).
    window.addEventListener("scroll", medir, true);
    window.addEventListener("resize", medir);
    return () => {
      window.removeEventListener("scroll", medir, true);
      window.removeEventListener("resize", medir);
    };
  }, [open, medir]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(it: CatalogoItem) {
    onPick(it);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && items[hi]) { e.preventDefault(); pick(items[hi]); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  const lista = open && pos && (
    <div
      ref={menu}
      style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.alto }}
      className="z-[100] overflow-hidden rounded-xl border border-border-default bg-surface shadow-lg"
    >
      <ul className="overflow-y-auto py-1" style={{ maxHeight: pos.alto }}>
        {loading && items.length === 0 && (
          <li className="px-3 py-2 text-[12px] text-text-tertiary">Buscando…</li>
        )}
        {!loading && items.length === 0 && (
          <li className="px-3 py-2 text-[12px] text-text-tertiary">
            Sin coincidencias en el catálogo — se usará lo que escribas.
          </li>
        )}
        {items.map((it, i) => (
          <li
            key={it.key}
            onMouseEnter={() => setHi(i)}
            onMouseDown={(e) => { e.preventDefault(); pick(it); }}
            className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] ${i === hi ? "bg-brand-soft" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{it.name}</span>
            {it.kind === "PLAN" && (
              <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand">Plan</span>
            )}
            {it.taxRate > 0 && (
              <span className="shrink-0 text-[10px] font-semibold text-text-tertiary">IVA {it.taxRate}%</span>
            )}
            <span className="shrink-0 font-mono text-[11px] text-text-secondary">{cop(it.price)}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div ref={box} className={className}>
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onText(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {lista && createPortal(lista, document.body)}
    </div>
  );
}
