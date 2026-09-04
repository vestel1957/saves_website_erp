"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { commandItems, type CommandItem } from "@/lib/nav";
import { toast } from "../ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { ubicacionDe } from "@/lib/subscribers";

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
  neighborhood: string | null;
  city: string | null;
};

/** Un resultado de la búsqueda con IA (lo arma el backend, ya clicable). */
type AiHit = {
  module: string;
  id: string;
  href: string;
  title: string;
  subtitle: string;
  /** Dónde vive el cliente (barrio · municipio). Solo lo traen los abonados. */
  place?: string | null;
  badge?: string | null;
};

/** Entrada unificada de la lista de resultados. */
type Entry =
  | { type: "sub"; key: string; sub: SubHit }
  | { type: "nav"; key: string; item: CommandItem }
  | { type: "ai-action"; key: string }
  | { type: "ai-hit"; key: string; hit: AiHit };

export function CommandPalette() {
  const router = useRouter();
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [subs, setSubs] = useState<SubHit[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  // Búsqueda con IA: modo explícito que reemplaza los resultados por los que
  // devuelve el backend tras interpretar la frase.
  const [aiMode, setAiMode] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHits, setAiHits] = useState<AiHit[]>([]);
  const [aiInterpreted, setAiInterpreted] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
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
      resetAi();
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Al cambiar la frase se abandona el modo IA (los resultados dejan de valer).
  useEffect(() => {
    resetAi();
  }, [query]);

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

  // Lista unificada. En modo IA solo se muestran los resultados de la IA; si no,
  // clientes + navegación, con la acción "Buscar con IA" al frente cuando la
  // frase parece una consulta (≥3 caracteres).
  const entries = useMemo<Entry[]>(() => {
    if (aiMode) {
      return aiHits.map((h): Entry => ({ type: "ai-hit", key: `ai-${h.module}-${h.id}`, hit: h }));
    }
    const aiAction: Entry[] =
      query.trim().length >= 3 ? [{ type: "ai-action", key: "ai-action" }] : [];
    return [
      ...aiAction,
      ...subs.map((s): Entry => ({ type: "sub", key: `sub-${s.id}`, sub: s })),
      ...navResults.map((it): Entry => ({ type: "nav", key: `nav-${it.section}-${it.label}`, item: it })),
    ];
  }, [aiMode, aiHits, query, subs, navResults]);

  // Mantener el cursor dentro de rango cuando cambian los resultados.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  function resetAi() {
    setAiMode(false);
    setAiHits([]);
    setAiInterpreted(null);
    setAiError(null);
    setAiLoading(false);
  }

  // Lanza la búsqueda con IA: manda la frase al backend y reemplaza los
  // resultados por lo que interpretó. No cierra el palette.
  async function runAi() {
    const q = query.trim();
    if (q.length < 3 || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await authFetch("/search/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      });
      const data = res.ok ? await res.json() : null;
      if (!data || data.unavailable) {
        setAiError("La búsqueda con IA no está disponible ahora.");
        setAiLoading(false);
        return;
      }
      setAiHits(data.hits ?? []);
      setAiInterpreted(data.interpreted ?? null);
      setAiMode(true);
      setCursor(0);
    } catch {
      setAiError("No se pudo completar la búsqueda con IA.");
    } finally {
      setAiLoading(false);
    }
  }

  function choose(entry: Entry | undefined) {
    if (!entry) return;
    if (entry.type === "ai-action") {
      void runAi();
      return;
    }
    setOpen(false);
    if (entry.type === "sub") {
      router.push(`/clientes/${entry.sub.id}`);
    } else if (entry.type === "ai-hit") {
      router.push(entry.hit.href);
    } else if (entry.type === "nav" && entry.item.href) {
      router.push(entry.item.href);
    } else if (entry.type === "nav") {
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
  const showEmpty = entries.length === 0 && !loadingSubs && !aiLoading;

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
          {(loadingSubs || aiLoading) && (
            <Icon name="loader" size={14} className="animate-spin text-text-tertiary" />
          )}
          <kbd className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-text-tertiary">
            ESC
          </kbd>
        </div>

        {/* chip de interpretación IA + errores */}
        {aiMode && aiInterpreted && (
          <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-2/60 px-4 py-2 text-[11px] text-text-secondary">
            <Icon name="sparkles" size={13} className="shrink-0 text-brand" />
            <span className="truncate">
              IA entendió: <span className="font-medium text-text-primary">{aiInterpreted}</span>
            </span>
          </div>
        )}
        {aiError && (
          <div className="border-b border-border-subtle px-4 py-2 text-[11px] text-error">{aiError}</div>
        )}

        {/* results */}
        <div className="max-h-[46vh] overflow-y-auto p-2">
          {showEmpty ? (
            <p className="px-3 py-8 text-center text-[13px] text-text-tertiary">
              {aiMode
                ? `La IA no encontró resultados para “${q}”.`
                : q
                  ? `Sin resultados para “${q}”.`
                  : "Escribe para buscar."}
            </p>
          ) : (
            entries.map((entry, i) => {
              const prev = entries[i - 1];
              const active = i === cursor;
              const rowClass = `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                active ? "bg-surface-2" : ""
              }`;
              const header =
                entry.type === "ai-hit" && prev?.type !== "ai-hit"
                  ? "Resultados IA"
                  : entry.type === "sub" && prev?.type !== "sub"
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
                  {entry.type === "ai-action" ? (
                    <button
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(entry)}
                      className={rowClass}
                    >
                      <Icon name="sparkles" size={16} className="shrink-0 text-brand" />
                      <span className="flex-1 text-[13px] font-medium text-text-primary">
                        Buscar <span className="text-brand">“{q}”</span> con IA
                      </span>
                      <span className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                        lenguaje natural
                      </span>
                      {active && <Icon name="corner-down-left" size={13} className="shrink-0 text-text-tertiary" />}
                    </button>
                  ) : entry.type === "ai-hit" ? (
                    <button
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(entry)}
                      className={rowClass}
                    >
                      <Icon
                        name={entry.hit.module === "facturas" ? "file-text" : "user"}
                        size={16}
                        className="shrink-0 text-brand"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium text-text-primary">{entry.hit.title}</span>
                        <span className="truncate text-[11px] text-text-tertiary">{entry.hit.subtitle}</span>
                        {entry.hit.place && (
                          <span className="truncate text-[11px] text-text-tertiary">
                            <Icon name="map-pin" size={10} className="mr-1 inline align-[-1px]" />
                            {entry.hit.place}
                          </span>
                        )}
                      </span>
                      {entry.hit.badge && (
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                          {entry.hit.badge}
                        </span>
                      )}
                      {active && <Icon name="corner-down-left" size={13} className="shrink-0 text-text-tertiary" />}
                    </button>
                  ) : entry.type === "sub" ? (
                    <button
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(entry)}
                      className={rowClass}
                    >
                      <Icon name="user" size={16} className="shrink-0 text-brand" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium text-text-primary">{entry.sub.name}</span>
                        <span className="truncate text-[11px] text-text-tertiary">
                          Abonado {entry.sub.abonado}
                          {entry.sub.docNumber && ` · ${entry.sub.docType ?? ""} ${entry.sub.docNumber}`}
                          {entry.sub.phone && ` · ${entry.sub.phone}`}
                        </span>
                        {/* Dónde vive, en su propio renglón: quien busca "María
                            González" y recibe cuatro, distingue por el barrio.
                            Apilado y no en la línea de arriba porque ésa ya se
                            trunca con documento y teléfono. */}
                        {ubicacionDe(entry.sub) && (
                          <span className="truncate text-[11px] text-text-tertiary">
                            <Icon name="map-pin" size={10} className="mr-1 inline align-[-1px]" />
                            {ubicacionDe(entry.sub)}
                          </span>
                        )}
                      </span>
                      {entry.sub.status && (
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                          {entry.sub.status.toLowerCase()}
                        </span>
                      )}
                      {active && <Icon name="corner-down-left" size={13} className="shrink-0 text-text-tertiary" />}
                    </button>
                  ) : (
                    <button
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(entry)}
                      className={rowClass}
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
                      {active && <Icon name="corner-down-left" size={13} className="text-text-tertiary" />}
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
            <Icon name="sparkles" size={12} className="text-brand" /> escribe una frase y pulsa “Buscar con IA”
          </span>
        </div>
      </div>
    </div>
  );
}
