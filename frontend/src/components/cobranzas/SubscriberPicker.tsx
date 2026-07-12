"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";

export type PickedSub = { id: string; name: string; abonado: number };

/** Buscador de clientes con autocompletar (por nombre/documento/abonado). */
export function SubscriberPicker({
  value, onChange, placeholder = "Buscar cliente por nombre, documento o abonado…",
}: {
  value: PickedSub | null;
  onChange: (s: PickedSub | null) => void;
  placeholder?: string;
}) {
  const { authFetch } = useAuth();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickedSub[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) return; // ya hay selección
    const term = q.trim();
    if (term.length < 2) { setItems([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await authFetch(`/subscribers?search=${encodeURIComponent(term)}&pageSize=8`);
        const d = await r.json();
        setItems((d.items ?? []).map((x: any) => ({ id: x.id, name: x.name, abonado: x.abonado })));
        setOpen(true);
      } finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, value, authFetch]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border-default bg-surface-2 px-3 py-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
          <Icon name="user" size={14} className="text-brand" />
          {value.name} <span className="font-mono text-[11px] text-text-tertiary">#{value.abonado}</span>
        </span>
        <button type="button" onClick={() => { onChange(null); setQ(""); }} className="rounded-md p-1 text-text-tertiary hover:bg-surface hover:text-text-primary">
          <Icon name="x" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
      <Input className="pl-9" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => items.length && setOpen(true)} />
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border-default bg-surface shadow-lg">
          {loading && <div className="px-3 py-2 text-[12px] text-text-tertiary">Buscando…</div>}
          {!loading && items.length === 0 && <div className="px-3 py-2 text-[12px] text-text-tertiary">Sin resultados.</div>}
          {items.map((s) => (
            <button key={s.id} type="button" onClick={() => { onChange(s); setOpen(false); }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2">
              <span className="font-medium text-text-primary">{s.name}</span>
              <span className="font-mono text-[11px] text-text-tertiary">#{s.abonado}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
