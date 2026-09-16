"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError, objetoJson } from "@/lib/errores";
import { NapPortPicker, type NapPort } from "@/components/soporte/NapPortPicker";

export type EquipoUbicar = {
  id: string;
  code?: number | null;
  mac?: string | null;
  serial?: string | null;
  vlan?: number | null;
  napId?: string | null;
  napName?: string | null;
  portId?: string | null;
  portNumber?: number | null;
  /** Ids legacy crudos: hay equipo con caja pero sin fila de puerto que case. */
  nat?: number | null;
  port?: number | null;
};

type LecturaVlan = {
  ok: boolean;
  vlan: number | null;
  vlans?: number[];
  fsp?: string;
  ontId?: number;
  olt?: { name: string };
  error?: string;
  motivo?: string;
};

/**
 * Editar DÓNDE está colgado un equipo que el cliente ya tiene: la caja NAP y el
 * puerto, con el mismo selector que la entrega (`NapPortPicker`).
 *
 * La VLAN no se escribe: se lee del service-port de la ONU en la OLT y el servidor
 * la guarda al pulsar Guardar. Si la OLT no contesta, la caja se guarda igual y la
 * VLAN se queda como estaba.
 */
export function UbicarEquipoModal({
  subscriberId, equipo, open, onClose, onDone,
}: {
  subscriberId: string;
  equipo: EquipoUbicar;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const inicial: NapPort | null = equipo.napId && equipo.portId && equipo.portNumber != null
    ? { napId: equipo.napId, napName: equipo.napName ?? "", portId: equipo.portId, portNumber: equipo.portNumber }
    : null;
  const [caja, setCaja] = useState<NapPort | null>(inicial);
  const [lectura, setLectura] = useState<LecturaVlan | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [serial, setSerial] = useState(equipo.serial ?? "");
  // Con el serial se encuentra la ONU en la OLT: los importados traen "solicitar".
  const cambiaSerial = !!serial.trim() && serial.trim() !== (equipo.serial ?? "").trim();

  const tieneCaja = !!(equipo.napId || equipo.nat);
  // Quitar = tenía caja y se deseleccionó sin elegir otra.
  const quitar = tieneCaja && !caja;
  const cambiaCaja = caja?.portId !== (equipo.portId ?? undefined) && !!caja;

  const leerVlan = useCallback(async (refresh = false) => {
    setLeyendo(true);
    try {
      const d = (await objetoJson(
        await authFetch(`/support/subscribers/${subscriberId}/vlan-olt${refresh ? "?refresh=1" : ""}`),
      )) as LecturaVlan;
      setLectura(d);
    } catch (e) {
      setLectura({ ok: false, vlan: null, error: mensajeDeError(e) });
    } finally { setLeyendo(false); }
  }, [authFetch, subscriberId]);

  useEffect(() => { if (open) void leerVlan(); }, [open, leerVlan]);

  async function guardar() {
    setBusy(true); setErr("");
    try {
      const body: Record<string, unknown> = caja ? { napId: caja.napId, portId: caja.portId } : quitar ? { quitarCaja: true } : {};
      if (cambiaSerial) body.serial = serial.trim();
      const res = await authFetch(`/support/subscribers/${subscriberId}/equipment/${equipo.id}`, {
        method: "PATCH", body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo guardar");
      toast(
        d?.vlanOlt && !d.vlanOlt.ok
          ? `Caja guardada. La VLAN no se pudo leer de la OLT: ${d.vlanOlt.error ?? "sin respuesta"}`
          : `Equipo actualizado${d?.vlan != null ? ` · VLAN ${d.vlan}` : ""}`,
      );
      onDone?.(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setBusy(false); }
  }

  const rotulo = [
    equipo.code != null ? `Código ${equipo.code}` : null,
    equipo.mac ? `MAC ${equipo.mac}` : null,
    equipo.serial ? `Serial ${equipo.serial}` : null,
  ].filter(Boolean).join(" · ") || "Equipo";

  return (
    <Modal open={open} onClose={onClose} title="Editar equipo: serial, caja NAP y puerto" maxWidth="max-w-xl">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-[12px] text-text-secondary">{rotulo}</p>

        <Field label="Serial de la ONU" hint="El rotulado en el equipo (p. ej. ZTEGDE519CDF): con él se la encuentra en la OLT.">
          <Input value={serial} onChange={(ev) => setSerial(ev.target.value)} className="font-mono" placeholder="ZTEGDE519CDF" />
        </Field>

        <Field label="Caja NAP y puerto">
          <NapPortPicker subscriberId={subscriberId} value={caja} onChange={setCaja} />
        </Field>
        {!inicial && tieneCaja && (
          <p className="-mt-2 text-[11px] text-text-tertiary">
            Hoy tiene la caja {equipo.napName ?? `#${equipo.nat}`}
            {equipo.portNumber != null ? `, puerto ${equipo.portNumber}` : equipo.port ? ` (puerto #${equipo.port} sin casar)` : ""}.
            Elige caja y puerto para corregirlo.
          </p>
        )}
        {quitar && inicial && (
          <p className="-mt-2 text-[11px] text-warning-text">
            Sin puerto elegido: al guardar el equipo queda sin caja NAP y se libera el puerto {inicial.portNumber} de {inicial.napName}.
          </p>
        )}

        {/* VLAN: la dice la OLT */}
        <div className="rounded-xl border border-border-default bg-surface-2 px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-text-secondary">VLAN</span>
            <span className="text-[11px] text-text-tertiary">— se lee de la OLT</span>
            <button
              type="button" onClick={() => void leerVlan(true)} disabled={leyendo}
              title="Volver a consultar la OLT"
              className="ml-auto rounded-md p-1 text-text-tertiary hover:bg-surface hover:text-text-primary disabled:opacity-50"
            >
              <Icon name="refresh-cw" size={13} className={leyendo ? "animate-spin" : ""} />
            </button>
          </div>
          {leyendo && !lectura ? (
            <p className="mt-1 text-[12px] text-text-tertiary">Consultando la OLT…</p>
          ) : lectura?.ok ? (
            <div className="mt-1">
              <span className="text-[22px] font-semibold text-text-primary">{lectura.vlan}</span>
              {equipo.vlan != null && equipo.vlan !== lectura.vlan && (
                <span className="ml-2 text-[11px] text-text-tertiary">(hoy guardada: {equipo.vlan || "—"})</span>
              )}
              <p className="text-[11px] text-text-tertiary">
                {[lectura.olt?.name, lectura.fsp && `${lectura.fsp} ONT ${lectura.ontId}`].filter(Boolean).join(" · ")}
                {(lectura.vlans?.length ?? 0) > 1 ? ` · service-ports en VLAN ${lectura.vlans!.join(", ")} (se guarda la de datos)` : ""}
              </p>
            </div>
          ) : lectura ? (
            <p className="mt-1 flex gap-1.5 text-[12px] text-warning-text">
              <Icon name="alert-triangle" size={13} className="mt-0.5 shrink-0" />
              <span>{lectura.error || "No se pudo leer la VLAN."} Se mantiene la actual ({equipo.vlan ?? "—"}).</span>
            </p>
          ) : null}
        </div>

        {err && <p className="text-[12px] text-error-text">{err}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={guardar} disabled={busy || leyendo}>
            {busy ? "Guardando…" : cambiaCaja || quitar || cambiaSerial ? "Guardar" : "Guardar VLAN"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
