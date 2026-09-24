"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import type { Nap, NapPort, Paged, VlanOpt } from "@/lib/network";
import { listaJson, mensajeDeError } from "@/lib/errores";

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

  const [editing, setEditing] = useState(false);
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
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo liberar"), "alert-triangle");
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
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo asignar"), "alert-triangle");
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
      <DetailHeader
        backHref="/red/naps"
        backLabel="Cajas NAP"
        icon="git-branch"
        title={nap!.name}
        subtitle={`${nap!.branch ?? "Sin sede"}${nap!.vlan != null ? ` · VLAN ${nap!.vlan}` : ""}`}
        actions={
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} /> Editar caja
          </Button>
        }
      />

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

      {nap && (
        <EditarNapModal
          open={editing}
          nap={nap}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); void loadNap(); }}
        />
      )}
    </>
  );
}

/**
 * Editar la caja NAP: nombre, VLAN, GPS y dirección.
 *
 * Existía el alta ("Nueva NAP") y no existía la corrección, así que un dato mal
 * tecleado —o heredado torcido del legacy— se quedaba así para siempre: era lo
 * que reportaba el área de redes ("no puedo editar las cajas NAP, ni la VLAN, ni
 * la geolocalización"). El backend ya aceptaba `PATCH /network/naps/:id` desde el
 * principio; lo que faltaba era la pantalla.
 *
 * Los PUERTOS no se editan aquí a propósito: `portCount` no entra en `UpdateNapDto`
 * porque cambiarlo obligaría a crear o borrar filas de `Port` —con clientes colgando
 * de ellas—, y eso no es editar una ficha, es otra operación.
 *
 * El GPS se teclea como "lat, lng" igual que en el alta: es el formato en el que se
 * copia de Google Maps o del WhatsApp del técnico, que es de donde sale.
 */
function EditarNapModal({ open, nap, onClose, onSaved }: { open: boolean; nap: Nap; onClose: () => void; onSaved: () => void }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState(nap.name);
  const [vlanId, setVlanId] = useState(nap.vlanId ?? "");
  const [vlans, setVlans] = useState<VlanOpt[]>([]);
  const [address, setAddress] = useState(nap.address ?? "");
  const [gps, setGps] = useState(nap.gps ? `${nap.gps.lat}, ${nap.gps.lng}` : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Al abrir: repuebla con lo que hay HOY (la ficha pudo recargarse entre medias) y
  // trae las VLANs de SU sede — una VLAN sólo significa algo dentro de su sede, y el
  // backend rechaza colgar la NAP de una VLAN de otra.
  useEffect(() => {
    if (!open) return;
    setName(nap.name);
    setVlanId(nap.vlanId ?? "");
    setAddress(nap.address ?? "");
    setGps(nap.gps ? `${nap.gps.lat}, ${nap.gps.lng}` : "");
    setErr(null);
    const q = nap.branchId ? `?branchId=${nap.branchId}` : "";
    void authFetch(`/network/vlans${q}`).then(listaJson).then(setVlans).catch(() => setVlans([]));
  }, [open, nap, authFetch]);

  async function submit() {
    setErr(null);
    if (!name.trim()) { setErr("Escribe un nombre para la NAP."); return; }
    // Vaciar el GPS es una decisión, no un descuido: se manda "" y el servidor lo
    // guarda tal cual (`gpsLat?.trim() ?? nap.gpsLat`), así que un campo en blanco
    // borra la coordenada en vez de dejar la vieja pegada.
    let gpsLat = "", gpsLng = "";
    if (gps.trim()) {
      const [lat, lng] = gps.split(",").map((x) => x.trim());
      if (!lat || !lng || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
        setErr("GPS debe ser 'latitud, longitud' — por ejemplo 4.60971, -74.08175.");
        return;
      }
      gpsLat = lat; gpsLng = lng;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/network/naps/${nap.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), vlanId, address: address.trim(), gpsLat, gpsLng }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo guardar la NAP");
      toast(`NAP "${d.name}" actualizada`);
      onSaved();
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo guardar la NAP"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Editar caja NAP · ${nap.name}`}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nombre" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="NAP-01" /></Field>
        <Field label="VLAN">
          <Select value={vlanId} onChange={(e) => setVlanId(e.target.value)}>
            <option value="">Sin VLAN</option>
            {vlans.map((v) => <option key={v.id} value={v.id}>VLAN {v.vlan}{v.detail ? ` · ${v.detail}` : ""}</option>)}
          </Select>
        </Field>
        <Field label="GPS (latitud, longitud)"><Input value={gps} onChange={(e) => setGps(e.target.value)} placeholder="4.60971, -74.08175" /></Field>
        <Field label="Puertos">
          <div className="flex h-9 items-center text-[13px] text-text-tertiary">
            {nap.portCount} — no se cambian desde aquí
          </div>
        </Field>
        <div className="sm:col-span-2"><Field label="Dirección"><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Poste / referencia" /></Field></div>
      </div>
      <p className="mt-2 text-[11.5px] text-text-tertiary">
        La sede de la caja no se edita: se deduce de la bodega y moverla dejaría sus puertos apuntando a otro municipio.
      </p>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" size="sm" disabled={saving} onClick={submit}>
          <Icon name="check" size={13} /> {saving ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </Modal>
  );
}
