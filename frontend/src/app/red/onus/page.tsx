"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/accounting/PageHeading";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { VincularClienteModal } from "@/components/network/VincularClienteModal";
import { rxTone, runTone } from "@/lib/olt";
import type { InvOnu, OltRow, OltMode, Paged } from "@/lib/olt";

export default function InventarioOnusPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [data, setData] = useState<Paged<InvOnu> | null>(null);
  const [olts, setOlts] = useState<OltRow[]>([]);
  const [mode, setMode] = useState<OltMode | null>(null);
  const [search, setSearch] = useState("");
  const [oltId, setOltId] = useState("");
  const [estado, setEstado] = useState("");
  const [senal, setSenal] = useState("");
  const [cliente, setCliente] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [link, setLink] = useState<InvOnu | null>(null);

  const live = !!mode?.live;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/olt/olts").then((r) => r.json()).then(setOlts).catch(() => {});
    void authFetch("/network/olt/mode").then((r) => r.json()).then(setMode).catch(() => {});
  }, [authLoading, authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (oltId) qs.set("oltId", oltId);
    if (estado) qs.set("estado", estado);
    if (senal) qs.set("senal", senal);
    if (cliente) qs.set("cliente", cliente);
    try { setData(await (await authFetch(`/network/olt/inventory?${qs}`)).json()); } finally { setLoading(false); }
  }, [authFetch, page, pageSize, search, oltId, estado, senal, cliente]);

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [search, oltId, estado, senal, cliente, pageSize]);

  const onuAction = async (action: "reboot" | "delete", o: InvOnu) => {
    if (!o.oltId) return;
    if (live && !confirm(`¿Confirmar ${action === "delete" ? "ELIMINAR" : "reiniciar"} la ONU ${o.fsp}:${o.ontId} (SN ${o.sn}) en la OLT REAL?`)) return;
    const r = await authFetch(`/network/olt/${o.oltId}/onu/${action}`, {
      method: "POST", body: JSON.stringify({ frame: o.frame ?? 0, slot: o.slot, port: o.port, ont_id: o.ontId, sn: o.sn }),
    }).then((x) => x.json());
    if (r.ok) toast(r.dryRun ? "Plan generado (dry-run)" : (r.message || "OK"), "check");
    else toast(r.error || "Error", "x");
  };

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <PageHeading icon="wand-sparkles" title="Inventario de ONUs" />
        <div className="flex items-center gap-2">
          {mode && <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} />}
          <Link href="/red/olt"><Button variant="secondary"><Icon name="router" size={15} className="mr-1" />Gestión OLT</Button></Link>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por serial (SN), cliente o descripción…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={oltId} onChange={(e) => setOltId(e.target.value)} className="w-auto">
          <option value="">Todas las OLTs</option>
          {olts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto">
          <option value="">Todo estado</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </Select>
        <Select value={senal} onChange={(e) => setSenal(e.target.value)} className="w-auto">
          <option value="">Toda señal</option>
          <option value="debil">Señal débil (-25..-28)</option>
          <option value="critica">Señal crítica (&lt;-28)</option>
        </Select>
        <Select value={cliente} onChange={(e) => setCliente(e.target.value)} className="w-auto">
          <option value="">Todos</option>
          <option value="con">Con cliente</option>
          <option value="sin">Sin cliente</option>
        </Select>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable rows={data?.items ?? []} empty="No se encontraron ONUs." columns={[
            { key: "sn", header: "Serial (SN)", render: (r) => <span className="font-mono text-text-secondary">{r.sn ?? "—"}</span> },
            { key: "olt", header: "OLT", render: (r) => r.olt ?? "—" },
            { key: "pos", header: "F/S/P (ONT)", render: (r) => <span className="font-mono text-text-tertiary">{r.fsp} ({r.ontId ?? "-"})</span> },
            { key: "client", header: "Cliente", render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span className="text-text-tertiary">sin cliente</span> },
            { key: "rx", header: "RX (dBm)", render: (r) => <Badge label={r.rxPower ?? "—"} tone={rxTone(r.rxPower)} /> },
            { key: "run", header: "Estado", render: (r) => <Badge label={r.runState ?? "—"} tone={runTone(r.runState)} /> },
            { key: "sync", header: "Sync", render: (r) => <Badge label={r.syncState} tone={r.syncState === "presente" ? "success" : "warning"} /> },
            { key: "acc", header: "Acciones", render: (r) => (
              <div className="flex gap-1">
                <button title="Vincular cliente" onClick={() => setLink(r)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="user" size={15} /></button>
                <button title="Reiniciar" onClick={() => onuAction("reboot", r)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-warning-text"><Icon name="rotate-cw" size={15} /></button>
                <button title="Eliminar" onClick={() => onuAction("delete", r)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="trash" size={15} /></button>
              </div>
            ) },
          ]} />
          {data && data.pages > 1 && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </>
      )}

      {link && (
        <VincularClienteModal open onClose={() => setLink(null)} onuId={link.id} sn={link.sn}
          currentClient={link.client} currentSubscriberId={link.subscriberId}
          onDone={load} />
      )}
    </>
  );
}
