"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { mensajeDeError } from "@/lib/errores";

/** Lo que devuelve el backend al pedir un código (`SignatureOtpService.pedir`). */
export type FirmaOtpEnvio = {
  phoneMask: string | null;
  expiresAt: string;
  resendAt: string;
  simulated: boolean;
  /** Solo en modo simulación: el código se muestra porque no salió ningún WhatsApp. */
  codigoSimulado?: string;
  via?: string;
};

/**
 * Diálogo de FIRMA: pide el código de un solo uso que llega al WhatsApp y ejecuta
 * la acción firmada.
 *
 * Es genérico a propósito (`solicitar` + `firmar` los pone quien lo usa): la
 * aprobación de órdenes de compra es la primera firma del sistema, pero detrás
 * vienen los egresos de caja y la salida de equipo entre sedes, y ninguna de esas
 * pantallas debería volver a escribir la cuenta atrás del reenvío ni el manejo de
 * "ese código no es".
 *
 * El código se pide AL ABRIR, sin un clic previo de "enviar": quien pulsó "Aprobar"
 * ya dijo lo que quiere, y un paso más solo consigue que mire una pantalla vacía
 * preguntándose si el WhatsApp va a llegar.
 */
export function FirmaOtpModal({
  open,
  onClose,
  titulo = "Firmar con tu código",
  queFirma,
  solicitar,
  firmar,
  textoBoton = "Firmar",
  textoBotonOcupado = "Firmando…",
  destino = "tu WhatsApp",
  pie,
  icono = "file-signature",
}: {
  open: boolean;
  onClose: () => void;
  titulo?: string;
  /** Qué se está firmando, en una línea ("Orden #1042 · Proveedor X · $1.200.000"). */
  queFirma: React.ReactNode;
  /** Pide el código al backend. Debe lanzar con mensaje si no se pudo enviar. */
  solicitar: () => Promise<FirmaOtpEnvio>;
  /** Ejecuta la acción con el código. Debe lanzar si el código no sirve. */
  firmar: (code: string) => Promise<void>;
  textoBoton?: string;
  textoBotonOcupado?: string;
  /**
   * A quién le llega el código. Casi siempre es al propio usuario, pero al
   * restablecerle la contraseña a un funcionario le llega A ÉL —esa es la gracia—
   * y el diálogo no puede seguir diciendo "tu WhatsApp".
   */
  destino?: string;
  /** Sustituye el aviso del pie cuando el código no es de quien está en la pantalla. */
  pie?: React.ReactNode;
  icono?: string;
}) {
  const [envio, setEnvio] = useState<FirmaOtpEnvio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [firmando, setFirmando] = useState(false);
  const [code, setCode] = useState("");
  const [ahora, setAhora] = useState(() => Date.now());
  // Evita el doble envío del primer código: en React 18 en desarrollo los efectos
  // se montan dos veces, y eso mandaba dos WhatsApps (el usuario teclea el primero,
  // que el segundo acaba de invalidar).
  const pedido = useRef(false);

  const pedir = useCallback(async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await solicitar();
      setEnvio(r);
      setCode("");
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo enviar el código"));
    } finally {
      setEnviando(false);
    }
  }, [solicitar]);

  useEffect(() => {
    if (!open) {
      pedido.current = false;
      setEnvio(null);
      setCode("");
      setError(null);
      return;
    }
    if (pedido.current) return;
    pedido.current = true;
    void pedir();
  }, [open, pedir]);

  // Un tic por segundo mientras está abierto: mueve la cuenta atrás del reenvío y
  // la del vencimiento del código.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const segundos = (iso?: string) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - ahora) / 1000)) : 0);
  const paraReenviar = segundos(envio?.resendAt);
  const paraVencer = segundos(envio?.expiresAt);
  const vencido = !!envio && paraVencer === 0;
  const listo = code.replace(/\D/g, "").length === 6 && !firmando && !vencido;

  async function confirmar() {
    setFirmando(true);
    setError(null);
    try {
      await firmar(code.replace(/\D/g, ""));
      onClose();
    } catch (e) {
      // El error del backend es el que hay que leer ("te quedan 3 intentos"), así
      // que se queda dentro del diálogo y no en un toast que se va solo.
      setError(mensajeDeError(e, "No se pudo firmar"));
      setCode("");
    } finally {
      setFirmando(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={titulo} maxWidth="max-w-md">
      <div className="grid gap-3">
        <div className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-text-secondary">{queFirma}</div>

        {enviando && !envio && (
          <p className="flex items-center gap-2 text-[12.5px] text-text-tertiary">
            <Icon name="loader" size={14} className="animate-spin" /> Enviando el código a {destino}…
          </p>
        )}

        {envio && (
          <>
            <p className="text-[12.5px] leading-snug text-text-secondary">
              {envio.simulated ? (
                <>Modo <strong>simulación</strong>: no salió ningún WhatsApp. El código se muestra aquí para probar el flujo.</>
              ) : (
                <>Mandamos un código de 6 dígitos a {destino} <strong>{envio.phoneMask}</strong>. Vence en {Math.floor(paraVencer / 60)}:{String(paraVencer % 60).padStart(2, "0")}.</>
              )}
            </p>

            {envio.simulated && envio.codigoSimulado && (
              <p className="flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-warning-soft px-3 py-2 font-mono text-[18px] font-bold tracking-[0.3em] text-warning-text">
                <Icon name="flask-conical" size={15} /> {envio.codigoSimulado}
              </p>
            )}

            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter" && listo) void confirmar(); }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="••••••"
              aria-label="Código de firma"
              aria-invalid={!!error}
              className="w-full rounded-lg border border-border-default bg-surface px-3 py-3 text-center font-mono text-[24px] font-bold tracking-[0.45em] text-text-primary outline-none focus:border-brand"
            />

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void pedir()}
                disabled={enviando || (paraReenviar > 0 && !vencido)}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Icon name={enviando ? "loader" : "rotate-cw"} size={13} className={enviando ? "animate-spin" : ""} />
                {paraReenviar > 0 && !vencido ? `Reenviar en ${paraReenviar} s` : "Enviar otro código"}
              </button>
              <Button onClick={() => void confirmar()} disabled={!listo}>
                <Icon name={firmando ? "loader" : icono} size={13} className={firmando ? "animate-spin" : ""} />
                {firmando ? textoBotonOcupado : textoBoton}
              </Button>
            </div>
          </>
        )}

        {error && (
          <p className="flex items-start gap-1.5 rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">
            <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{error}</span>
          </p>
        )}

        {!envio && !enviando && (
          <Button variant="secondary" onClick={() => void pedir()}>
            <Icon name="send" size={13} /> Reintentar el envío
          </Button>
        )}

        <p className="text-[11px] leading-snug text-text-tertiary">
          {pie ?? (
            <>
              El código es de un solo uso y solo sirve para esta firma. Nadie del equipo te lo va a pedir por
              teléfono: si te lo piden, no lo des y avisa a sistemas.
            </>
          )}
        </p>
      </div>
    </Modal>
  );
}

/** Aviso corto para toast/UI cuando el usuario no tiene teléfono de firma configurado. */
export const SIN_TELEFONO_FIRMA =
  "No tienes un teléfono para recibir el código de firma. Configúralo en Mi perfil → Seguridad.";
