"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { Nap, Paged, BranchOpt, VlanOpt } from "@/lib/network";

export default function NapsPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [branches, setBranches] = useState<BranchOpt[] | null>(null);
  const [branch, setBranch] = useState<BranchOpt | null>(null);
  const [sedeSearch, setSedeSearch] = useState("");

  const loadBranches = useCallback(async () => {
    setBranches(await (await authFetch("/network/branches")).json());
  }, [authFetch]);

  useEffect(() => {
    if (!authLoading) void loadBranches().catch(() => setBranches([]));
  }, [authLoading, loadBranches]);

  if (authLoading || !branches) return <PageSkeleton />;

  // Vista B: cajas NAP de la sede seleccionada.
  if (branch) {
    return <BranchNaps branch={branch} onBack={() => { setBranch(null); void loadBranches(); }} />;
  }

  // Vista A: selector de sede (tabla).
  const totalNaps = branches.reduce((a, b) => a + b.naps, 0);
  const list = sedeSearch.trim()
    ? branches.filter((b) => b.name.toLowerCase().includes(sedeSearch.trim().toLowerCase()))
    : branches;

  return (
    <>
      <div className="mb-4">
        <PageHeading icon="git-branch" title="Cajas NAP" subtitle="" />
      </div>
      <div className="mb-3 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-bold text-text-primary">Cajas NAP por sede</h1>
          <p className="text-[12px] text-text-tertiary">{totalNaps.toLocaleString("es-CO")} cajas en {branches.length} sedes · elige una sede</p>
        </div>
        <div className="relative w-56">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar sede…" value={sedeSearch} onChange={(e) => setSedeSearch(e.target.value)} />
        </div>
      </div>

      <DataTable
        rows={list}
        empty="Sin sedes."
        onRowClick={(b) => setBranch(b)}
        columns={[
          { key: "name", header: "Sede", render: (b) => (
            <span className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-soft text-brand"><Icon name="landmark" size={15} /></span>
              <span className="font-semibold text-text-primary">{b.name}</span>
            </span>
          ) },
          { key: "naps", header: "Cajas NAP", align: "right", render: (b) => <span className="font-mono font-semibold">{b.naps.toLocaleString("es-CO")}</span> },
          { key: "go", header: "", align: "right", render: () => <Icon name="chevron-right" size={16} className="text-text-tertiary" /> },
        ]}
      />
    </>
  );
}

function BranchNaps({ branch, onBack }: { branch: BranchOpt; onBack: () => void }) {
  const { authFetch } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<Paged<Nap> | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "vlan">("name");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, branchId: branch.id });
    if (search.trim()) qs.set("search", search.trim());
    try {
      setData(await (await authFetch(`/network/naps?${qs}`)).json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, branch.id, page, pageSize, sort, search]);

  useEffect(() => {
    const t = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    setPage(1);
  }, [search, sort, pageSize]);

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-default text-text-secondary hover:bg-surface-2" title="Volver a sedes"><Icon name="arrow-left" size={16} /></button>
          <div>
            <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-primary"><Icon name="landmark" size={18} className="text-brand" /> {branch.name}</h1>
            <p className="text-[12px] text-text-tertiary">{data ? `${(data.total ?? 0).toLocaleString("es-CO")} cajas NAP en esta sede` : "Cajas NAP"}</p>
          </div>
        </div>
        <Button onClick={() => setCreating(true)}><Icon name="plus" size={15} /> Nueva NAP</Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar NAP por nombre…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as "name" | "vlan")} className="w-auto">
          <option value="name">Ordenar: Nombre</option>
          <option value="vlan">Ordenar: VLAN</option>
        </Select>
      </div>

      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="Esta sede aún no tiene cajas NAP."
            onRowClick={(r) => router.push(`/red/naps/${r.id}`)}
            columns={[
              { key: "name", header: "NAP", render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "vlan", header: "VLAN", align: "right", render: (r) => r.vlan != null ? <span className="font-mono text-text-secondary">{r.vlan}</span> : "—" },
              { key: "ports", header: "Puertos", align: "right", render: (r) => <span className="font-mono">{r.portsRegistered}/{r.portCount}</span> },
              { key: "addr", header: "Dirección", render: (r) => <span className="text-text-secondary">{r.address || "—"}</span> },
              { key: "go", header: "", align: "right", render: () => <Icon name="chevron-right" size={16} className="text-text-tertiary" /> },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
            </div>
          )}
        </>
      )}

      <CreateNapModal
        open={creating}
        branch={branch}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); setPage(1); void load(); }}
      />
    </>
  );
}

function CreateNapModal({ open, branch, onClose, onCreated }: { open: boolean; branch: BranchOpt; onClose: () => void; onCreated: () => void }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState("");
  const [vlanId, setVlanId] = useState("");
  const [vlans, setVlans] = useState<VlanOpt[]>([]);
  const [portCount, setPortCount] = useState("16");
  const [address, setAddress] = useState("");
  const [gps, setGps] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Al abrir: reinicia el formulario y carga las VLANs de la sede.
  useEffect(() => {
    if (!open) return;
    setName(""); setVlanId(""); setPortCount("16"); setAddress(""); setGps(""); setErr(null);
    void authFetch(`/network/vlans?branchId=${branch.id}`).then((r) => r.json()).then(setVlans).catch(() => setVlans([]));
  }, [open, branch.id, authFetch]);

  async function submit() {
    setErr(null);
    if (!name.trim()) { setErr("Escribe un nombre para la NAP."); return; }
    const ports = Number(portCount);
    if (!Number.isInteger(ports) || ports < 1 || ports > 256) { setErr("Puertos debe ser un número entre 1 y 256."); return; }
    let gpsLat: string | undefined, gpsLng: string | undefined;
    if (gps.trim()) {
      const [lat, lng] = gps.split(",").map((s) => s.trim());
      if (!lat || !lng) { setErr("GPS debe ser 'latitud, longitud'."); return; }
      gpsLat = lat; gpsLng = lng;
    }
    setSaving(true);
    try {
      const res = await authFetch("/network/naps", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), branchId: branch.id, vlanId: vlanId || undefined, portCount: ports, address: address.trim() || undefined, gpsLat, gpsLng }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la NAP");
      toast(`NAP "${d.name}" creada con ${d.ports} puertos`);
      onCreated();
    } catch (e: any) {
      setErr(e?.message || "No se pudo crear la NAP");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Nueva caja NAP · ${branch.name}`}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nombre" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="NAP-01" /></Field>
        <Field label="Puertos" required><Input type="number" min={1} max={256} value={portCount} onChange={(e) => setPortCount(e.target.value)} /></Field>
        <Field label="VLAN">
          <Select value={vlanId} onChange={(e) => setVlanId(e.target.value)}>
            <option value="">Sin VLAN</option>
            {vlans.map((v) => <option key={v.id} value={v.id}>VLAN {v.vlan}{v.detail ? ` · ${v.detail}` : ""}</option>)}
          </Select>
        </Field>
        <Field label="GPS (opcional)"><Input value={gps} onChange={(e) => setGps(e.target.value)} placeholder="4.60971, -74.08175" /></Field>
        <div className="sm:col-span-2"><Field label="Dirección"><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Poste / referencia" /></Field></div>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" size="sm" disabled={saving} onClick={submit}>
          <Icon name="check" size={13} /> {saving ? "Creando…" : "Crear NAP"}
        </Button>
      </div>
    </Modal>
  );
}
