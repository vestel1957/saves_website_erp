"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { TICKET_PRIORITY_TONE } from "@/lib/support";
import type { OrdenAgendada } from "@/components/soporte/VisitaAgendada";

export type MiTurno = {
  resolved: boolean;
  fecha: string;
  hoy: string;
  tecnico?: string;
  total: number;
  hechas: number;
  restantes: number;
  visita: OrdenAgendada | null;
  proximas: number;
};

const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

/**
 * Motivos frecuentes por los que una visita no se puede hacer.
 *
 * Se ofrecen escritos en vez de dejar solo la caja de texto por dos razones: en la
 * calle, con una mano, nadie escribe un párrafo — y un motivo tecleado a la carrera
 * ("no") no le sirve de nada a quien tiene que reagendar. Igual se puede escribir
 * cualquier otra cosa: la lista orienta, no encierra.
 */
const MOTIVOS = [
  "El cliente no estaba",
  "La dirección no corresponde",
  "El cliente pidió reagendar",
  "No hay acceso al sitio",
  "Me falta material o equipo",
];

/**
 * La visita que le toca al técnico AHORA, y solo esa.
 *
 * Desde el 2026-08-04 el técnico no elige el orden de su día: ve una visita, y hasta
 * que no la cierra —o la aparta con un motivo— no aparece la siguiente. La lista
 * completa desapareció de su pantalla a propósito; el backend además le niega abrir
 * cualquier otra orden pendiente, así que esto no es un adorno de interfaz.
 *
 * El contador ("vas por la 2 de 6") es la pieza que evita que se sienta un error: sin
 * él, una pantalla con una sola tarjeta no distingue "esto es todo lo que hay" de "hay
 * más, pero después".
 */
export function VisitaEnTurno({
  d,
  onApartada,
}: {
  d: MiTurno;
  onApartada: (motivo: string) => Promise<string | null>;
}) {
  const [abrirModal, setAbrirModal] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const o = d.visita;
  if (!o) return null;

  const tono = TICKET_PRIORITY_TONE[o.priority ?? ""] ?? "default";
  const posicion = d.hechas + 1;

  const confirmar = async () => {
    const texto = motivo.trim();
    if (!texto) return setError("Dinos por qué no se pudo hacer.");
    setEnviando(true);
    setError(null);
    const err = await onApartada(texto);
    setEnviando(false);
    if (err) return setError(err);
    setAbrirModal(false);
    setMotivo("");
  };

  return (
    <>
      <div className="flex flex-col gap-3 rounded-xl border-2 border-brand/50 bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand px-3 py-1 text-[11.5px] font-bold uppercase tracking-wide text-on-brand">
            <Icon name="arrow-right" size={13} /> Tu visita ahora
          </span>
          <span className="text-[12px] font-semibold text-text-secondary">
            {posicion} de {d.total}
          </span>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="text-[17px] font-bold text-text-primary">{o.type}</h2>
            <span className="font-mono text-[11px] text-text-tertiary">#{o.code ?? "—"}</span>
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>
              {o.priority ?? "—"}
            </span>
            {o.status === "REALIZANDO" && (
              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-warning-text">
                En curso
              </span>
            )}
          </div>
          {o.cliente && (
            <p className="mt-1 text-[14px] font-semibold text-text-primary">
              {o.cliente}
              {o.abonado ? <span className="font-normal text-text-tertiary"> · {o.abonado}</span> : null}
            </p>
          )}
          {(o.direccion || o.barrio) && (
            <p className="mt-1 flex items-start gap-1.5 text-[13px] text-text-secondary">
              <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
              <span>
                {o.direccion ?? ""}
                {o.barrio ? ` (${o.barrio})` : ""}
              </span>
            </p>
          )}
        </div>

        {/* Llamar y "cómo llegar" van ARRIBA del botón de abrir: son lo que necesita
            antes de tocar la puerta, no después. */}
        <div className="flex flex-wrap gap-2">
          {o.telefono && (
            <a
              href={`tel:${o.telefono}`}
              className="tap inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border-default px-3 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
            >
              <Icon name="phone" size={14} /> Llamar
            </a>
          )}
          {o.subscriberId && (
            <Link
              href={`/mapa/ruta?abonado=${o.subscriberId}&volver=${encodeURIComponent("/mi-agenda")}`}
              className="tap inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border-default px-3 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
            >
              <Icon name="map-pin" size={14} /> Cómo llegar
            </Link>
          )}
        </div>

        <Link
          href={`/soporte/${o.id}`}
          className="tap inline-flex min-h-[46px] items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[14px] font-bold text-on-brand transition-opacity hover:opacity-90"
        >
          <Icon name="clipboard-check" size={16} /> Abrir la orden
        </Link>

        <button
          type="button"
          onClick={() => setAbrirModal(true)}
          className="tap inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-border-default px-3 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
        >
          <Icon name="alert-triangle" size={14} /> No se pudo atender
        </button>
      </div>

      <Modal open={abrirModal} onClose={() => setAbrirModal(false)} title="¿Por qué no se pudo atender?">
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-text-secondary">
            La orden <b>no se cierra</b>: vuelve a la persona de caja con tu motivo para que la
            reagende. Después de esto te aparece la siguiente visita.
          </p>

          <div className="flex flex-wrap gap-1.5">
            {MOTIVOS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMotivo(m)}
                className={`tap rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                  motivo === m
                    ? "border-brand bg-brand-soft text-text-primary"
                    : "border-border-default text-text-secondary hover:bg-surface-2"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="Cuenta qué pasó…"
            className="w-full rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-brand"
          />

          {error && (
            <p className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAbrirModal(false)} disabled={enviando}>
              Cancelar
            </Button>
            <Button onClick={() => void confirmar()} disabled={enviando || !motivo.trim()}>
              {enviando ? "Guardando…" : "Confirmar"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
