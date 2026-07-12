"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";

export type ComboItem = {
  value: string;
  /** primary text (e.g. product name) */
  label: string;
  /** secondary text shown muted (e.g. SKU / code) */
  sublabel?: string;
  /** extra text included in the search match but not displayed */
  keywords?: string;
};

/**
 * Searchable single-select combobox with keyboard navigation. A single field
 * that filters a (potentially large) list as you type — replaces messy "pill
 * cloud" pickers. Theme-aware, mobile-friendly.
 */
export function Combobox({
  items,
  value,
  onChange,
  placeholder = "Buscar…",
  emptyText = "Sin coincidencias.",
  maxResults = 50,
  className = "",
  icon = "search",
}: {
  items: ComboItem[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  maxResults?: number;
  className?: string;
  icon?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const selected = useMemo(() => items.find((i) => i.value === value), [items, value]);

  const { results, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = q
      ? items.filter((i) =>
          `${i.label} ${i.sublabel ?? ""} ${i.keywords ?? ""}`.toLowerCase().includes(q),
        )
      : items;
    return { results: all.slice(0, maxResults), total: all.length };
  }, [items, query, maxResults]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // keep highlighted option in view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function openMenu() {
    setQuery("");
    setHighlight(Math.max(0, results.findIndex((r) => r.value === value)));
    setOpen(true);
  }

  function pick(item: ComboItem) {
    onChange(item.value);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) return openMenu();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && results[highlight]) pick(results[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <Icon name={icon} size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="w-full rounded-lg border border-border-default bg-surface px-3 py-2 pl-9 pr-9 text-[13px] font-medium text-text-primary shadow-sm outline-none transition-colors placeholder:font-normal placeholder:text-text-tertiary hover:border-border-strong focus:border-border-focus focus:ring-2 focus:ring-brand/25"
        placeholder={selected ? selected.label : placeholder}
        value={open ? query : selected?.label ?? ""}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          if (!open) setOpen(true);
        }}
        onFocus={openMenu}
        onKeyDown={onKeyDown}
      />
      <Icon
        name="chevrons-up-down"
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary"
      />

      {open && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-border-default bg-surface shadow-lg">
          <ul ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto py-1">
            {results.map((item, i) => {
              const active = i === highlight;
              const isSel = item.value === value;
              return (
                <li
                  key={item.value}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus, avoid blur before click
                    pick(item);
                  }}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] ${
                    active ? "bg-brand-soft" : ""
                  }`}
                >
                  <Icon
                    name="check"
                    size={14}
                    className={`shrink-0 ${isSel ? "text-brand" : "text-transparent"}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{item.label}</span>
                  {item.sublabel && (
                    <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{item.sublabel}</span>
                  )}
                </li>
              );
            })}
            {results.length === 0 && (
              <li className="px-3 py-6 text-center text-[12px] text-text-tertiary">{emptyText}</li>
            )}
          </ul>
          {total > results.length && (
            <div className="border-t border-border-subtle px-3 py-2 text-center text-[11px] text-text-tertiary">
              Mostrando {results.length} de {total} — escribe para afinar la búsqueda
            </div>
          )}
        </div>
      )}
    </div>
  );
}
