"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { IpPoolModal, type IpPool } from "@/components/network/IpPoolModal";
import { useAuth } from "@/context/AuthProvider";

function profileList(s: string): string[] {
  return s.split(",").map((p) => p.trim()).filter(Boolean);
}

export default function IpsPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<IpPool[] | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<IpPool | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback((q: string) => {
    const qs = q.trim() ? `?search=${encodeURIComponent(q.trim())}` : "";
    void authFetch(`/network/ip-pools${qs}`).then((r) => (r.ok ? r.json() : [])).then(setRows).catch(() => setRows([]));
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(() => load(search), 250);
    return () => clearTimeout(t);
  }, [authLoading, search, load]);

  const abrir = (pool: IpPool | null) => { setEditing(pool); setModalOpen(true); };

  /** Predeterminado de la sede: solo puede haber uno, como en el legacy. */
  const marcarDefecto = async (pool: IpPool) => {
    const r = await authFetch(`/network/ip-pools/${pool.id}/default`, { method: "PUT" });
    if (r.ok) {
      toast(`"${pool.name}" es ahora el pool predeterminado de ${pool.branch ?? "la sede"}.`, "check");
      load(search);
    } else {
      toast("No se pudo marcar como predeterminado.", "x");
    }
  };

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <PageHeading
        icon="network"
        title="IPs de usuarios"
        subtitle="Pools de direcciones IP configurados por Mikrotik: rango local/remoto y perfiles PPPoE disponibles."
      />

      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar por nombre, IP o tecnología…"
        actions={
          <Button onClick={() => abrir(null)}>
            <Icon name="plus" size={15} />
            Nuevo pool
          </Button>
        }
      />

      <PagedTable
        rows={rows ?? []}
        loading={rows === null}
        loadingText="Cargando…"
        empty="Sin pools de IP configurados."
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
          {
            key: "acciones",
            header: "",
            render: (r: IpPool) => (
              <div className="flex justify-end gap-1">
                {!r.isDefault && (
                  <Button variant="ghost" size="sm" onClick={() => void marcarDefecto(r)} title="Marcar como predeterminado de la sede">
                    <Icon name="flag" size={14} />
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => abrir(r)} title="Editar">
                  <Icon name="pencil" size={14} />
                </Button>
              </div>
            ),
          },
        ]}
      />

      <IpPoolModal
        open={modalOpen}
        pool={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => load(search)}
      />
    </div>
  );
}
