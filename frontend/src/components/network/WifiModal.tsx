"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

/**
 * Cambiar el nombre y/o la clave del WiFi del cliente SIN mandar a nadie.
 *
 * Es la misma vía que usa el bot de WhatsApp cuando un cliente pide cambiar su
 * contraseña (POST /network/genieacs/wifi): si el equipo está en el ACS y contesta,
 * el cambio se aplica en el momento. Aquí está para quien atiende por teléfono o en
 * mostrador, que hoy no tiene más remedio que abrir una orden.
 *
 * Lo que NO hace: prometer. Solo 605 de los 5.097 abonados activos tienen equipo en
 * el ACS y unos 420 informan a diario, así que el "no se pudo" es la respuesta
 * frecuente y sale con su motivo y con qué hacer entonces (abrir la orden de
 * «Cambio de clave»), en vez de un error rojo sin salida.
 */

type Resultado = {
  ok: boolean;
  resultado: "APLICADO" | "SIN_EQUIPO" | "EQUIPO_OFFLINE" | "RECHAZADO" | "DRY_RUN" | "DATOS_INVALIDOS";
  detalle: string;
  redes?: string[];
};

/** Qué hacer cuando no se pudo. Es la parte útil del fallo. */
const QUE_HACER: Record<Resultado["resultado"], string> = {
  APLICADO: "",
  SIN_EQUIPO:
    "El equipo de este cliente no está en el ACS (no habla TR-069 o nunca se registró). " +
    "Se cambia con una orden de «Cambio de clave» o guiando al cliente por teléfono.",
  EQUIPO_OFFLINE:
    "El equipo está registrado pero no contestó: apagado, sin fibra o fuera de línea. " +
    "Se puede reintentar cuando el cliente confirme que está encendido.",
  RECHAZADO: "El equipo no deja configurar el WiFi a distancia. Toca por orden de servicio.",
  DRY_RUN: "La red está en modo simulación (GENIEACS_LIVE apagado): no se tocó nada.",
  DATOS_INVALIDOS: "",
};

export function WifiModal({
  subscriberId,
  subscriberName,
  open,
  onClose,
}: {
  subscriberId: string;
  subscriberName?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { authFetch } = useAuth();
  const [ssid, setSsid] = useState("");
  const [clave, setClave] = useState("");
  const [verClave, setVerClave] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [res, setRes] = useState<Resultado | null>(null);

  useEffect(() => {
    if (!open) return;
    setSsid("");
    setClave("");
    setVerClave(false);
    setRes(null);
  }, [open]);

  // Las mismas reglas que comprueba el backend, aquí solo para no hacer viajar de
  // balde una clave que WPA va a rechazar.
  const claveCorta = !!clave && (clave.length < 8 || clave.length > 63);
  const nadaQueHacer = !ssid.trim() && !clave;

  async function aplicar() {
    setEnviando(true);
    setRes(null);
    try {
      const r = await authFetch("/network/genieacs/wifi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriberId, ssid: ssid.trim() || undefined, password: clave || undefined }),
      });
      const data = (await r.json().catch(() => null)) as Resultado | null;
      if (!r.ok || !data) {
        toast((data as { message?: string } | null)?.message ?? "No se pudo aplicar el cambio.", "x");
        return;
      }
      setRes(data);
      if (data.ok) toast("WiFi cambiado en el equipo del cliente", "check");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo aplicar el cambio."), "x");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar el WiFi del cliente">
      <div className="flex flex-col gap-3">
        {subscriberName && <p className="text-[12px] text-text-secondary">{subscriberName}</p>}

        <Field label="Nombre de la red (opcional)" hint="Déjalo vacío para no cambiarlo. La banda de 5 GHz queda con el sufijo «-5G».">
          <Input
            value={ssid}
            maxLength={32}
            onChange={(e) => setSsid(e.target.value)}
            placeholder="Ej. FAMILIA PEREZ"
            disabled={enviando}
          />
        </Field>

        <Field
          label="Clave nueva (opcional)"
          hint="Entre 8 y 63 caracteres, sin tildes ni ñ: muchos equipos no las aceptan."
          error={claveCorta ? "La clave debe tener entre 8 y 63 caracteres." : undefined}
        >
          <div className="flex gap-2">
            <Input
              type={verClave ? "text" : "password"}
              value={clave}
              maxLength={63}
              onChange={(e) => setClave(e.target.value)}
              placeholder="Clave del WiFi"
              disabled={enviando}
              className="flex-1"
            />
            <Button variant="secondary" size="sm" onClick={() => setVerClave((v) => !v)} type="button">
              <Icon name={verClave ? "eye-off" : "eye"} size={15} />
            </Button>
          </div>
        </Field>

        {/* El aviso va antes del botón, no después del estropicio. */}
        <p className="flex items-start gap-2 rounded-lg border border-warning-text/20 bg-warning-soft px-3 py-2 text-[11px] leading-snug text-warning-text">
          <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
          <span>
            Al aplicarlo se desconectan <b>todos</b> los aparatos del cliente (televisores, cámaras, celulares) y hay
            que volver a conectarlos con la clave nueva. La clave no se guarda en el sistema: se manda al equipo y
            no queda registrada en ningún lado.
          </span>
        </p>

        {res && (
          <div
            className={`rounded-lg border px-3 py-2 text-[12px] ${
              res.ok
                ? "border-success-text/20 bg-success-soft text-success-text"
                : "border-border-subtle bg-surface-2 text-text-secondary"
            }`}
          >
            <p className="flex items-center gap-2 font-semibold">
              <Icon name={res.ok ? "check" : "info"} size={14} />
              {res.ok ? "Aplicado en el equipo" : "No se pudo aplicar"}
            </p>
            <p className="mt-1 leading-snug">{res.detalle}</p>
            {res.redes?.length ? (
              <ul className="mt-1 list-disc pl-4">
                {res.redes.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            {!res.ok && QUE_HACER[res.resultado] && (
              <p className="mt-1 leading-snug">{QUE_HACER[res.resultado]}</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {res?.ok ? "Cerrar" : "Cancelar"}
          </Button>
          <Button onClick={() => void aplicar()} disabled={enviando || nadaQueHacer || claveCorta}>
            <Icon name={enviando ? "loader" : "wifi"} size={15} className={enviando ? "animate-spin" : ""} />
            {enviando ? "Aplicando…" : "Aplicar en el equipo"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
