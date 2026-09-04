"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Combobox, type ComboItem } from "@/components/ui/Combobox";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { Nap, Paged, BranchOpt, VlanOpt } from "@/lib/network";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { listaJson, mensajeDeError } from "@/lib/errores";

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
          { key: "name", header: "Sede", sortable: true, render: (b) => (
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
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "vlan">("name");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [creating, setCreating] = useState(false);

  // Filtros del listado. Viajan al servidor (el listado pagina allí), así que
  // filtran sobre las 1.398 NAPs y no sólo sobre la página que se está viendo.
  const [vlanId, setVlanId] = useState("");
  const [ocupacion, setOcupacion] = useState("");
  const [address, setAddress] = useState("");
  const [vlans, setVlans] = useState<VlanOpt[]>([]);
  const [barrios, setBarrios] = useState<{ value: string; naps: number }[]>([]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<Paged<Nap>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, branchId: branch.id, ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (vlanId) qs.set("vlanId", vlanId);
      if (ocupacion) qs.set("ocupacion", ocupacion);
      if (address) qs.set("address", address);
      return `/network/naps?${qs}`;
    },
    [branch.id, page, pageSize, sort, search, vlanId, ocupacion, address, orden.clave],
    { debounceMs: search ? 350 : 0 },
  );

  // Las VLANs de la sede alimentan el filtro (y son las mismas que ofrece el
  // alta de NAP, así que una sola petición al entrar).
  useEffect(() => {
    void authFetch(`/network/vlans?branchId=${branch.id}`).then(listaJson).then(setVlans).catch(() => setVlans([]));
    void authFetch(`/network/nap-addresses?branchId=${branch.id}`).then(listaJson).then(setBarrios).catch(() => setBarrios([]));
  }, [branch.id, authFetch]);

  useEffect(() => {
    setPage(1);
  }, [search, sort, pageSize, vlanId, ocupacion, address, orden.clave]);

  const filtrosActivos = useMemo(
    () => [vlanId, ocupacion, address].filter(Boolean).length + (search.trim() ? 1 : 0),
    [vlanId, ocupacion, address, search],
  );

  // Opciones del desplegable de barrio: la primera limpia el filtro (el Combobox
  // no trae aspa propia) y el resto llevan cuántas NAPs hay en cada uno.
  const itemsBarrio = useMemo<ComboItem[]>(
    () => [
      { value: "", label: "Todos los barrios" },
      ...barrios.map((b) => ({ value: b.value, label: b.value, sublabel: `${b.naps} NAP${b.naps === 1 ? "" : "s"}` })),
    ],
    [barrios],
  );

  function limpiar() {
    setSearch(""); setVlanId(""); setOcupacion(""); setAddress("");
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-default text-text-secondary hover:bg-surface-2" title="Volver a sedes"><Icon name="arrow-left" size={16} /></button>
          <div>
            <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-primary"><Icon name="landmark" size={18} className="text-brand" /> {branch.name}</h1>
            <p className="text-[12px] text-text-tertiary">
              {data
                ? filtrosActivos > 0
                  ? `${(data.total ?? 0).toLocaleString("es-CO")} cajas NAP con estos filtros`
                  : `${(data.total ?? 0).toLocaleString("es-CO")} cajas NAP en esta sede`
                : "Cajas NAP"}
            </p>
          </div>
        </div>
        <Button onClick={() => setCreating(true)}><Icon name="plus" size={15} /> Nueva NAP</Button>
      </div>

      {/* El orden se pide pulsando la cabecera de la tabla; antes había aquí un
          selector Nombre/VLAN que ahora sería un segundo mando para lo mismo.
          El buscador mira nombre Y dirección (lo resuelve el servidor). */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar NAP por nombre o dirección…"
        actions={filtrosActivos > 0 ? (
          <Button variant="ghost" size="sm" onClick={limpiar} title="Quitar todos los filtros">
            <Icon name="x" size={14} /> Limpiar ({filtrosActivos})
          </Button>
        ) : undefined}
      >
        <Select value={vlanId} onChange={(e) => setVlanId(e.target.value)} className="w-full sm:w-44" aria-label="Filtrar por VLAN">
          <option value="">Todas las VLANs</option>
          <option value="none">Sin VLAN</option>
          {vlans.map((v) => <option key={v.id} value={v.id}>VLAN {v.vlan}{v.detail ? ` · ${v.detail}` : ""}</option>)}
        </Select>
        <Select value={ocupacion} onChange={(e) => setOcupacion(e.target.value)} className="w-full sm:w-44" aria-label="Filtrar por ocupación">
          <option value="">Toda ocupación</option>
          <option value="libres">Con puertos libres</option>
          <option value="llenas">Llenas (sin libres)</option>
          <option value="vacias">Vacías (sin clientes)</option>
        </Select>
        {/* La dirección de una NAP es en realidad el BARRIO. Va en combobox y no
            en un <select> porque son cientos por sede (196 en Yopal) y ahí lo que
            hace falta es teclear tres letras, no bajar por una lista. */}
        <Combobox
          items={itemsBarrio}
          value={address}
          onChange={setAddress}
          placeholder="Todos los barrios"
          emptyText="Ningún barrio coincide."
          icon="map-pin"
          className="w-full sm:w-56"
        />
      </ListToolbar>

      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty={filtrosActivos > 0 ? "Ninguna caja NAP coincide con los filtros." : "Esta sede aún no tiene cajas NAP."}
            rowHref={(r) => `/red/naps/${r.id}`}
            columns={[
              { key: "name", header: "NAP", render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "vlan", header: "VLAN", sortable: true, align: "right", render: (r) => r.vlan != null ? <span className="font-mono text-text-secondary">{r.vlan}</span> : "—" },
              // Ocupación real (puertos Ocupados / declarados). El registro de
              // puertos va aparte porque no siempre cuadra con `portCount`.
              { key: "ocupacion", header: "Ocupación", align: "right", render: (r) => <Ocupacion nap={r} /> },
              { key: "ports", header: "Puertos", sortable: true, align: "right", render: (r) => <span className="font-mono text-text-tertiary">{r.portsRegistered}/{r.portCount}</span> },
              { key: "addr", header: "Dirección", sortable: true, render: (r) => (
                <span className="flex items-center gap-1.5 text-text-secondary">
                  {r.gps && <Icon name="map-pin" size={13} className="shrink-0 text-brand" aria-label="Tiene ubicación" />}
                  {r.address || "—"}
                </span>
              ) },
              { key: "go", header: "", align: "right", render: () => <Icon name="chevron-right" size={16} className="text-text-tertiary" /> },
            ]}
          />
          {data && (
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

/**
 * Puertos ocupados sobre los declarados, con el color diciendo si queda sitio:
 * es la pregunta que se hace en campo antes de mandar a un técnico.
 */
function Ocupacion({ nap }: { nap: Nap }) {
  const usados = nap.portsUsed ?? 0;
  const libres = nap.portsRegistered - usados;
  const tono = nap.portsRegistered === 0 ? "default" : libres <= 0 ? "error" : libres <= 2 ? "warning" : "success";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tono} label={`${usados}/${nap.portCount}`} />
      {nap.portsRegistered > 0 && libres > 0 && <span className="text-[11px] text-text-tertiary">{libres} libre{libres === 1 ? "" : "s"}</span>}
      {nap.portsRegistered === 0 && <span className="text-[11px] text-text-tertiary">sin puertos</span>}
    </span>
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
    void authFetch(`/network/vlans?branchId=${branch.id}`).then(listaJson).then(setVlans).catch(() => setVlans([]));
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
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo crear la NAP"));
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
