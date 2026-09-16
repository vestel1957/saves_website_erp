"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { listaJson, mensajeDeError } from "@/lib/errores";

type Mat = {
  id: string; name: string; code: string | null; price: number; qty: number;
  categoryId: string | null; category: string | null;
  warehouseId: string | null; warehouse: string | null; low: boolean;
};
type Bodega = {
  id: string; title: string; extra: string | null; manager: string | null;
  items: number; units: number; value: number; isMain: boolean; personal: boolean; mine: boolean;
};
type Pagina = { rows: Mat[]; total: number; page: number; pageSize: number; categories: { id: string; title: string; count: number }[] };
/** `qty` va como texto para que el campo se pueda dejar vacío mientras se escribe. */
type Line = { material: Mat; qty: string };

const num = (v: string) => Number(v) || 0;
const PAGE_SIZE = 25;
const VACIA: Pagina = { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, categories: [] };

/**
 * Modal para registrar material consumido (descuenta stock).
 *
 * Lo usan la orden de soporte y el proyecto: los dos gastan del mismo almacén y
 * el buscador es el mismo (`material-stock.ts` en el backend), así que el modal
 * recibe las dos rutas en vez de tener una copia por módulo.
 *
 * Se entra POR LA BODEGA y no por una caja de texto a ciegas (2026-09-08): antes
 * había que saberse de memoria el nombre de lo que se buscaba, y el material que
 * no se recordaba simplemente no existía. Ahora primero se ven los estantes —con
 * cuánto hay en cada uno—, se entra a uno y se recorre lo que tiene, con filtro
 * por categoría y paginado. Quien ya sabe qué busca tiene el atajo de arriba:
 * "Buscar en todas las bodegas".
 *
 * La cesta sobrevive al cambio de bodega a propósito: una obra se lleva cable de
 * un estante y conectores de otro, y cada línea guarda de qué bodega salió.
 */
export function ConsumirMaterialModal({
  open, onClose, onDone, ticketId,
  buscarUrl = "/support/materials/search",
  guardarUrl,
  title = "Registrar material consumido",
  ayuda = "Busca y agrega los materiales usados en la orden.",
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** Orden de soporte. Se ignora si viene `guardarUrl`. */
  ticketId?: string;
  buscarUrl?: string;
  guardarUrl?: string;
  title?: string;
  ayuda?: string;
}) {
  const { authFetch } = useAuth();
  /** Las bodegas cuelgan del mismo módulo que el buscador: /…/materials/warehouses. */
  const bodegasUrl = buscarUrl.replace(/\/search$/, "/warehouses");

  const [vista, setVista] = useState<"bodegas" | "material">("bodegas");
  const [bodegas, setBodegas] = useState<Bodega[] | null>(null);
  const [qBodega, setQBodega] = useState("");
  /** Bodega abierta; `null` en la vista de material = buscar en todas. */
  const [bodega, setBodega] = useState<Bodega | null>(null);

  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pagina, setPagina] = useState<Pagina>(VACIA);
  const [cargando, setCargando] = useState(false);

  /** Las bodegas personales de los técnicos (35 de 57) van escondidas por defecto. */
  const [verPersonales, setVerPersonales] = useState(false);
  /** La lista no se pudo traer (red caída, sesión vencida, app sin recargar). */
  const [falloCarga, setFalloCarga] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cada apertura empieza limpia: la cesta de la vez anterior ya se registró.
  useEffect(() => {
    if (!open) return;
    setVista("bodegas"); setBodegas(null); setQBodega(""); setBodega(null); setVerPersonales(false);
    setSearch(""); setCat(""); setPage(1); setPagina(VACIA); setLines([]); setErr(null); setFalloCarga(false);
  }, [open]);

  // Bodegas con material. Al técnico de campo el backend le devuelve UNA, la suya:
  // hacerle elegir entre una sola opción es un clic de más, así que se entra solo.
  useEffect(() => {
    if (!open) return;
    let vivo = true;
    void authFetch(bodegasUrl).then(listaJson<Bodega>).then((bs) => {
      if (!vivo) return;
      setBodegas(bs);
      if (bs.length === 1) { setBodega(bs[0]); setVista("material"); }
    }).catch(() => { if (vivo) { setBodegas([]); setFalloCarga(true); } });
    return () => { vivo = false; };
  }, [open, authFetch, bodegasUrl]);

  // Material de la bodega abierta (o de todas), con debounce en el texto.
  useEffect(() => {
    if (!open || vista !== "material") return;
    let vivo = true;
    setCargando(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search.trim()) params.set("search", search.trim());
    if (bodega) params.set("warehouseId", bodega.id);
    if (cat) params.set("categoryId", cat);
    const h = setTimeout(() => {
      void authFetch(`${buscarUrl}?${params.toString()}`)
        .then((r) => r.json())
        .then((d) => {
          if (!vivo) return;
          // Una respuesta que no es la página esperada NO es "no hay material": es
          // la app sin recargar o la sesión caída. Callarlo dejaba al técnico
          // mirando una lista vacía con el almacén lleno.
          const ok = Boolean(d) && Array.isArray(d.rows);
          setPagina(ok ? d : VACIA);
          setFalloCarga(!ok);
        })
        .catch(() => { if (vivo) { setPagina(VACIA); setFalloCarga(true); } })
        .finally(() => { if (vivo) setCargando(false); });
    }, search ? 250 : 0);
    return () => { vivo = false; clearTimeout(h); };
  }, [open, vista, search, cat, page, bodega, authFetch, buscarUrl]);

  const bodegasFiltradas = useMemo(() => {
    const q = qBodega.trim().toLowerCase();
    const lista = bodegas ?? [];
    return q ? lista.filter((b) => `${b.title} ${b.extra ?? ""} ${b.manager ?? ""}`.toLowerCase().includes(q)) : lista;
  }, [bodegas, qBodega]);

  // Buscando por texto se ven todas: si se escribe el nombre de un técnico es
  // justo su almacén lo que se está buscando.
  const personalesOcultas = qBodega.trim() || verPersonales ? [] : bodegasFiltradas.filter((b) => b.personal && !b.mine);
  const bodegasVisibles = personalesOcultas.length
    ? bodegasFiltradas.filter((b) => !b.personal || b.mine)
    : bodegasFiltradas;

  const abrir = useCallback((b: Bodega | null) => {
    setBodega(b); setSearch(""); setCat(""); setPage(1); setPagina(VACIA); setVista("material");
  }, []);

  function add(m: Mat) {
    setLines((prev) => (prev.some((l) => l.material.id === m.id) ? prev : [...prev, { material: m, qty: "1" }]));
  }
  function setQty(id: string, texto: string) {
    const limpio = texto.replace(/[^0-9]/g, "");
    setLines((prev) => prev.map((l) => (l.material.id === id ? { ...l, qty: limpio } : l)));
  }
  /** Al salir del campo se acota al stock disponible (y nunca queda vacío).*/
  function ajustarQty(id: string) {
    setLines((prev) => prev.map((l) => (l.material.id === id ? { ...l, qty: String(Math.max(1, Math.min(l.material.qty, num(l.qty) || 1))) } : l)));
  }
  function remove(id: string) {
    setLines((prev) => prev.filter((l) => l.material.id !== id));
  }

  const total = lines.reduce((s, l) => s + l.material.price * num(l.qty), 0);
  const enCesta = useMemo(() => new Set(lines.map((l) => l.material.id)), [lines]);
  const unaSola = (bodegas?.length ?? 0) <= 1;

  async function submit() {
    setErr(null);
    if (!lines.length) { setErr("Agrega al menos un material."); return; }
    setSaving(true);
    try {
      const res = await authFetch(guardarUrl ?? `/support/tickets/${ticketId}/materials`, {
        method: "POST",
        body: JSON.stringify({ items: lines.map((l) => ({ materialId: l.material.id, qty: Math.max(1, Math.min(l.material.qty, num(l.qty) || 1)) })) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo registrar el material");
      toast("Material registrado (stock descontado)");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-3xl">
      <div className="flex flex-col gap-3">
        {vista === "bodegas" ? (
          /* ── Paso 1: el estante ─────────────────────────────────────────── */
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex-1">
                <Input value={qBodega} onChange={(e) => setQBodega(e.target.value)} placeholder="Buscar bodega por nombre o encargado…" autoFocus />
              </div>
              <Button variant="secondary" size="sm" onClick={() => abrir(null)}>
                <Icon name="search" size={14} />
                Buscar en todas
              </Button>
            </div>

            {bodegas === null ? (
              <p className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando bodegas…</p>
            ) : bodegasVisibles.length === 0 && personalesOcultas.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-[12px] text-text-tertiary">
                {falloCarga
                  ? "No se pudo cargar el inventario. Cierra y vuelve a abrir la aplicación; si sigue igual, avisa a soporte."
                  : bodegas.length === 0 ? "No hay bodegas con material disponible." : "Ninguna bodega coincide con la búsqueda."}
              </p>
            ) : (
              <div className="grid max-h-[46vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                {bodegasVisibles.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => abrir(b)}
                    className="flex items-start gap-3 rounded-xl border border-border-subtle bg-surface px-3 py-3 text-left transition-colors hover:border-brand hover:bg-surface-2"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <Icon name="warehouse" size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="truncate text-[13px] font-semibold text-text-primary">{b.title}</span>
                        {b.mine && <Badge label="Tu bodega" tone="brand" />}
                        {b.isMain && !b.mine && <Badge label="Principal" tone="info" />}
                        {b.personal && !b.mine && <Badge label="De técnico" tone="default" />}
                      </span>
                      {(b.extra || b.manager) && (
                        <span className="block truncate text-[11px] text-text-tertiary">{b.extra || `Encargado: ${b.manager}`}</span>
                      )}
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-secondary">
                        <span>{b.items} referencia{b.items === 1 ? "" : "s"}</span>
                        <span className="text-text-tertiary">·</span>
                        <span>{b.units} unidades</span>
                        <span className="ml-auto font-semibold text-text-primary">{cop(b.value)}</span>
                      </span>
                    </span>
                  </button>
                ))}
                {personalesOcultas.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setVerPersonales(true)}
                    className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-subtle px-3 py-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2 sm:col-span-2"
                  >
                    <Icon name="users" size={14} />
                    Ver también las {personalesOcultas.length} bodegas personales de técnicos
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          /* ── Paso 2: el material de ese estante ─────────────────────────── */
          <>
            <div className="flex flex-wrap items-center gap-2">
              {!unaSola && (
                <Button variant="ghost" size="sm" onClick={() => setVista("bodegas")}>
                  <Icon name="chevron-left" size={14} />
                  Bodegas
                </Button>
              )}
              <span className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
                <Icon name="warehouse" size={15} />
                {bodega ? bodega.title : "Todas las bodegas"}
              </span>
              <span className="ml-auto text-[11px] text-text-tertiary">
                {cargando ? "Buscando…" : `${pagina.total} referencia${pagina.total === 1 ? "" : "s"} con stock`}
              </span>
            </div>

            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Filtrar por nombre o código…" autoFocus />

            {pagina.categories.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <Chip activo={!cat} onClick={() => { setCat(""); setPage(1); }}>Todas</Chip>
                {pagina.categories.map((c) => (
                  <Chip key={c.id} activo={cat === c.id} onClick={() => { setCat(cat === c.id ? "" : c.id); setPage(1); }}>
                    {c.title} <span className="opacity-60">{c.count}</span>
                  </Chip>
                ))}
              </div>
            )}

            <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-border-subtle">
              {pagina.rows.length === 0 ? (
                <p className="px-3 py-6 text-center text-[12px] text-text-tertiary">
                  {cargando
                    ? "Buscando…"
                    : falloCarga
                      ? "No se pudo cargar el material. Cierra y vuelve a abrir la aplicación; si sigue igual, avisa a soporte."
                      : "No hay material que coincida."}
                </p>
              ) : pagina.rows.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => add(m)}
                  className="flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-left text-[13px] last:border-0 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <span className="font-medium text-text-primary">{m.name}</span>
                      {m.code && <span className="ml-1 font-mono text-[11px] text-text-tertiary">{m.code}</span>}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-text-tertiary">
                      <span className={m.low ? "font-semibold text-warning-text" : ""}>stock {m.qty}{m.low ? " · bajo" : ""}</span>
                      {m.category && <span>· {m.category}</span>}
                      {!bodega && m.warehouse && <span>· {m.warehouse}</span>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[12px] text-text-secondary">{cop(m.price)}</span>
                    <span className={`text-[11px] ${enCesta.has(m.id) ? "text-brand" : "text-text-tertiary"}`}>
                      {enCesta.has(m.id) ? "en la cesta" : "agregar +"}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {pagina.total > pagina.pageSize && (
              <Pagination
                meta={{ page: pagina.page, pageSize: pagina.pageSize, total: pagina.total, pageCount: Math.ceil(pagina.total / pagina.pageSize) }}
                onPage={setPage}
              />
            )}
          </>
        )}

        {/* Cesta: se mantiene aunque se cambie de bodega. */}
        {lines.length ? (
          <div className="rounded-lg border border-border-subtle">
            <div className="border-b border-border-subtle bg-surface-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
              Por registrar ({lines.length})
            </div>
            <div className="max-h-40 overflow-y-auto">
              {lines.map((l) => (
                <div key={l.material.id} className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text-primary">{l.material.name}</span>
                    {l.material.warehouse && <span className="block truncate text-[11px] text-text-tertiary">{l.material.warehouse}</span>}
                  </span>
                  <Input value={l.qty} onChange={(e) => setQty(l.material.id, e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => ajustarQty(l.material.id)} inputMode="numeric" className="w-16 text-center" aria-label={`Cantidad de ${l.material.name}`} />
                  <span className="w-24 shrink-0 text-right text-[12px] text-text-secondary">{cop(l.material.price * num(l.qty))}</span>
                  <button type="button" onClick={() => remove(l.material.id)} className="text-error-text hover:opacity-70" aria-label={`Quitar ${l.material.name}`}><Icon name="trash" size={14} /></button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between px-3 py-2 text-[13px] font-bold text-text-primary">
              <span>Total</span><span>{cop(total)}</span>
            </div>
          </div>
        ) : <p className="rounded-lg border border-dashed border-border-subtle px-3 py-4 text-center text-[12px] text-text-tertiary">{ayuda}</p>}

        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !lines.length}>{saving ? "Registrando…" : "Registrar y descontar"}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Chip de filtro por categoría. */
function Chip({ activo, onClick, children }: { activo: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        activo ? "border-brand bg-brand-soft text-brand" : "border-border-subtle bg-surface text-text-secondary hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}
