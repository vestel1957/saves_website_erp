"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { TabBar, type Tab } from "@/components/accounting/TabBar";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import type { NetStats, Mikrotik, Olt, Nap, Paged } from "@/lib/network";

type RedTab = "mikrotiks" | "olts" | "naps";

function Stat({ label, value, sub, icon, tone = "text-text-primary" }: { label: string; value: string; sub?: string; icon: string; tone?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name={icon} size={17} /></span>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
        <span className={`text-[17px] font-bold ${tone}`}>{value}</span>
        {sub && <span className="text-[10px] text-text-tertiary">{sub}</span>}
      </div>
    </div>
  );
}

export default function RedPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<NetStats | null>(null);
  const [mks, setMks] = useState<Mikrotik[]>([]);
  const [olts, setOlts] = useState<Olt[]>([]);
  const [naps, setNaps] = useState<Paged<Nap> | null>(null);
  const [tab, setTab] = useState<RedTab>("mikrotiks");

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/stats").then((r) => r.json()).then(setStats).catch(() => {});
    void authFetch("/network/mikrotiks").then((r) => r.json()).then(setMks).catch(() => {});
    void authFetch("/network/olts").then((r) => r.json()).then(setOlts).catch(() => {});
    void authFetch("/network/naps?pageSize=10").then((r) => r.json()).then(setNaps).catch(() => {});
  }, [authLoading, authFetch]);

  if (authLoading || !stats) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <PageHeading icon="activity" title="Red / ISP" subtitle="Infraestructura Mikrotik, OLT/ONU, NAPs y equipos" />
        <div className="flex gap-2">
          <Link href="/red/onus" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"><Icon name="activity" size={14} /> ONUs</Link>
          <Link href="/red/equipos" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"><Icon name="boxes" size={14} /> Equipos</Link>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Mikrotiks" value={String(stats.mikrotiks)} icon="gauge" />
        <Stat label="OLTs" value={String(stats.olts)} icon="activity" />
        <Stat label="ONUs" value={stats.onus.toLocaleString("es-CO")} icon="wand-sparkles" />
        <Stat label="NAPs" value={stats.naps.toLocaleString("es-CO")} icon="git-branch" />
        <Stat label="Puertos" value={stats.ports.toLocaleString("es-CO")} sub={`${stats.portsUsed} usados · ${stats.portsFree} libres`} icon="list" />
        <Stat label="Equipos" value={stats.equipment.toLocaleString("es-CO")} sub={`${stats.equipAssigned} asignados`} icon="boxes" />
      </div>

      <TabBar
        tabs={[
          { key: "mikrotiks", label: `Mikrotiks · ${mks.length}` },
          { key: "olts", label: `OLTs · ${olts.length}` },
          { key: "naps", label: `NAPs · ${(naps?.total ?? 0).toLocaleString("es-CO")}` },
        ] satisfies Tab<RedTab>[]}
        active={tab}
        onChange={setTab}
      />

      <div className="mt-4">
        {tab === "mikrotiks" && (
          <DataTable rows={mks} empty="Sin Mikrotiks." columns={[
            { key: "name", header: "Nombre", render: (r) => <span className="font-medium text-text-primary">{r.name}{r.isDefault && <span className="ml-1 text-[10px] text-brand">★</span>}</span> },
            { key: "ip", header: "IP:Puerto", render: (r) => <span className="font-mono text-text-secondary">{r.ip}:{r.port}</span> },
            { key: "tech", header: "Tec.", render: (r) => r.tech },
            { key: "branch", header: "Sede", render: (r) => r.branch ?? "—" },
            { key: "st", header: "Estado", render: (r) => <Badge label={r.online ? "Online" : "Offline"} tone={r.online ? "success" : "error"} /> },
          ]} />
        )}

        {tab === "olts" && (
          <DataTable rows={olts} empty="Sin OLTs." columns={[
            { key: "name", header: "Nombre", render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
            { key: "brand", header: "Marca", render: (r) => r.brand },
            { key: "ip", header: "IP", render: (r) => <span className="font-mono text-text-secondary">{r.ip}</span> },
            { key: "onus", header: "ONUs", align: "right", render: (r) => r.onus.toLocaleString("es-CO") },
            { key: "st", header: "Estado", render: (r) => <Badge label={r.online ? "Online" : "Offline"} tone={r.online ? "success" : "error"} /> },
          ]} />
        )}

        {tab === "naps" && (
          <>
            <div className="mb-2 flex items-center justify-end">
              <Link href="/red/naps" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"><Icon name="git-branch" size={14} /> Gestionar cajas NAP</Link>
            </div>
            <DataTable rows={naps?.items ?? []} empty="Sin NAPs." onRowClick={(r) => { window.location.href = `/red/naps/${r.id}`; }} columns={[
              { key: "name", header: "NAP", render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "branch", header: "Sede", render: (r) => r.branch ?? "—" },
              { key: "vlan", header: "VLAN", render: (r) => r.vlan ?? "—" },
              { key: "ports", header: "Puertos", align: "right", render: (r) => `${r.portsRegistered}/${r.portCount}` },
              { key: "addr", header: "Dirección", render: (r) => <span className="text-text-secondary">{r.address}</span> },
            ]} />
            {naps && <p className="mt-1 text-[11px] text-text-tertiary">{naps.total.toLocaleString("es-CO")} NAPs en total. Muestra de {naps.items.length}.</p>}
          </>
        )}
      </div>
    </>
  );
}
