"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { TICKET_PRIORITIES } from "@/lib/support";
import { MS_DIA, diaISO, finDe, inicioDe, paraInput, type Evento } from "./calendario";

/** Paleta de arranque, la de Google: un color por tipo de compromiso. */
const COLORES = [
  { hex: "#6366f1", nombre: "Índigo" },
  { hex: "#0ea5e9", nombre: "Azul" },
  { hex: "#10b981", nombre: "Verde" },
  { hex: "#f59e0b", nombre: "Ámbar" },
  { hex: "#ef4444", nombre: "Rojo" },
  { hex: "#a855f7", nombre: "Morado" },
  { hex: "#64748b", nombre: "Gris" },
];

const COLOR_POR_DEFECTO = COLORES[0].hex;

type Formulario = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  color: string;
  priority: string;
  description: string;
};

/**
 * Crear, editar y borrar un evento de la agenda.
 *
 * ── EL EVENTO DE TODO EL DÍA GUARDA SU FIN EN LA MEDIANOCHE SIGUIENTE ────────
 * Quien escribe «del 3 al 5» quiere los tres días, el 5 incluido. Guardar el fin en
 * la medianoche del 5 dejaría el evento acabando justo cuando el 5 empieza, y en la
 * rejilla desaparecería del último día — el clásico «se me borró un día». Se guarda
 * el instante en que ese día TERMINA (las 00:00 del 6) y al editar se resta para
 * volver a enseñar el 5. La conversión vive aquí, en el único sitio donde se teclea
 * una fecha de todo el día.
 */
export function EventoModal({
  abierto,
  evento,
  fechaSugerida,
  onCerrar,
  onGuardado,
}: {
  abierto: boolean;
  /** `null` = alta. Con evento, se edita ése. */
  evento: Evento | null;
  /** Dónde se pulsó en la rejilla: es la fecha/hora que se propone al crear. */
  fechaSugerida: Date | null;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState<Formulario>(() => vacio(null));
  const [guardando, setGuardando] = useState(false);
  const [confirmandoBorrado, setConfirmandoBorrado] = useState(false);

  const set = <K extends keyof Formulario>(k: K, v: Formulario[K]) => setForm((f) => ({ ...f, [k]: v }));

  // El formulario se rearma en cada APERTURA, no en cada render: si dependiera del
  // objeto `evento` a secas, cada refresco del calendario devolvería los campos a
  // como estaban en la base y se perdería lo que se estuviera escribiendo.
  useEffect(() => {
    if (!abierto) return;
    setConfirmandoBorrado(false);
    setForm(evento ? deEvento(evento) : vacio(fechaSugerida));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, evento?.id]);

  async function guardar() {
    if (!form.start) { toast("Indica cuándo empieza", "alert-triangle"); return; }

    const inicio = form.allDay ? new Date(`${form.start}T00:00:00`) : new Date(form.start);
    if (Number.isNaN(inicio.getTime())) { toast("La fecha de inicio no es válida", "alert-triangle"); return; }

    let fin: Date | null = null;
    if (form.allDay) {
      // El día que se teclea es INCLUSIVO: se guarda el final de ese día (ver cabecera).
      const ultimo = form.end ? new Date(`${form.end}T00:00:00`) : new Date(`${form.start}T00:00:00`);
      if (Number.isNaN(ultimo.getTime())) { toast("La fecha de fin no es válida", "alert-triangle"); return; }
      fin = new Date(ultimo.getTime() + MS_DIA);
    } else if (form.end) {
      fin = new Date(form.end);
      if (Number.isNaN(fin.getTime())) { toast("La fecha de fin no es válida", "alert-triangle"); return; }
    }
    if (fin && fin.getTime() <= inicio.getTime()) {
      toast("El evento no puede terminar antes de empezar", "alert-triangle");
      return;
    }

    setGuardando(true);
    try {
      const cuerpo = {
        title: form.title.trim() || undefined,
        description: form.description.trim() || undefined,
        color: form.color,
        priority: form.priority || "Media",
        allDay: form.allDay,
        start: inicio.toISOString(),
        // `null` y no `undefined` al editar: quitarle el fin a un evento que lo tenía
        // es un cambio, y con `undefined` el PATCH no lo miraría (ver `updateEvent`).
        end: fin ? fin.toISOString() : evento ? null : undefined,
      };
      const res = await authFetch(evento ? `/omni/events/${evento.id}` : "/omni/events", {
        method: evento ? "PATCH" : "POST",
        body: JSON.stringify(cuerpo),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(evento ? "Evento actualizado" : "Evento agendado", "check");
      onGuardado();
      onCerrar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setGuardando(false);
    }
  }

  async function borrar() {
    if (!evento) return;
    setGuardando(true);
    try {
      const res = await authFetch(`/omni/events/${evento.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo eliminar");
      toast("Evento eliminado", "check");
      onGuardado();
      onCerrar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal open={abierto} onClose={onCerrar} title={evento ? "Editar evento" : "Nuevo evento"} maxWidth="max-w-lg">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Título">
            <Input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Reunión de equipo, visita a cliente, llamada…"
              autoFocus
            />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px] font-semibold text-text-secondary">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => set("allDay", e.target.checked)}
              className="h-4 w-4 accent-[var(--color-brand)]"
            />
            Todo el día
          </label>
        </div>

        {/*
          Los dos campos cambian de tipo con el interruptor y no se esconde uno: un
          evento de todo el día también puede durar varios (una capacitación, unas
          vacaciones), y ahí el "hasta" sigue haciendo falta — sin hora.
        */}
        <Field label={form.allDay ? "Desde" : "Inicio"} required>
          <Input
            type={form.allDay ? "date" : "datetime-local"}
            value={form.start}
            onChange={(e) => set("start", e.target.value)}
          />
        </Field>
        <Field label={form.allDay ? "Hasta (incluido)" : "Fin"}>
          <Input
            type={form.allDay ? "date" : "datetime-local"}
            value={form.end}
            min={form.allDay ? form.start || undefined : undefined}
            onChange={(e) => set("end", e.target.value)}
          />
        </Field>

        <Field label="Prioridad">
          <Select value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>

        <Field label="Color">
          {/*
            Siete colores a un clic y el selector libre al lado. La paleta está porque
            el color aquí es una CATEGORÍA («esto es una reunión»), y para eso hacen
            falta pocos y siempre los mismos; la rueda completa está detrás por si el
            que hace falta no está entre los siete.
          */}
          <div className="flex items-center gap-1.5">
            {COLORES.map((c) => (
              <button
                type="button"
                key={c.hex}
                title={c.nombre}
                aria-label={c.nombre}
                aria-pressed={form.color.toLowerCase() === c.hex}
                onClick={() => set("color", c.hex)}
                style={{ backgroundColor: c.hex }}
                className={`foco h-6 w-6 rounded-full transition-transform ${
                  form.color.toLowerCase() === c.hex
                    ? "scale-110 ring-2 ring-border-strong ring-offset-2 ring-offset-[var(--color-surface)]"
                    : "hover:scale-110"
                }`}
              />
            ))}
            <input
              type="color"
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
              title="Otro color"
              aria-label="Otro color"
              className="h-6 w-8 cursor-pointer rounded border border-border-default bg-surface p-0"
            />
          </div>
        </Field>

        <div className="sm:col-span-2">
          <Field label="Descripción">
            <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
      </div>

      {/* Lo que el evento arrastra y aquí no se edita: de dónde salió y quién lo puso. */}
      {evento && (evento.orderNo || evento.assignedBy) && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-tertiary">
          {evento.orderNo != null && (
            <span className="inline-flex items-center gap-1">
              <Icon name="receipt" size={12} /> Orden <span className="font-mono tabular-nums">#{evento.orderNo}</span>
            </span>
          )}
          {evento.assignedBy && (
            <span className="inline-flex items-center gap-1">
              <Icon name="user" size={12} /> Agendó {evento.assignedBy}
            </span>
          )}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        {evento ? (
          /* La confirmación va EN LÍNEA y no en otro diálogo encima de éste: dos capas
             de modal dejan el foco atrapado en la de abajo al cerrarse la de arriba. */
          confirmandoBorrado ? (
            <span className="flex items-center gap-2 text-[12px] text-text-secondary">
              ¿Eliminar?
              <button type="button" onClick={borrar} disabled={guardando} className="foco font-bold text-error-text hover:underline">Sí, eliminar</button>
              <button type="button" onClick={() => setConfirmandoBorrado(false)} className="foco font-semibold text-text-tertiary hover:underline">No</button>
            </span>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmandoBorrado(true)} disabled={guardando}>
              <Icon name="trash" size={14} /> Eliminar
            </Button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCerrar} disabled={guardando}>Cancelar</Button>
          <Button onClick={guardar} disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Formulario en blanco, con la fecha/hora de donde se pulsó (o la próxima hora en punto). */
function vacio(sugerida: Date | null): Formulario {
  const inicio = sugerida ?? proximaHoraEnPunto();
  const fin = new Date(inicio.getTime() + 60 * 60_000);
  return {
    title: "",
    start: paraInput(inicio),
    end: paraInput(fin),
    allDay: false,
    color: COLOR_POR_DEFECTO,
    priority: "Media",
    description: "",
  };
}

function proximaHoraEnPunto(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return new Date(d.getTime() + 60 * 60_000);
}

function deEvento(e: Evento): Formulario {
  const inicio = inicioDe(e);
  if (e.allDay) {
    // De vuelta al día inclusivo: el guardado apunta a la medianoche siguiente.
    const ultimo = e.end ? new Date(new Date(e.end).getTime() - 1) : inicio;
    return {
      title: e.title ?? "",
      start: diaISO(inicio),
      end: diaISO(ultimo),
      allDay: true,
      color: e.color || COLOR_POR_DEFECTO,
      priority: e.priority ?? "Media",
      description: e.description ?? "",
    };
  }
  return {
    title: e.title ?? "",
    start: paraInput(inicio),
    end: e.end ? paraInput(new Date(e.end)) : paraInput(finDe(e)),
    allDay: false,
    color: e.color || COLOR_POR_DEFECTO,
    priority: e.priority ?? "Media",
    description: e.description ?? "",
  };
}
