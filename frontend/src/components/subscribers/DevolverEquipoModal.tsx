"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError, listaJson } from "@/lib/errores";

/** Los tres estados con los que vuelve un equipo, igual que en el legacy. */
const ESTADOS = [
  { value: "Bueno", label: "Bueno — vuelve al stock utilizable" },
  { value: "Malo", label: "Malo — vuelve para revisión / reparación" },
  { value: "Depurado", label: "Depurado — fuera de servicio" },
];

type Bodega = { id: string; name: string; branchName?: string | null };

/**
 * Hoy en la hora DEL NAVEGADOR (en-CA da el `YYYY-MM-DD` que pide un <input type=date>).
 * Con `toISOString()` —lo que se usa en otras pantallas— entre las 7 PM y la medianoche
 * de Colombia saldría mañana, y el servidor rechaza las fechas de recogida futuras.
 */
const hoy = () => new Date().toLocaleDateString("en-CA");

/**
 * Por qué vuelve el equipo. "Retiro" no es un motivo más: arrastra la baja del
 * cliente (RETIRADO + corte en el router), igual que cerrar una orden de retiro.
 */
const TIPOS = [
  { value: "cambio", label: "Cambio / daño / mantenimiento — el cliente sigue" },
  { value: "retiro", label: "Retiro del servicio — el cliente se va" },
];

/** Motivos de retiro del legacy (mismos de la gestión de cobranza). */
const MOTIVOS_RETIRO = [
  "Mal servicio",
  "Cobertura",
  "Cambio de municipio",
  "No lo necesita",
  "Economía",
  "Ya tiene otro servicio",
  "Motivo personal",
  "Otro",
];

/** Cómo se nombra un equipo en el desplegable y en el resumen. */
function etiqueta(e: EquipoDevolver) {
  return [
    e.code != null ? `Código ${e.code}` : null,
    e.mac ? `MAC ${e.mac}` : null,
    e.serial ? `Serial ${e.serial}` : null,
    e.brand,
  ].filter(Boolean).join(" · ") || "Equipo";
}

export type EquipoDevolver = {
  id: string;
  code?: number | null;
  mac?: string | null;
  serial?: string | null;
  brand?: string | null;
  warehouse?: string | null;
  warehouseId?: string | null;
};

/**
 * Devolución del equipo que el cliente tenía instalado (paridad legacy
 * `customers/dev_equipo`, modal "Devolucion de equipo").
 *
 * El equipo se suelta del cliente, pierde los datos de instalación (tipo, vlan,
 * nat, puerto) y se va a una bodega con el estado y el motivo que se escriban
 * aquí. Con "Depurado" la bodega no se elige: va a la de depurados, porque ese
 * equipo ya no es stock. El motivo queda de nota en la ficha del cliente.
 */
export function DevolverEquipoModal({
  subscriberId,
  equipos,
  preseleccion,
  open,
  onClose,
  onDone,
}: {
  subscriberId: string;
  /** Los equipos que el cliente tiene instalados: entre ellos se elige cuál vuelve. */
  equipos: EquipoDevolver[];
  /** Id del equipo con el que abre (el de la fila desde la que se pulsó). */
  preseleccion?: string | null;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [equipoId, setEquipoId] = useState("");
  const [tipo, setTipo] = useState("cambio");
  const [motivoRetiro, setMotivoRetiro] = useState("");
  const [status, setStatus] = useState("Bueno");
  const [returnedAt, setReturnedAt] = useState(hoy);
  const [reason, setReason] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [bodegas, setBodegas] = useState<Bodega[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEquipoId(preseleccion ?? (equipos.length === 1 ? equipos[0].id : ""));
    setTipo("cambio");
    setMotivoRetiro("");
    setStatus("Bueno");
    setReturnedAt(hoy());
    setReason("");
    // Por defecto no se elige bodega: el servidor la manda a la de la sede del
    // cliente, que es lo que pasa el 99% de las veces.
    setWarehouseId("");
    void authFetch("/network/warehouses")
      .then(listaJson)
      .then(setBodegas)
      .catch(() => setBodegas([]));
  }, [open, authFetch, preseleccion, equipos]);

  const depurado = status === "Depurado";
  const retiro = tipo === "retiro";
  const equipo = equipos.find((e) => e.id === equipoId) ?? null;

  // En un retiro el motivo lo pone el desplegable y el texto libre es el detalle;
  // en los demás casos el texto libre ES el motivo, como hasta ahora.
  const motivo = retiro
    ? [motivoRetiro && `Retiro del servicio — ${motivoRetiro}`, reason.trim()].filter(Boolean).join(": ")
    : reason.trim();
  const listo = !!equipo && !!returnedAt && (retiro ? !!motivoRetiro : reason.trim().length >= 3);

  async function devolver() {
    if (!equipo || !listo) return;
    setBusy(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/equipment/${equipo.id}/return`, {
        method: "POST",
        body: JSON.stringify({
          status,
          reason: motivo,
          returnedAt: returnedAt || undefined,
          warehouseId: depurado || !warehouseId ? undefined : warehouseId,
          withdrawal: retiro || undefined,
        }),
      });
      const cuerpo = await res.json().catch(() => null);
      if (!res.ok) throw new Error(cuerpo?.message || "No se pudo devolver el equipo");
      const w = cuerpo?.withdrawal;
      toast(
        `Equipo devuelto a ${cuerpo?.warehouse?.name ?? "bodega"}`
          + (w?.statusSet ? " · cliente retirado" : w?.yaRetirado ? " · el cliente ya estaba retirado" : ""),
        "check",
      );
      if (w?.note) toast(w.note, "alert-triangle");
      if (w && w.equiposPendientes > 0) {
        toast(`Ojo: al cliente le quedan ${w.equiposPendientes} equipo(s) por devolver.`, "alert-triangle");
      }
      onDone?.();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e), "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  const descripcion = equipo ? etiqueta(equipo) : "";

  return (
    <Modal open={open} onClose={onClose} title="Devolver equipo a bodega">
      <div className="flex flex-col gap-3">
        {equipos.length > 1 ? (
          <Field label="Equipo que se devuelve" required>
            <Select value={equipoId} onChange={(e) => setEquipoId(e.target.value)}>
              <option value="">— Elegir equipo —</option>
              {equipos.map((e) => (
                <option key={e.id} value={e.id}>{etiqueta(e)}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2 text-[12px]">
            <div className="font-semibold text-text-primary">{descripcion || "Equipo"}</div>
            {equipo?.warehouse && (
              <div className="text-[11px] text-text-tertiary">Hoy figura en: {equipo.warehouse}</div>
            )}
          </div>
        )}

        <Field label="Tipo de devolución" required>
          <Select value={tipo} onChange={(e) => setTipo(e.target.value)}>
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
        </Field>

        {retiro && (
          <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[11px] text-text-secondary">
            Además de recoger el equipo, el cliente queda en <b>Retirado</b> y se le corta
            la conexión en el router. Si le quedan más equipos instalados, hay que devolverlos aparte.
          </div>
        )}

        <Field
          label="Fecha de recogida"
          required
          hint="El día en que el equipo salió de casa del cliente. Si se recogió antes, cámbiala: es la fecha que queda en la hoja de vida del equipo y en la ficha del cliente."
        >
          <Input
            type="date"
            value={returnedAt}
            max={hoy()}
            onChange={(e) => setReturnedAt(e.target.value)}
          />
        </Field>

        <Field label="Estado con el que vuelve" required>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {ESTADOS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
        </Field>

        <Field
          label="Bodega destino"
          hint={
            depurado
              ? "Un equipo depurado va siempre a la bodega Depurados: no vuelve al stock."
              : "Si no eliges ninguna, va a la bodega de la sede del cliente."
          }
        >
          <Select
            value={depurado ? "" : warehouseId}
            disabled={depurado}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            <option value="">{depurado ? "Depurados" : "— Bodega de la sede del cliente —"}</option>
            {!depurado && bodegas.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}{b.branchName ? ` (${b.branchName})` : ""}
              </option>
            ))}
          </Select>
        </Field>

        {retiro ? (
          <>
            <Field label="Motivo del retiro" required>
              <Select value={motivoRetiro} onChange={(e) => setMotivoRetiro(e.target.value)}>
                <option value="">— Elegir motivo —</option>
                {MOTIVOS_RETIRO.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </Select>
            </Field>
            <Field label="Detalle" hint="Opcional: lo que contó el cliente.">
              <Textarea
                rows={2}
                placeholder="Se muda a otra ciudad, se pasa a otro operador…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field label="Motivo de la devolución" required>
            <Textarea
              rows={3}
              placeholder="Por qué vuelve el equipo: cambio por daño, mantenimiento, traslado…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}

        <p className="text-[11px] text-text-tertiary">
          El equipo deja de estar asignado al cliente, se libera su puerto y pierde los datos
          de instalación (tipo, vlan, nat). Queda registrado en las notas del cliente con la
          fecha de recogida.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={devolver} disabled={busy || !listo}>
            {busy
              ? "Devolviendo…"
              : retiro ? "Devolver y retirar cliente" : "Devolver a bodega"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
