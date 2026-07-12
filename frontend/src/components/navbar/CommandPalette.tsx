"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { commandItems, type CommandItem } from "@/lib/nav";
import { toast } from "../ui/Toast";
import { useAuth } from "@/context/AuthProvider";

export const OPEN_COMMAND_EVENT = "nexus:command-palette";

/** Cliente devuelto por /subscribers (forma reducida que usa el buscador). */
type SubHit = {
  id: string;
  abonado: number;
  name: string;
  docType: string | null;
  docNumber: string | null;
  phone: string | null;
  status: string | null;
  branch: string | null;
};

/** Entrada unificada de la lista de resultados (cliente o navegación). */
type Entry =
  | { type: "sub"; key: string; sub: SubHit }
  | { type: "nav"; key: string; item: CommandItem };

export function CommandPalette() {
  const router = useRouter();
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [subs, setSubs] = useState<SubHit[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Abrir con ⌘K / Ctrl+K o por evento (click en el buscador del navbar).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_EVENT, onOpen);
    };
  }, []);

  // Reset al abrir.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setSubs([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Búsqueda de clientes en el backend (con debounce).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSubs([]);
      setLoadingSubs(false);
      return;
    }
    setLoadingSubs(true);
    const t = setTimeout(async () => {
      try {
        const res = await authFetch(`/subscribers?search=${encodeURIComponent(q)}&pageSize=6`);
        const data = res.ok ? await res.json() : null;
        setSubs(data?.items ?? []);
      } catch {
        setSubs([]);
      } finally {
        setLoadingSubs(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, authFetch]);

  // Filtrado de módulos/páginas (igual que antes).
  const navResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commandItems;
    return commandItems.filter(
      (it) => it.label.toLowerCase().includes(q) || it.section.toLowerCase().includes(q),
    );
  }, [query]);

  // Lista unificada: clientes primero, luego navegación.
  const entries = useMemo<Entry[]>(
    () => [
      ...subs.map((s): Entry => ({ type: "sub", key: `sub-${s.id}`, sub: s })),
      ...navResults.map((it): Entry => ({ type: "nav", key: `nav-${it.section}-${it.label}`, item: it })),
    ],
    [subs, navResults],
  );

  // Mantener el cursor dentro de rango cuando cambian los resultados.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  function choose(entry: Entry | undefined) {
    if (!entry) return;
    setOpen(false);
    if (entry.type === "sub") {
      router.push(`/clientes/${entry.sub.id}`);
    } else if (entry.item.href) {
      router.push(entry.item.href);
    } else {
      toast(`${entry.item.label} — módulo en construcción`, "sparkles");
    }
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(entries[cursor]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (!open) return null;

  const q = query.trim();
  const showEmpty = entries.length === 0 && !loadingSubs;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 px-3 pt-[12vh] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* input */}
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-4">
          <Icon name="search" size={16} className="text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Buscar clientes, módulos y páginas…"
            className="h-12 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {loadingSubs && <Icon name="loader" size={14} className="animate-spin text-text-tertiary" />}
          <kbd className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-text-tertiary">
            ESC
          </kbd>
        </div>

        {/* results */}
        <div className="max-h-[46vh] overflow-y-auto p-2">
          {showEmpty ? (
            <p className="px-3 py-8 text-center text-[13px] text-text-tertiary">
              {q ? `Sin resultados para “${q}”.` : "Escribe para buscar."}
            </p>
          ) : (
            entries.map((entry, i) => {
              const prev = entries[i - 1];
              const header =
                entry.type === "sub" && prev?.type !== "sub"
                  ? "Clientes"
                  : entry.type === "nav" && prev?.type !== "nav"
                    ? "Ir a"
                    : null;
              return (
                <div key={entry.key}>
                  {header && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                      {header}
                    </div>
                  )}
                  {entry.type === "sub" ? (
                    <button
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(entry)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        i === cursor ? "bg-surface-2" : ""
                      }`}
                    >
                      <Icon name="user" size={16} className="shrink-0 text-brand" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium text-text-primary">{entry.sub.name}</span>
                        <span className="truncate text-[11px] text-text-tertiary">
                          Abonado {entry.sub.abonado}
                          {entry.sub.docNumber && ` · ${entry.sub.docType ?? ""} ${entry.sub.docNumber}`}
                          {entry.sub.phone && ` · ${entry.sub.phone}`}
                        </span>
                      </span>
                      {entry.sub.status && (
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                          {entry.sub.status.toLowerCase()}
                        </span>
                      )}
                      {i === cursor && <Icon name="corner-down-left" size={13} className="shrink-0 text-text-tertiary" />}
                    </button>
                  ) : (
                    <button
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(entry)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        i === cursor ? "bg-surface-2" : ""
                      }`}
                    >
                      <Icon
                        name={entry.item.icon}
                        size={16}
                        className={entry.item.href ? "text-text-secondary" : "text-text-tertiary"}
                      />
                      <span className="flex-1 text-[13px] font-medium text-text-primary">{entry.item.label}</span>
                      <span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                        {entry.item.section.toLowerCase()}
                      </span>
                      {i === cursor && <Icon name="corner-down-left" size={13} className="text-text-tertiary" />}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* footer — atajos de teclado, ocultos en móvil */}
        <div className="hidden items-center gap-4 border-t border-border-subtle px-4 py-2.5 text-[11px] text-text-tertiary sm:flex">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-subtle bg-surface-2 px-1 py-0.5">↑↓</kbd>
            navegar
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-subtle bg-surface-2 px-1 py-0.5">↵</kbd>
            abrir
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Icon name="user" size={12} /> busca clientes por nombre, documento, celular o abonado
          </span>
        </div>
      </div>
    </div>
  );
}
