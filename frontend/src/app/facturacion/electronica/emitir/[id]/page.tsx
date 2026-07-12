"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type SortState } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { SUB_STATUS_LABEL, SUB_STATUS_TONE } from "@/lib/subscribers";

type Client = {
  id: string; abonado: number; name: string; docType: string | null; docNumber: string | null;
  status: string | null; eInvoiceTv: boolean; eInvoiceInternet: boolean;
  tvPlan: string | null; internetPlan: string | null;
};
type ClientList = { items: Client[]; total: number; page: number; pageSize: number; pages: number };

/** Check de cabecera "seleccionar todos" con estado indeterminado (algunos marcados). */
function ColSelectAll({ label, icon, allOn, indeterminate, disabled, onToggle }: {
  label: string; icon: string; allOn: boolean; indeterminate: boolean; disabled: boolean; onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <label className="inline-flex cursor-pointer items-center justify-center gap-1.5" title={`Seleccionar todos (${label})`}>
      <input ref={ref} type="checkbox" className="h-4 w-4 cursor-pointer accent-brand disabled:opacity-50" checked={allOn} disabled={disabled} onChange={onToggle} />
      <span className="inline-flex items-center gap-1"><Icon name={icon} size={13} /> {label}</span>
    </label>
  );
}

export default function ClientesDeSedePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);

  const [branchName, setBranchName] = useState<string>("");
  const [data, setData] = useState<ClientList | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ by: "name", dir: "asc" });
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bulking, setBulking] = useState(false);

  useEffect(() => {
    if (authLoading || !canEmit) return;
    void authFetch("/einvoice/branches").then((r) => (r.ok ? r.json() : []))
      .then((bs: { id: string; name: string }[]) => setBranchName(bs.find((b) => b.id === id)?.name ?? "Sede"))
      .catch(() => {});
  }, [authLoading, canEmit, authFetch, id]);

  const loadClients = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: "50", sort: sort.by, dir: sort.dir });
    if (search.trim()) qs.set("search", search.trim());
    try {
      setData(await (await authFetch(`/einvoice/branches/${id}/subscribers?${qs}`)).json());
    } finally {
      setLoading(false);
    }
  }, [id, page, search, sort, authFetch]);

  useEffect(() => {
    if (authLoading || !canEmit) return;
    const t = setTimeout(loadClients, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [authLoading, canEmit, loadClients, search]);

  useEffect(() => { setPage(1); }, [search]);

  function handleSort(key: string) {
    setSort((s) => (s.by === key ? { by: key, dir: s.dir === "asc" ? "desc" : "asc" } : { by: key, dir: "asc" }));
    setPage(1);
  }

  function patchRow(rowId: string, patch: Partial<Client>) {
    setData((d) => d && { ...d, items: d.items.map((c) => (c.id === rowId ? { ...c, ...patch } : c)) });
  }

  async function toggle(row: Client, service: "tv" | "internet", value: boolean) {
    const field = service === "tv" ? "eInvoiceTv" : "eInvoiceInternet";
    patchRow(row.id, { [field]: value } as Partial<Client>);
    setSavingId(row.id);
    try {
      const res = await authFetch(`/einvoice/subscribers/${row.id}/eflags`, { method: "PATCH", body: JSON.stringify({ [service]: value }) });
      if (!res.ok) throw new Error();
    } catch {
      patchRow(row.id, { [field]: !value } as Partial<Client>);
      toast("No se pudo guardar la selección", "x");
    } finally {
      setSavingId(null);
    }
  }

  async function bulk(service: "tv" | "internet") {
    if (!data?.items.length) return;
    const field = service === "tv" ? "eInvoiceTv" : "eInvoiceInternet";
    const value = !data.items.every((c) => c[field]);
    const ids = data.items.map((c) => c.id);
    const prev = data.items.map((c) => ({ id: c.id, v: c[field] as boolean }));
    setData((d) => d && { ...d, items: d.items.map((c) => ({ ...c, [field]: value })) });
    setBulking(true);
    try {
      const res = await authFetch("/einvoice/eflags-bulk", { method: "POST", body: JSON.stringify({ subscriberIds: ids, service, value }) });
      if (!res.ok) throw new Error();
      toast(`${ids.length} cliente(s) ${value ? "marcados" : "desmarcados"} en ${service === "tv" ? "TV" : "Internet"}`, "check");
    } catch {
      setData((d) => d && { ...d, items: d.items.map((c) => ({ ...c, [field]: prev.find((p) => p.id === c.id)?.v ?? c[field] })) });
      toast("No se pudo aplicar la selección en lote", "x");
    } finally {
      setBulking(false);
    }
  }

  if (authLoading) return <PageSkeleton />;
  if (!canEmit) {
    return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Solo contabilidad puede gestionar la facturación electrónica.</div>;
  }

  const items = data?.items ?? [];
  const allTv = items.length > 0 && items.every((c) => c.eInvoiceTv);
  const allInet = items.length > 0 && items.every((c) => c.eInvoiceInternet);
  const someTv = items.some((c) => c.eInvoiceTv);
  const someInet = items.some((c) => c.eInvoiceInternet);

  return (
    <>
      {/* Cabecera compacta: una sola vuelta atrás ("Sedes") + nombre de sede */}
      <div className="mb-3 flex items-center gap-3">
        <Link href="/facturacion/electronica" className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary">
          <Icon name="arrow-left" size={16} /> Sedes
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-bold text-text-primary">{branchName || "Sede"}</h1>
          <p className="text-[11.5px] text-text-tertiary">Marca con el check a quién y qué facturar (TV / Internet). Se guarda al instante.</p>
        </div>
      </div>

      <div className="mb-3">
        <div className="relative max-w-md">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar cliente por nombre, documento o abonado…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            rows={items}
            empty="No hay clientes en esta sede."
            sort={sort}
            onSort={handleSort}
            columns={[
              { key: "abonado", header: "Abonado", sortable: true, sortKey: "abonado", render: (r: Client) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              { key: "name", header: "Cliente", sortable: true, sortKey: "name", render: (r: Client) => (
                <div className="leading-tight">
                  <div className="font-medium text-text-primary">{r.name}</div>
                  {(r.docType || r.docNumber) && <div className="text-[11px] text-text-tertiary">{[r.docType, r.docNumber].filter(Boolean).join(" ")}</div>}
                </div>
              ) },
              { key: "status", header: "Estado", sortable: true, sortKey: "status", render: (r: Client) => r.status
                ? <Badge label={SUB_STATUS_LABEL[r.status] ?? r.status} tone={SUB_STATUS_TONE[r.status] ?? "default"} />
                : <span className="text-text-tertiary">—</span> },
              { key: "tv", align: "left",
                header: <ColSelectAll label="TV" icon="tv" allOn={allTv} indeterminate={someTv && !allTv} disabled={bulking || !items.length} onToggle={() => bulk("tv")} />,
                render: (r: Client) => (
                  <label className="flex cursor-pointer items-center gap-2" title={r.tvPlan ?? "Facturar TV electrónicamente"}>
                    <input type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-brand" checked={r.eInvoiceTv} disabled={savingId === r.id} onChange={(e) => toggle(r, "tv", e.target.checked)} />
                    <span className="max-w-[120px] truncate text-[11px] text-text-tertiary">{r.tvPlan ?? "—"}</span>
                  </label>
                ) },
              { key: "internet", align: "left",
                header: <ColSelectAll label="Internet" icon="wifi" allOn={allInet} indeterminate={someInet && !allInet} disabled={bulking || !items.length} onToggle={() => bulk("internet")} />,
                render: (r: Client) => (
                  <label className="flex cursor-pointer items-center gap-2" title={r.internetPlan ?? "Facturar Internet electrónicamente"}>
                    <input type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-brand" checked={r.eInvoiceInternet} disabled={savingId === r.id} onChange={(e) => toggle(r, "internet", e.target.checked)} />
                    <span className="max-w-[120px] truncate text-[11px] text-text-tertiary">{r.internetPlan ?? "—"}</span>
                  </label>
                ) },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} /></div>
          )}
        </>
      )}
    </>
  );
}
