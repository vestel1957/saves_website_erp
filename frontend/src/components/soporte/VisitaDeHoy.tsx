"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { TICKET_PRIORITY_TONE } from "@/lib/support";
import { ACCEPT_IMAGEN } from "@/lib/adjuntos";
import { EtiquetaAtrasada, type OrdenAgendada } from "@/components/soporte/VisitaAgendada";

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
 * Tope de la foto, el mismo que aplica multer en `/tickets/:id/attach` (15 MB).
 * Se comprueba aquí también para no gastarle los datos al técnico en una subida
 * que el servidor va a rechazar al final — en la calle eso son varios minutos.
 */
const MAX_FOTO_MB = 15;

/**
 * La visita que le toca al técnico AHORA, y solo esa.
 *
 * Con el turno obligatorio (2026-08-04, retirado el 28 y **restituido el 2026-09-02**
 * a pedido del usuario) esta tarjeta vuelve a ser la única de la pantalla: el técnico
 * ve una visita y hasta que no la cierra —o la aparta con un motivo— no aparece la
 * siguiente. El candado de verdad está en el backend (`support/turno.ts`), así que
 * esto no es un adorno de interfaz.
 *
 * Lleva dirección, barrio y teléfono a la vista y no detrás de un clic: es lo que
 * necesita antes de arrancar, y abrir la orden para leerlo le cuesta datos en la calle.
 *
 * El contador de arriba ("2 de 6") no es adorno: es lo único que impide que una
 * pantalla con una sola tarjeta se lea como "esto es todo lo que hay". Lleva el puesto
 * de la visita dentro de la jornada, que con el turno vuelve a ser una instrucción y
 * no una sugerencia — es el orden en que se atienden.
 */
export function VisitaDeHoy({
  o,
  posicion,
  total,
  libre = false,
  onApartada,
}: {
  o: OrdenAgendada;
  /** Cuál es de la jornada, contando las que ya cerró. Sin esto no se pinta el contador. */
  posicion?: number;
  total?: number;
  /**
   * El técnico está exento del turno (`Staff.agendaLibre`): esta tarjeta deja de ser
   * "la única que puedes abrir" y pasa a ser por dónde le toca empezar. Sólo cambia
   * el rótulo — decirle "tu visita ahora" a quien tiene el día entero delante y puede
   * elegir sería describirle una regla que a él no le rige.
   */
  libre?: boolean;
  onApartada: (ticketId: string, motivo: string, foto: File | null) => Promise<string | null>;
}) {
  const [abrirModal, setAbrirModal] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tono = TICKET_PRIORITY_TONE[o.priority ?? ""] ?? "default";

  const cerrar = () => {
    setAbrirModal(false);
    setMotivo("");
    setFoto(null);
    setError(null);
  };

  const confirmar = async () => {
    const texto = motivo.trim();
    if (!texto) return setError("Dinos por qué no se pudo hacer.");
    if (foto && foto.size > MAX_FOTO_MB * 1024 * 1024) {
      return setError(`La foto pesa más de ${MAX_FOTO_MB} MB. Toma otra o quítala y confirma sin ella.`);
    }
    setEnviando(true);
    setError(null);
    const err = await onApartada(o.id, texto, foto);
    setEnviando(false);
    if (err) return setError(err);
    cerrar();
  };

  return (
    <>
      <div className="flex flex-col gap-3 rounded-xl border-2 border-brand/50 bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand px-3 py-1 text-[11.5px] font-bold uppercase tracking-wide text-on-brand">
            <Icon name="arrow-right" size={13} /> {libre ? "Empieza por aquí" : "Tu visita ahora"}
          </span>
          {posicion && total ? (
            <span className="text-[12px] font-semibold text-text-secondary">
              {posicion} de {total}
            </span>
          ) : null}
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
            {o.atrasada && <EtiquetaAtrasada desde={o.agendadaPara} />}
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
          className="tap inline-flex min-h-[46px] items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[14px] font-bold text-on-brand transition-opacity hover:opacity-90 sm:self-start sm:px-8"
        >
          <Icon name="clipboard-check" size={16} /> Abrir la orden
        </Link>

        <button
          type="button"
          onClick={() => setAbrirModal(true)}
          className="tap inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-border-default px-3 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2 sm:self-start sm:px-5"
        >
          <Icon name="alert-triangle" size={14} /> No se pudo atender
        </button>
      </div>

      <Modal open={abrirModal} onClose={cerrar} title="¿Por qué no se pudo atender?">
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-text-secondary">
            La orden <b>no se cierra</b>: sale de tu día de hoy y vuelve a la persona de caja con
            tu motivo, para que ella decida cuándo repetirla.
            {libre ? "" : " Después de esto te aparece la siguiente visita."}
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

          {/* Foto de evidencia, OPCIONAL (2026-08-26, a pedido del usuario).
              Es la diferencia entre "el cliente no estaba" y "el cliente no
              estaba, y aquí está la casa cerrada": quien reagenda deja de tener
              que creer o dudar, y el técnico deja de tener que discutirlo.

              Opcional a conciencia y así hay que dejarlo: exigirla dejaría al
              técnico sin poder devolver la visita cada vez que no haya señal para
              subir la imagen, justo donde peor viene — en la calle y con el
              cliente ausente. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Cámara y galería por separado: `capture` abre la cámara saltándose el
                selector, y así el técnico que ya tomó la foto antes (o la recibió por
                WhatsApp) no tenía forma de adjuntarla desde la galería. */}
            <label className="tap inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              <Icon name="camera" size={14} /> {foto ? "Cambiar foto" : "Tomar foto (opcional)"}
              <input
                type="file"
                accept={ACCEPT_IMAGEN}
                capture="environment"
                className="hidden"
                onChange={(e) => setFoto(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="tap inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              <Icon name="image" size={14} /> Galería
              <input
                type="file"
                accept={ACCEPT_IMAGEN}
                className="hidden"
                onChange={(e) => setFoto(e.target.files?.[0] ?? null)}
              />
            </label>
            {foto && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <Icon name="file-text" size={12} />
                <span className="max-w-[10rem] truncate">{foto.name}</span>
                <button
                  type="button"
                  onClick={() => setFoto(null)}
                  aria-label="Quitar la foto"
                  className="text-error-text hover:underline"
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
          </div>
          {foto && (
            <p className="text-[10px] text-text-tertiary">
              La foto queda en el historial de la orden. Se intentará adjuntar tu ubicación (requiere
              HTTPS; sobre HTTP sube sin coordenadas).
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={cerrar} disabled={enviando}>
              Cancelar
            </Button>
            <Button onClick={() => void confirmar()} disabled={enviando || !motivo.trim()}>
              {enviando ? (foto ? "Subiendo foto…" : "Guardando…") : "Confirmar"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
