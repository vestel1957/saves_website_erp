"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

/**
 * Cerrar la caja desde la propia pantalla del arqueo.
 *
 * El cierre ya existía, pero sólo se llegaba a él desde /tesoreria con un modal que
 * volvía a preguntar caja y fecha — justo lo que se acaba de elegir aquí. Este botón
 * cierra LA caja y EL día que se están mirando: no hay nada más que escoger, sólo
 * confirmar contra el efectivo que se contó en el cajón.
 *
 * El arqueo completo está encima, así que el modal no lo repite: recuerda las tres cosas
 * que no se pueden deshacer —cuánto se barre, a dónde se arrastra, y que no se cierra dos
 * veces— y nada más.
 */
export function CerrarCajaBoton({ cashAccountId, caja, fecha, excedente, proximoDiaHabil, onCerrado }: {
  cashAccountId: number;
  caja: string;
  fecha: string;
  /** El efectivo que hay ahora mismo en el cajón: es lo que se va a barrer. */
  excedente: number;
  proximoDiaHabil: string;
  onCerrado: () => void;
}) {
  const { authFetch } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState("");

  const fechaLarga = (d?: string) =>
    d ? new Date(d).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" }) : "—";

  // El backend no escribe nada si el cajón está vacío o en negativo (el legacy sólo
  // arrastra saldos positivos), así que se dice ANTES de pulsar y no después.
  const sinNada = excedente <= 0;

  async function cerrar() {
    setErr("");
    setGuardando(true);
    try {
      const res = await authFetch("/treasury/cash-close", {
        method: "POST",
        body: JSON.stringify({ cashAccountId, date: fecha }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo cerrar la caja");

      if (data.escrito) toast(`Caja cerrada · se barrieron ${cop(data.excedente)}`);
      else if (data.motivo === "ya-cerrado") toast("Esta caja ya estaba cerrada ese día");
      else toast("Sin excedente: no había efectivo que arrastrar");

      setAbierto(false);
      onCerrado();
    } catch (e) {
      setErr(mensajeDeError(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => { setErr(""); setAbierto(true); }}>
        <Icon name="lock" size={14} /> Cerrar caja
      </Button>

      <Modal open={abierto} onClose={() => !guardando && setAbierto(false)} title="Cerrar la caja" maxWidth="max-w-md">
        <p className="text-[13px] text-text-secondary">
          Vas a cerrar <strong className="text-text-primary">{caja}</strong> del{" "}
          <strong className="text-text-primary">{fechaLarga(fecha)}</strong>.
        </p>

        <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            Se barre del cajón
          </p>
          <p className={`text-2xl font-bold tabular-nums ${sinNada ? "text-text-tertiary" : "text-brand"}`}>
            {cop(excedente)}
          </p>
          <p className="mt-1 text-[12px] text-text-tertiary">
            Se arrastra al <strong className="text-text-secondary">{fechaLarga(proximoDiaHabil)}</strong>,
            el próximo día hábil. La base queda en cero.
          </p>
        </div>

        {sinNada ? (
          <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
            El cajón no tiene efectivo que arrastrar, así que el cierre no va a escribir nada.
            Si esperabas otra cifra, revisa los movimientos del día antes de cerrar.
          </p>
        ) : (
          <p className="mt-3 text-[12px] text-text-tertiary">
            Cuenta el efectivo del cajón y compáralo con esta cifra antes de confirmar. Una vez
            cerrado, ese día no se vuelve a cerrar: hacerlo dos veces duplicaría el arrastre.
          </p>
        )}

        {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAbierto(false)} disabled={guardando}>Cancelar</Button>
          <Button onClick={cerrar} disabled={guardando}>
            {guardando ? "Cerrando…" : "Sí, cerrar la caja"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
