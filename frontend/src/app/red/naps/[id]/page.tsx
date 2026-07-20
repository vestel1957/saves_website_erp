"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import type { Nap, NapPort, Paged } from "@/lib/network";

function InfoCell({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
      <span className={`text-[13px] text-text-primary ${mono ? "font-mono" : "font-medium"}`}>{value}</span>
    </div>
  );
}

export default function NapDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [nap, setNap] = useState<Nap | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [ports, setPorts] = useState<NapPort[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(true);

  const [assignFor, setAssignFor] = useState<NapPort | null>(null);
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [saving, setSaving] = useState(false);

  const loadNap = useCallback(async () => {
    const res = await authFetch(`/network/naps/${id}`);
    if (!res.ok) { setNotFound(true); return; }
    setNap(await res.json());
  }, [authFetch, id]);

  const loadPorts = useCallback(async () => {
    setLoadingPorts(true);
    try {
      const d: Paged<NapPort> = await (await authFetch(`/network/ports?napId=${id}&pageSize=100`)).json();
      setPorts([...(d.items ?? [])].sort((a, b) => a.port - b.port));
    } finally {
      setLoadingPorts(false);
    }
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading) return;
    void loadNap();
    void loadPorts();
  }, [authLoading, loadNap, loadPorts]);

  const free = useCallback(async (row: NapPort) => {
    try {
      const res = await authFetch(`/network/ports/${row.id}/free`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Puerto liberado");
      void loadPorts();
    } catch (e: any) {
      toast(e?.message || "No se pudo liberar", "alert-triangle");
    }
  }, [authFetch, loadPorts]);

  const confirmAssign = useCallback(async () => {
    if (!assignFor || !sub) return;
    setSaving(true);
    try {
      const res = await authFetch(`/network/ports/${assignFor.id}/assign`, { method: "POST", body: JSON.stringify({ subscriberId: sub.id }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Cliente asignado al puerto");
      setAssignFor(null);
      setSub(null);
      void loadPorts();
    } catch (e: any) {
      toast(e?.message || "No se pudo asignar", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [assignFor, sub, authFetch, loadPorts]);

  if (authLoading || (!nap && !notFound)) return <PageSkeleton />;

  if (notFound) {
    return (
      <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center">
        <p className="text-[13px] text-text-tertiary">No se encontró la caja NAP.</p>
        <Link href="/red/naps" className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand hover:underline"><Icon name="arrow-left" size={14} /> Volver a Cajas NAP</Link>
      </div>
    );
  }

  const occupied = ports.filter((p) => p.status === "Ocupado").length;

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <Link href="/red/naps" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-default text-text-secondary hover:bg-surface-2" title="Volver a cajas NAP"><Icon name="arrow-left" size={16} /></Link>
        <div>
          <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-primary"><Icon name="git-branch" size={18} className="text-brand" /> {nap!.name}</h1>
          <p className="text-[12px] text-text-tertiary">{nap!.branch ?? "Sin sede"}{nap!.vlan != null ? ` · VLAN ${nap!.vlan}` : ""}</p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 rounded-xl border border-border-subtle bg-surface px-5 py-4 shadow-sm sm:grid-cols-4 lg:grid-cols-6">
        <InfoCell label="Sede" value={nap!.branch ?? "—"} />
        <InfoCell label="VLAN" value={nap!.vlan != null ? nap!.vlan : "—"} mono />
        <InfoCell label="Puertos" value={`${occupied}/${nap!.portCount} ocupados`} />
        <InfoCell label="Registrados" value={`${nap!.portsRegistered}/${nap!.portCount}`} mono />
        <div className="col-span-2"><InfoCell label="Dirección" value={nap!.address || "—"} /></div>
        {nap!.gps && (
          <div className="col-span-2 sm:col-span-4 lg:col-span-6">
            <InfoCell label="GPS" value={
              <a className="text-brand hover:underline" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${nap!.gps.lat},${nap!.gps.lng}`}>{nap!.gps.lat}, {nap!.gps.lng}</a>
            } />
          </div>
        )}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-bold text-text-primary">Puertos</div>
        <div className="text-[11px] text-text-tertiary">{occupied} ocupados · {ports.length - occupied} libres</div>
      </div>

      {loadingPorts && !ports.length ? (
        <PageSkeleton />
      ) : (
        <DataTable
          rows={ports}
          empty="Esta NAP no tiene puertos registrados."
          columns={[
            { key: "port", header: "Puerto", render: (r) => <span className="font-mono font-semibold text-text-primary">{r.port}</span> },
            { key: "status", header: "Estado", render: (r) => <Badge label={r.status ?? "—"} tone={r.status === "Ocupado" ? "success" : "default"} /> },
            {
              key: "client", header: "Cliente asignado",
              render: (r) => r.client ? (
                <span className="flex items-center gap-2">
                  {r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span className="text-text-primary">{r.client}</span>}
                  {r.abonado != null && <span className="font-mono text-[11px] text-text-tertiary">#{r.abonado}</span>}
                </span>
              ) : <span className="text-text-tertiary">— libre</span>,
            },
            { key: "detail", header: "Detalle", render: (r) => <span className="text-text-secondary">{r.detail || "—"}</span> },
            {
              key: "acc", header: "Acción", align: "right",
              render: (r) => r.status === "Ocupado" ? (
                <Button variant="danger" size="sm" onClick={() => free(r)}><Icon name="x" size={13} /> Liberar</Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => { setAssignFor(r); setSub(null); }}><Icon name="user" size={13} /> Asignar</Button>
              ),
            },
          ]}
        />
      )}

      <Modal
        open={!!assignFor}
        onClose={() => { setAssignFor(null); setSub(null); }}
        title={assignFor ? `Asignar cliente al puerto ${assignFor.port}` : "Asignar cliente"}
      >
        <Field label="Cliente" required>
          <SubscriberPicker value={sub} onChange={setSub} />
        </Field>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setAssignFor(null); setSub(null); }}>Cancelar</Button>
          <Button variant="primary" size="sm" disabled={!sub || saving} onClick={confirmAssign}>
            <Icon name="check" size={13} /> {saving ? "Asignando…" : "Asignar"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
