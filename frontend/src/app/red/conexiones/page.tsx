"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Combobox, type ComboItem } from "@/components/ui/Combobox";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";

export default function ConexionesPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [napId, setNapId] = useState("");
  const [branches, setBranches] = useState<{ id: string; name: string; naps: number }[]>([]);
  const [napOptions, setNapOptions] = useState<ComboItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);

  const [assignFor, setAssignFor] = useState<any>(null);
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (status) qs.set("status", status);
    if (branchId) qs.set("branchId", branchId);
    if (napId) qs.set("napId", napId);
    try {
      setData(await (await authFetch(`/network/ports?${qs}`)).json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, page, pageSize, search, status, branchId, napId]);

  useEffect(() => {
    if (!authLoading) {
      const t = setTimeout(load, search ? 350 : 0);
      return () => clearTimeout(t);
    }
  }, [authLoading, load, search]);

  useEffect(() => {
    setPage(1);
  }, [search, status, branchId, napId, pageSize]);

  // Sedes (para el filtro).
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/branches").then((r) => (r.ok ? r.json() : [])).then(setBranches).catch(() => {});
  }, [authLoading, authFetch]);

  // NAPs para el combobox, acotadas a la sede elegida. Al cambiar de sede se limpia la NAP.
  useEffect(() => {
    if (authLoading) return;
    setNapId("");
    const qs = branchId ? `?branchId=${branchId}` : "";
    void authFetch(`/network/nap-options${qs}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { id: string; name: string }[]) => setNapOptions(rows.map((n) => ({ value: n.id, label: n.name }))))
      .catch(() => {});
  }, [authLoading, authFetch, branchId]);

  const free = useCallback(
    async (row: any) => {
      try {
        const res = await authFetch(`/network/ports/${row.id}/free`, { method: "POST" });
        const d = await res.json();
        if (!res.ok) throw new Error(d?.message || "Error");
        toast("Puerto liberado");
        void load();
      } catch (e: any) {
        toast(e?.message || "No se pudo liberar", "alert-triangle");
      }
    },
    [authFetch, load],
  );

  const openAssign = useCallback((row: any) => {
    setAssignFor(row);
    setSub(null);
  }, []);

  const confirmAssign = useCallback(async () => {
    if (!assignFor || !sub) return;
    setSaving(true);
    try {
      const res = await authFetch(`/network/ports/${assignFor.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ subscriberId: sub.id }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Cliente asignado al puerto");
      setAssignFor(null);
      setSub(null);
      void load();
    } catch (e: any) {
      toast(e?.message || "No se pudo asignar", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [assignFor, sub, authFetch, load]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4">
        <PageHeading
          icon="activity"
          title="Conexiones"
          subtitle={
            data?.counts
              ? `${(data.counts.scope ?? 0).toLocaleString("es-CO")} puertos · ${(data.counts.ocupados ?? 0).toLocaleString("es-CO")} ocupados · ${(data.counts.libres ?? 0).toLocaleString("es-CO")} libres`
              : "Puertos NAP"
          }
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <Input
            className="pl-9"
            placeholder="Buscar por puerto, NAP o cliente…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
          <option value="">Todas las sedes</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </Select>
        <div className="min-w-[220px]">
          <Combobox
            items={napOptions}
            value={napId}
            onChange={setNapId}
            icon="git-branch"
            placeholder={branchId ? "Filtrar por NAP…" : "NAP (todas las sedes)…"}
            emptyText="Sin NAPs."
          />
        </div>
        {napId && (
          <Button variant="ghost" size="sm" onClick={() => setNapId("")}>
            <Icon name="x" size={13} /> NAP
          </Button>
        )}
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          <option value="Disponible">Disponible</option>
          <option value="Ocupado">Ocupado</option>
        </Select>
      </div>

      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron puertos."
            columns={[
              {
                key: "port",
                header: "Puerto",
                render: (r: any) => <span className="font-mono text-text-secondary">{r.port}</span>,
              },
              { key: "nap", header: "NAP", render: (r: any) => r.nap ?? "—" },
              {
                key: "status",
                header: "Estado",
                render: (r: any) => (
                  <Badge label={r.status ?? "—"} tone={r.status === "Ocupado" ? "success" : "default"} />
                ),
              },
              {
                key: "client",
                header: "Cliente",
                render: (r: any) =>
                  r.client ? (
                    <span className="flex items-center gap-2">
                      {r.subscriberId ? (
                        <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">
                          {r.client}
                        </Link>
                      ) : (
                        <span className="text-text-primary">{r.client}</span>
                      )}
                      {r.abonado != null && (
                        <span className="font-mono text-[11px] text-text-tertiary">#{r.abonado}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-text-tertiary">— libre</span>
                  ),
              },
              {
                key: "acc",
                header: "Acción",
                align: "right",
                render: (r: any) =>
                  r.status === "Ocupado" ? (
                    <Button variant="danger" size="sm" onClick={() => free(r)}>
                      <Icon name="x" size={13} /> Liberar
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => openAssign(r)}>
                      <Icon name="user" size={13} /> Asignar
                    </Button>
                  ),
              },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination
                meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      <Modal
        open={!!assignFor}
        onClose={() => {
          setAssignFor(null);
          setSub(null);
        }}
        title={assignFor ? `Asignar cliente al puerto ${assignFor.port}` : "Asignar cliente"}
      >
        <Field label="Cliente" required>
          <SubscriberPicker value={sub} onChange={setSub} />
        </Field>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAssignFor(null);
              setSub(null);
            }}
          >
            Cancelar
          </Button>
          <Button variant="primary" size="sm" disabled={!sub || saving} onClick={confirmAssign}>
            <Icon name="check" size={13} /> {saving ? "Asignando…" : "Asignar"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
