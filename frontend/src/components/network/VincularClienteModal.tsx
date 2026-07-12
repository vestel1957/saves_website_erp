"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type Cli = { id: string; abonado: number; nombre: string | null; documento: string | null; celular: string | null };

/** Vincula (o desvincula) una ONU del inventario con un cliente del CRM. */
export function VincularClienteModal({
  open, onClose, onuId, sn, currentClient, currentSubscriberId, onDone,
}: {
  open: boolean;
  onClose: () => void;
  onuId: string;
  sn?: string | null;
  currentClient?: string | null;
  currentSubscriberId?: string | null;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Cli[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setQ(""); setRows([]); } }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(() => {
      void authFetch(`/network/olt/subscribers?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json()).then((d) => setRows(d.clientes ?? [])).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [q, open, authFetch]);

  const link = async (subscriberId: string | null) => {
    setBusy(true);
    try {
      const r = await authFetch(`/network/olt/onus/${onuId}/link`, {
        method: "POST", body: JSON.stringify({ subscriberId }),
      }).then((x) => x.json());
      if (r.ok) { toast(subscriberId ? "Cliente vinculado" : "Vínculo removido", "check"); onDone?.(); onClose(); }
      else { toast("No se pudo vincular", "x"); }
    } catch { toast("Error al vincular", "x"); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Vincular ONU ${sn ?? ""} a cliente`} maxWidth="max-w-lg">
      {currentSubscriberId && (
        <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface-2 p-2 text-[12px]">
          <span>Vinculada a <b>{currentClient}</b></span>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => link(null)}>Desvincular</Button>
        </div>
      )}
      <div className="relative">
        <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <Input autoFocus className="pl-9" placeholder="Buscar por nombre, documento, abonado o teléfono…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {rows.map((c) => (
          <button key={c.id} type="button" disabled={busy} onClick={() => link(c.id)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-surface-2">
            <span className="min-w-0">
              <span className="block truncate font-medium text-text-primary">{c.nombre ?? "—"}</span>
              <span className="block text-[11px] text-text-tertiary">Abonado {c.abonado} · {c.documento ?? "s/doc"} · {c.celular ?? "s/tel"}</span>
            </span>
            <Icon name="link" size={15} className="shrink-0 text-brand" />
          </button>
        ))}
        {q.trim().length >= 2 && !rows.length && <p className="px-2 py-3 text-[12px] text-text-tertiary">Sin resultados.</p>}
      </div>
    </Modal>
  );
}
