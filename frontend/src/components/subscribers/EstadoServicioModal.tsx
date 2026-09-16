"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Select, Textarea } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type Servicio = { kind: string; planName: string | null; status: string | null };

/** Los dos servicios que se pueden mover, con su nombre y su icono. */
const SERVICIOS = [
  { kind: "INTERNET", label: "Internet", icon: "wifi" },
  { kind: "TV", label: "Televisión", icon: "tv" },
] as const;

const ESTADOS = [
  { value: "ACTIVO", label: "Al aire (activo)" },
  { value: "CORTADO", label: "Cortado" },
  { value: "SUSPENDIDO", label: "Suspendido" },
];

const etiquetaEstado = (s?: string | null) =>
  s === "CORTADO" ? "Cortado" : s === "SUSPENDIDO" ? "Suspendido" : "Al aire";

/**
 * Cambio manual del estado de UN servicio del cliente: su internet o su televisión.
 *
 * Es el hermano por servicio de `CambiarEstadoModal`: el estado del cliente dice cómo
 * está la cuenta y esto dice qué está recibiendo, que no es lo mismo —se puede tener la
 * TV suspendida y el internet navegando—. Hacía falta porque hasta ahora ese estado solo
 * se movía cerrando una orden, y cuando la orden no lo movía no había forma de
 * corregirlo: la ficha seguía diciendo que el servicio estaba al aire.
 *
 * Administrativo, como el otro: no toca los equipos.
 */
export function EstadoServicioModal({
  subscriberId,
  services,
  open,
  onClose,
  onDone,
}: {
  subscriberId: string;
  services: Servicio[];
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  // Los PUNTOS son decos de televisión: van con la TV y no se eligen aparte.
  const contratado = (kind: string) =>
    services.some((s) => (kind === "TV" ? s.kind === "TV" || s.kind === "PUNTOS" : s.kind === kind));
  const actual = (kind: string) =>
    services.find((s) => (kind === "TV" ? s.kind === "TV" : s.kind === kind))?.status ?? "ACTIVO";

  const disponibles = SERVICIOS.filter((s) => contratado(s.kind));
  const [servicio, setServicio] = useState<string>("");
  const [estado, setEstado] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setServicio(disponibles[0]?.kind ?? "");
    setEstado("");
    setNote("");
    // Sólo al abrir: si se recalculara con `disponibles` se reiniciaría la elección
    // en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const estadoActual = servicio ? actual(servicio) : null;

  async function apply() {
    if (!servicio || !estado || estado === estadoActual) return;
    setBusy(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/servicios/estado`, {
        method: "PATCH",
        body: JSON.stringify({ servicio, estado, note: note.trim() || undefined }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || "No se pudo cambiar el estado del servicio");
      const nombre = SERVICIOS.find((s) => s.kind === servicio)?.label ?? servicio;
      // El número de la orden se dice en el toast: es la constancia del trabajo y lo
      // que hay que buscar después en soporte o en el sistema anterior.
      const orden = body?.orden?.code ? ` · orden #${body.orden.code}` : "";
      toast(`${nombre}: ${etiquetaEstado(estado).toLowerCase()}${orden}`, "check");
      onDone?.();
      onClose();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Estado de los servicios">
      <div className="flex flex-col gap-3">
        {!disponibles.length ? (
          <p className="text-[13px] text-text-secondary">
            Este cliente no tiene internet ni televisión en su factura vigente, que es donde se
            anota el estado de cada servicio.
          </p>
        ) : (
          <>
            {/* Cómo está cada uno AHORA: es la pregunta que trae aquí a quien abre el
                modal, y verlo al lado evita cambiar el servicio equivocado. */}
            <div className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface-2 p-2">
              {disponibles.map((s) => {
                const est = actual(s.kind);
                const caido = est !== "ACTIVO";
                return (
                  <div key={s.kind} className="flex items-center gap-2 text-[12px]">
                    <Icon name={s.icon} size={13} className={caido ? "text-error-text" : "text-text-tertiary"} />
                    <span className="font-semibold text-text-secondary">{s.label}</span>
                    <span className="text-text-tertiary">·</span>
                    <span className={caido ? "font-bold uppercase tracking-wide text-error-text" : "text-text-secondary"}>
                      {etiquetaEstado(est)}
                    </span>
                  </div>
                );
              })}
            </div>

            {disponibles.length > 1 && (
              <label className="flex flex-col gap-1 text-[12px] font-semibold text-text-secondary">
                Servicio
                <Select value={servicio} onChange={(e) => { setServicio(e.target.value); setEstado(""); }}>
                  {disponibles.map((s) => (
                    <option key={s.kind} value={s.kind}>{s.label}</option>
                  ))}
                </Select>
              </label>
            )}

            <label className="flex flex-col gap-1 text-[12px] font-semibold text-text-secondary">
              Nuevo estado
              <Select value={estado} onChange={(e) => setEstado(e.target.value)}>
                <option value="">— Elegir estado —</option>
                {ESTADOS.filter((e) => e.value !== estadoActual).map((e) => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </Select>
            </label>

            <Textarea
              rows={2}
              placeholder="Motivo del cambio (opcional, queda en las observaciones del cliente)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <p className="text-[11px] text-text-tertiary">
              Se anota en la factura vigente del cliente —que es de donde la ficha lee qué está
              caído— y viaja al sistema anterior. Es administrativo: no corta ni enciende el
              servicio en los equipos, así que se da por hecho a mano y queda la orden de
              servicio correspondiente ya cerrada.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>Cancelar</Button>
              <Button onClick={apply} disabled={!servicio || !estado || busy}>
                {busy ? "Aplicando…" : "Cambiar estado"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
