"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Mat = { id: string; name: string; code: string | null; price: number; qty: number; warehouse: string | null };
type Line = { material: Mat; qty: number };

/** Modal para registrar material consumido en la orden (descuenta stock). */
export function ConsumirMaterialModal({ open, onClose, onDone, ticketId }: { open: boolean; onClose: () => void; onDone: () => void; ticketId: string }) {
  const { authFetch } = useAuth();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Mat[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch(""); setResults([]); setLines([]); setErr(null);
  }, [open]);

  // Búsqueda con debounce.
  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    const h = setTimeout(() => {
      void authFetch(`/support/materials/search?search=${encodeURIComponent(q)}`).then((r) => r.json()).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(h);
  }, [search, open, authFetch]);

  function add(m: Mat) {
    setLines((prev) => (prev.some((l) => l.material.id === m.id) ? prev : [...prev, { material: m, qty: 1 }]));
  }
  function setQty(id: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.material.id === id ? { ...l, qty: Math.max(1, Math.min(l.material.qty, qty || 1)) } : l)));
  }
  function remove(id: string) {
    setLines((prev) => prev.filter((l) => l.material.id !== id));
  }

  const total = lines.reduce((s, l) => s + l.material.price * l.qty, 0);

  async function submit() {
    setErr(null);
    if (!lines.length) { setErr("Agrega al menos un material."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/support/tickets/${ticketId}/materials`, {
        method: "POST",
        body: JSON.stringify({ items: lines.map((l) => ({ materialId: l.material.id, qty: l.qty })) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo registrar el material");
      toast("Material registrado (stock descontado)");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar material consumido" maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar material por nombre o código…" autoFocus />
          {results.length > 0 && (
            <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-border-subtle bg-surface shadow-sm">
              {results.map((m) => (
                <button key={m.id} type="button" onClick={() => add(m)}
                  className="flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-left text-[13px] last:border-0 hover:bg-surface-2">
                  <span className="min-w-0">
                    <span className="font-medium text-text-primary">{m.name}</span>
                    {m.code && <span className="ml-1 font-mono text-[11px] text-text-tertiary">{m.code}</span>}
                    <span className="ml-1 text-[11px] text-text-tertiary">· stock {m.qty}{m.warehouse ? ` · ${m.warehouse}` : ""}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-text-secondary">{cop(m.price)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Carrito */}
        {lines.length ? (
          <div className="rounded-lg border border-border-subtle">
            {lines.map((l) => (
              <div key={l.material.id} className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-0">
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{l.material.name}</span>
                <Input value={String(l.qty)} onChange={(e) => setQty(l.material.id, Number(e.target.value))} inputMode="numeric" className="w-16 text-center" />
                <span className="w-24 shrink-0 text-right text-[12px] text-text-secondary">{cop(l.material.price * l.qty)}</span>
                <button type="button" onClick={() => remove(l.material.id)} className="text-error-text hover:opacity-70"><Icon name="trash" size={14} /></button>
              </div>
            ))}
            <div className="flex items-center justify-between px-3 py-2 text-[13px] font-bold text-text-primary">
              <span>Total</span><span>{cop(total)}</span>
            </div>
          </div>
        ) : <p className="rounded-lg border border-dashed border-border-subtle px-3 py-4 text-center text-[12px] text-text-tertiary">Busca y agrega los materiales usados en la orden.</p>}

        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !lines.length}>{saving ? "Registrando…" : "Registrar y descontar"}</Button>
        </div>
      </div>
    </Modal>
  );
}
