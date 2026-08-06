"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { listaJson, mensajeDeError } from "@/lib/errores";
import { TICKET_PRIORITIES } from "@/lib/support";

/** Una clase de orden con sus detalles, tal como la sirve `/support/order-catalog`. */
type ClaseOrden = { clase: string; etiqueta: string; descripcion: string; detalles: string[] };

/** Hoy en Colombia, en el formato que espera <input type="date">. */
const hoy = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());

/**
 * Nueva orden de trabajo.
 *
 * La estructura la manda el legacy: una orden es de una CLASE (servicio, reclamo o
 * incidente) y dentro de ella tiene un DETALLE concreto ('Corte Internet',
 * 'Revision de Internet'…). Antes este formulario pedía un "Asunto" libre que caía
 * justo en la columna de la clase, así que las órdenes nuevas guardaban prosa donde
 * las 320.000 del legacy tienen una de tres palabras. El catálogo llega del backend
 * (`/support/order-catalog`), que es el mismo con el que se enderezan las órdenes
 * que entran por el chatbot.
 */
export function NuevaOrdenModal({ open, onClose, onDone, fixedSub }: { open: boolean; onClose: () => void; onDone: () => void; fixedSub?: PickedSub | null }) {
  const { authFetch } = useAuth();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [catalogo, setCatalogo] = useState<ClaseOrden[]>([]);
  const [clase, setClase] = useState("servicio");
  const [type, setType] = useState("");
  const [assigned, setAssigned] = useState("");
  const [priority, setPriority] = useState("Media");
  const [agendar, setAgendar] = useState(false);
  const [fecha, setFecha] = useState(hoy());
  const [section, setSection] = useState("");
  const [techs, setTechs] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSub(fixedSub ?? null); setAssigned(""); setSection(""); setErr(null);
    setClase("servicio"); setType(""); setPriority("Media"); setAgendar(false); setFecha(hoy());
    void authFetch("/support/technicians").then(listaJson).then(setTechs).catch(() => {});
    void authFetch("/support/order-catalog").then(listaJson).then(setCatalogo).catch(() => {});
  }, [open, authFetch, fixedSub]);

  const claseActual = useMemo(() => catalogo.find((c) => c.clase === clase) ?? null, [catalogo, clase]);

  // Al cambiar de clase, el detalle anterior deja de existir: se elige el primero de
  // la nueva en vez de dejar puesto uno que no pertenece a esa clase.
  useEffect(() => {
    if (!claseActual) return;
    setType((t) => (claseActual.detalles.includes(t) ? t : claseActual.detalles[0] ?? ""));
  }, [claseActual]);

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    if (!type) { setErr("Elige el detalle de la orden."); return; }
    if (agendar && !assigned) { setErr("Para agendarla hay que decir qué técnico la atiende."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/support/tickets", {
        method: "POST",
        body: JSON.stringify({
          subscriberId: sub.id,
          subject: clase,
          type,
          assigned: assigned || undefined,
          priority,
          section: section || undefined,
          scheduledFor: agendar ? fecha : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la orden");
      toast(agendar ? `Orden #${d.code} creada y agendada` : `Orden #${d.code} creada`);
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva orden de trabajo" maxWidth="max-w-xl">
      <div className="flex flex-col gap-3">
        <Field label="Cliente" required>
          {fixedSub ? (
            <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] font-semibold text-text-primary">
              {fixedSub.name}
              {fixedSub.abonado != null && <span className="font-mono text-[11px] font-normal text-text-tertiary">#{fixedSub.abonado}</span>}
            </div>
          ) : (
            <SubscriberPicker value={sub} onChange={setSub} />
          )}
        </Field>

        {/* La clase primero y con botones, no en un desplegable: son tres y de ellas
            depende todo lo demás, así que conviene verlas de una. */}
        <Field label="Clase de orden" required>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {catalogo.map((c) => {
              const activa = c.clase === clase;
              return (
                <button
                  key={c.clase}
                  type="button"
                  title={c.descripcion}
                  onClick={() => setClase(c.clase)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    activa
                      ? "border-brand bg-brand-soft"
                      : "border-border-default bg-surface hover:bg-surface-2"
                  }`}
                >
                  <span className={`block text-[13px] font-semibold ${activa ? "text-text-primary" : "text-text-secondary"}`}>
                    {c.etiqueta}
                  </span>
                  <span className="block text-[11px] leading-snug text-text-tertiary">{c.descripcion}</span>
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Detalle" required hint={claseActual ? `Lo que se va a hacer (${claseActual.detalles.length} opciones)` : undefined}>
            <Select value={type} onChange={(e) => setType(e.target.value)} disabled={!claseActual}>
              {(claseActual?.detalles ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Técnico asignado" hint={agendar ? "Obligatorio para agendar" : undefined}>
            <Select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
              <option value="">— Sin asignar —</option>
              {techs.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Prioridad" hint="Manda el orden en que se reparte y se atiende">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
        </div>

        {/* Agendar o no: sin agendar, la orden entra a la bandeja y la cajera la
            reparte después desde el tablero; agendada, entra directo a la cola del
            técnico ese día. */}
        <Field label="¿Se va a agendar?">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="grid grid-cols-2 gap-2 sm:w-72">
              <button
                type="button"
                onClick={() => setAgendar(false)}
                className={`rounded-lg border px-3 py-2 text-[13px] font-semibold transition-colors ${
                  !agendar ? "border-brand bg-brand-soft text-text-primary" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
                }`}
              >
                No por ahora
              </button>
              <button
                type="button"
                onClick={() => setAgendar(true)}
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-semibold transition-colors ${
                  agendar ? "border-brand bg-brand-soft text-text-primary" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
                }`}
              >
                <Icon name="calendar-clock" size={14} /> Agendar
              </button>
            </div>
            {agendar ? (
              <Input type="date" value={fecha} min={hoy()} onChange={(e) => setFecha(e.target.value)} className="sm:w-48" />
            ) : (
              <span className="text-[11px] text-text-tertiary">Queda en la bandeja de sin agendar.</span>
            )}
          </div>
        </Field>

        <Field label="Observación" hint="Lo que hay que saber para atenderla: qué reporta el cliente, el paquete, la referencia…">
          <Textarea rows={3} value={section} onChange={(e) => setSection(e.target.value)} placeholder="Ej: el cliente reporta que no le funciona el canal 12 desde ayer" />
        </Field>

        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !sub}>{saving ? "Creando…" : agendar ? "Crear y agendar" : "Crear orden"}</Button>
        </div>
      </div>
    </Modal>
  );
}
