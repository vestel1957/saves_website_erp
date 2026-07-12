"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

type IpPool = {
  id: string;
  name: string;
  ipLocal: string;
  ipRemote: string;
  tech: string;
  isDefault: boolean;
  profiles: string;
  branch: string | null;
};

function profileList(s: string): string[] {
  return s.split(",").map((p) => p.trim()).filter(Boolean);
}

export default function IpsPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<IpPool[] | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback((q: string) => {
    const qs = q.trim() ? `?search=${encodeURIComponent(q.trim())}` : "";
    void authFetch(`/network/ip-pools${qs}`).then((r) => (r.ok ? r.json() : [])).then(setRows).catch(() => setRows([]));
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(() => load(search), 250);
    return () => clearTimeout(t);
  }, [authLoading, search, load]);

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <PageHeading
        icon="network"
        title="IPs de usuarios"
        subtitle="Pools de direcciones IP configurados por Mikrotik: rango local/remoto y perfiles PPPoE disponibles."
      />

      <div className="relative max-w-sm">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"><Icon name="search" size={15} /></span>
        <Input className="pl-9" placeholder="Buscar por nombre, IP o tecnología…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <DataTable
        autoHeight
        rows={rows ?? []}
        empty={rows === null ? "Cargando…" : "Sin pools de IP configurados."}
        columns={[
          {
            key: "name",
            header: "Pool",
            render: (r: IpPool) => (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-text-primary">{r.name}</span>
                {r.isDefault && <Badge tone="info" label="Predeterminado" />}
              </div>
            ),
          },
          { key: "branch", header: "Sede", render: (r: IpPool) => <span className="text-text-secondary">{r.branch ?? "—"}</span> },
          { key: "tech", header: "Tecnología", render: (r: IpPool) => <span className="text-text-secondary">{r.tech || "—"}</span> },
          { key: "ipLocal", header: "IP local", render: (r: IpPool) => <span className="font-mono text-[12px] text-text-secondary">{r.ipLocal || "—"}</span> },
          { key: "ipRemote", header: "IP remota", render: (r: IpPool) => <span className="font-mono text-[12px] text-text-secondary">{r.ipRemote || "—"}</span> },
          {
            key: "profiles",
            header: "Perfiles",
            render: (r: IpPool) => {
              const list = profileList(r.profiles);
              return <span className="text-text-tertiary">{list.length} perfil(es)</span>;
            },
          },
        ]}
      />
    </div>
  );
}
