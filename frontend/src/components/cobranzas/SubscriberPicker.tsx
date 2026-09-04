"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { ubicacionDe } from "@/lib/subscribers";

export type PickedSub = { id: string; name: string; abonado: number };

/** Fila de la lista: el elegido más dónde vive, que es como se desempatan homónimos. */
type SubFila = PickedSub & { neighborhood: string | null; city: string | null; branch: string | null };

/** Cuántos clientes trae cada asomada a la lista. */
const POR_PAGINA = 25;

/**
 * Desplegable de clientes.
 *
 * Se abre y ENSEÑA la lista, como cualquier otro desplegable de la pantalla: antes
 * era una caja de texto en blanco donde había que adivinar qué escribir para que
 * apareciera algo.
 *
 * Por qué sigue llevando un filtro dentro y no es un `<select>` a secas, como el de
 * beneficiario: son **21.845 clientes**. Un `<select>` con todos obliga a bajarlos
 * enteros al navegador y a buscar a alguien rodando la rueda; con el filtro se acota
 * en dos teclas. Lo que se escribe ahí NO se guarda en ninguna parte —es un colador
 * sobre la lista—, así que no hay el riesgo de nombres inventados que sí había con el
 * beneficiario.
 */
export function SubscriberPicker({
  value, onChange, placeholder = "Elige un cliente…",
}: {
  value: PickedSub | null;
  onChange: (s: PickedSub | null) => void;
  placeholder?: string;
}) {
  const { authFetch } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SubFila[]>([]);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  const cargar = useCallback(async (term: string) => {
    setCargando(true);
    try {
      // Se pide por ABONADO y no por nombre a propósito: 1.639 clientes traen
      // espacios delante del nombre (herencia del legacy), y ordenar por nombre en
      // la base los sube a todos al principio — el desplegable abría justo con los
      // registros sucios. Por abonado el orden es estable y limpio; lo que se ve se
      // ordena alfabéticamente aquí abajo, que son 25 filas.
      const qs = new URLSearchParams({ pageSize: String(POR_PAGINA), sortBy: "abonado", sortDir: "asc" });
      if (term) qs.set("search", term);
      const r = await authFetch(`/subscribers?${qs.toString()}`);
      const d = r.ok ? await r.json() : null;
      const filas: SubFila[] = (d?.items ?? []).map((x: any) => ({
        id: x.id, name: x.name, abonado: x.abonado,
        neighborhood: x.neighborhood ?? null, city: x.city ?? null, branch: x.branch ?? null,
      }));
      setItems(filas.sort((a, b) => a.name.trim().localeCompare(b.name.trim(), "es")));
      setTotal(d?.total ?? 0);
    } catch {
      setItems([]); setTotal(0);
    } finally {
      setCargando(false);
    }
  }, [authFetch]);

  // La lista se pide al abrir (con el filtro vacío ya trae la primera página) y
  // cada vez que cambia el filtro.
  useEffect(() => {
    if (!abierto) return;
    const t = setTimeout(() => { void cargar(q.trim()); }, q.trim() ? 300 : 0);
    return () => clearTimeout(t);
  }, [abierto, q, cargar]);

  // En CAPTURA: dentro de un Modal el mousedown no llega hasta document en fase de
  // burbuja (el Modal lo corta) y el desplegable se quedaba abierto.
  useEffect(() => {
    const fuera = (e: MouseEvent) => { if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false); };
    document.addEventListener("mousedown", fuera, true);
    return () => document.removeEventListener("mousedown", fuera, true);
  }, []);

  const abrir = () => { setAbierto((v) => !v); setQ(""); };

  // Al elegir se guarda SOLO lo que el formulario necesita (id, nombre, abonado):
  // el barrio es ayuda para escoger, no parte de la selección.
  const elegir = (s: SubFila) => { onChange({ id: s.id, name: s.name, abonado: s.abonado }); setAbierto(false); setQ(""); };

  return (
    <div ref={caja} className="relative">
      {/* Cara cerrada: mismo aspecto que un <Select> para que se lea como lo que es. */}
      <button
        type="button"
        onClick={abrir}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border-default bg-surface px-3 py-2 text-left text-[13px] text-text-primary shadow-sm outline-none transition-colors hover:border-border-strong focus:border-border-focus focus:ring-2 focus:ring-brand/25"
      >
        {value ? (
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <Icon name="user" size={14} className="shrink-0 text-brand" />
            <span className="truncate">{value.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-text-tertiary">#{value.abonado}</span>
          </span>
        ) : (
          <span className="truncate text-text-tertiary">{placeholder}</span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          {value && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Quitar cliente"
              onClick={(e) => { e.stopPropagation(); onChange(null); setAbierto(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onChange(null); } }}
              className="rounded-md p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="x" size={14} />
            </span>
          )}
          <Icon name="chevron-down" size={14} className="text-text-secondary" />
        </span>
      </button>

      {abierto && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border-default bg-surface shadow-lg">
          <div className="border-b border-border-subtle p-2">
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrar por nombre, documento o abonado…"
            />
          </div>

          <div className="max-h-64 overflow-y-auto">
            {cargando && <div className="px-3 py-2 text-[12px] text-text-tertiary">Cargando…</div>}
            {!cargando && items.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-text-tertiary">Ningún cliente con ese criterio.</div>
            )}
            {items.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => elegir(s)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2"
              >
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate font-medium text-text-primary">{s.name}</span>
                  {/* Con 21.845 clientes hay homónimos de sobra: el barrio y el
                      municipio son lo que permite acertar sin salir del modal. */}
                  {ubicacionDe(s) && (
                    <span className="truncate text-[11px] text-text-tertiary">{ubicacionDe(s)}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-text-tertiary">#{s.abonado}</span>
              </button>
            ))}
          </div>

          {/* Decir cuántos quedan fuera evita el engaño de creer que la lista es todo
              lo que hay: con 21.845 clientes, la primera página no dice nada. */}
          {total > items.length && (
            <div className="border-t border-border-subtle px-3 py-2 text-[11px] text-text-tertiary">
              {items.length} de {total.toLocaleString("es-CO")} · filtra arriba para encontrar el tuyo
            </div>
          )}
        </div>
      )}
    </div>
  );
}
