"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

type Call = {
  id: string; callType: string | null; responseType: string | null; responseDetail: string | null;
  responsible: string | null; date: string | null; time: string | null; dueDate: string | null;
  notes: string | null; isAgreement: boolean;
};

/**
 * La cascada del formulario de llamadas la sirve el backend
 * (`GET /collections/catalog`, `collections/llamada-catalogo.ts`) para que la
 * pantalla y la validación no se puedan desincronizar: es el mismo catálogo con
 * el que están escritas las 110.426 llamadas del legacy.
 */
type Catalogo = {
  tipos: { value: string; label: string }[];
  respuestasPorTipo: Record<string, string[]>;
  detallesPorRespuesta: Record<string, string[]>;
  venta: { tipo: string; respuesta: string; planesInternet: string[] };
  acuerdo: string;
};

function fmtDate(d?: string | null) {
  return d ? new Date(d + "T00:00:00").toLocaleDateString("es-CO") : "—";
}

/** Hora del momento en HH:mm, que es como la guarda el legacy (`llamadas.hra`). */
function horaAhora() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** La misma hora, escrita como la enseña el legacy en su formulario ("3:05 pm"). */
function horaVisible(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h < 12 ? "am" : "pm";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function CobranzaPanel({ subscriberId }: { subscriberId: string }) {
  const { authFetch, user } = useAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [cat, setCat] = useState<Catalogo | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Los tres desplegables encadenados del legacy + lo que cuelga de ellos.
  const [tipo, setTipo] = useState("");
  const [respuesta, setRespuesta] = useState("");
  const [detalle, setDetalle] = useState("");
  const [conTv, setConTv] = useState(false);
  const [planNet, setPlanNet] = useState("");
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [hora, setHora] = useState(horaAhora);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmar, setConfirmar] = useState<Call | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/collections/subscriber/${subscriberId}`);
      setCalls(await res.json());
    } catch { toast("No se pudo cargar la bitácora", "alert-triangle"); }
    finally { setLoading(false); }
  }, [authFetch, subscriberId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void authFetch("/collections/catalog").then((r) => r.json()).then(setCat).catch(() => {});
  }, [authFetch]);

  // Es la venta: el detalle no se elige de una lista, se arma con lo vendido.
  const esVenta = !!cat && tipo === cat.venta.tipo && respuesta === cat.venta.respuesta;
  // El detalle de la venta ('Tv', '100 Megas F-26', 'Tv+100 Megas F-26'): mismo
  // texto que compone el legacy, para que los informes de ventas sigan cuadrando.
  const detalleVenta = useMemo(() => {
    if (!esVenta) return "";
    if (conTv && planNet) return `Tv+${planNet}`;
    if (conTv) return "Tv";
    return planNet;
  }, [esVenta, conTv, planNet]);
  const detalleFinal = esVenta ? detalleVenta : detalle;
  const esAcuerdo = !!cat && detalleFinal.toLowerCase() === cat.acuerdo.toLowerCase();

  const respuestas = cat && tipo ? cat.respuestasPorTipo[tipo] ?? [] : [];
  const detalles = cat && respuesta ? cat.detallesPorRespuesta[respuesta] ?? [] : [];

  function openModal() {
    setTipo(""); setRespuesta(""); setDetalle(""); setConTv(false); setPlanNet("");
    setFecha(new Date().toISOString().slice(0, 10)); setHora(horaAhora());
    setDueDate(new Date().toISOString().slice(0, 10)); setNotes("");
    setOpen(true);
  }

  // Cambiar un eslabón vacía los de abajo: si no, quedaría un detalle que no
  // pertenece a la respuesta elegida (el legacy hace lo mismo en `change`).
  function cambiarTipo(v: string) { setTipo(v); setRespuesta(""); setDetalle(""); setConTv(false); setPlanNet(""); }
  function cambiarRespuesta(v: string) { setRespuesta(v); setDetalle(""); setConTv(false); setPlanNet(""); }

  async function submit() {
    if (!tipo) { toast("Elija el tipo de atención", "alert-triangle"); return; }
    if (!respuesta) { toast("Elija el tipo de respuesta", "alert-triangle"); return; }
    if (!detalleFinal) { toast(esVenta ? "Indique qué se vendió (TV y/o internet)" : "Elija el detalle de la respuesta", "alert-triangle"); return; }
    if (esAcuerdo && !dueDate) { toast("El acuerdo de pago requiere la fecha de vencimiento", "alert-triangle"); return; }
    // Observación obligatoria, como en el legacy (su `farmCheck` cuenta los
    // `.required` vacíos y el textarea lleva la clase): sin la nota, el registro
    // dice que se llamó pero no qué pasó.
    if (!notes.trim()) { toast("Escriba la observación", "alert-triangle"); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/collections`, {
        method: "POST",
        body: JSON.stringify({
          subscriberId, callType: tipo, responseType: respuesta, responseDetail: detalleFinal,
          date: fecha, time: hora || undefined, dueDate: esAcuerdo ? dueDate : undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo registrar");
      toast(esAcuerdo ? "Acuerdo registrado · cliente en COMPROMISO" : "Registro agregado", "check");
      setOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setSaving(false); }
  }

  async function remove(id: string) {
    setConfirmBusy(true);
    try {
      const res = await authFetch(`/collections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Eliminado", "check"); void load();
    } catch { toast("No se pudo eliminar", "alert-triangle"); }
    finally { setConfirmBusy(false); setConfirmar(null); }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
          <Icon name="hand-coins" size={16} /> Cobranza · Llamadas y acuerdos
          {calls.length > 0 && <span className="text-[12px] font-normal text-text-tertiary">({calls.length})</span>}
        </h2>
        <Button variant="secondary" size="sm" onClick={openModal}><Icon name="phone" size={14} /> Nuevo registro</Button>
      </div>

      {loading ? (
        <p className="text-[12px] text-text-tertiary">Cargando…</p>
      ) : calls.length === 0 ? (
        <p className="text-[12px] text-text-tertiary">Sin llamadas registradas. Un «Acuerdo de Pago» pone al cliente en COMPROMISO y lo protege del corte masivo hasta la fecha pactada.</p>
      ) : (
        // Mismas columnas que la bitácora del legacy, en el mismo orden.
        <DataTable
          rows={calls}
          empty="Sin llamadas registradas."
          columns={[
            { key: "date", header: "Fecha", render: (c) => <span className="whitespace-nowrap">{fmtDate(c.date)}</span>, sortValue: (c) => c.date ?? "" },
            { key: "time", header: "Hora", render: (c) => <span className="whitespace-nowrap text-text-secondary">{c.time ? horaVisible(c.time) : "—"}</span> },
            { key: "responsible", header: "Realizado por", render: (c) => c.responsible ?? "—" },
            { key: "callType", header: "Tpo atención", render: (c) => c.callType ?? "—" },
            { key: "responseType", header: "Tpo respuesta", render: (c) => c.responseType ?? "—" },
            {
              key: "responseDetail",
              header: "Detalle",
              render: (c) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-text-primary">{c.responseDetail ?? "—"}</span>
                  {c.isAgreement && <Badge label={`Vence ${fmtDate(c.dueDate)}`} tone="warning" />}
                </span>
              ),
            },
            { key: "notes", header: "Observación", render: (c) => <span className="text-text-secondary">{c.notes || "—"}</span> },
            {
              key: "acciones",
              header: "",
              align: "right",
              render: (c) => (
                <button onClick={() => setConfirmar(c)} className="tap text-text-tertiary hover:text-error-text" title="Eliminar">
                  <Icon name="trash" size={15} />
                </button>
              ),
            },
          ]}
        />
      )}

      {/* Formulario "NUEVO REGISTRO" del legacy (/llamadas/index?id=…), con la
          misma cascada, los mismos campos fijos y la misma regla de la fecha de
          vencimiento (sólo aparece en el acuerdo de pago). */}
      <Modal open={open} onClose={() => setOpen(false)} title="Nuevo registro" maxWidth="max-w-2xl">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tipo de Atencion" required>
            <Select value={tipo} onChange={(e) => cambiarTipo(e.target.value)}>
              <option value="">seleccione</option>
              {(cat?.tipos ?? []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>

          <Field label="Tipo de respuesta" required>
            <Select value={respuesta} onChange={(e) => cambiarRespuesta(e.target.value)} disabled={!tipo}>
              <option value="">seleccione</option>
              {respuestas.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>

          <Field label="Detalle de respuesta" required hint={esVenta ? "Se arma con lo que se vendió" : undefined}>
            {esVenta ? (
              // Venta contestada: el legacy cambia el desplegable por dos, TV e
              // internet, y compone el detalle con lo elegido.
              <div className="flex gap-2">
                <Select value={conTv ? "con-tv" : ""} onChange={(e) => setConTv(e.target.value === "con-tv")} className="w-[35%]">
                  <option value="">Sin Tv</option>
                  <option value="con-tv">Tv</option>
                </Select>
                <Select value={planNet} onChange={(e) => setPlanNet(e.target.value)} className="flex-1">
                  <option value="">Sin Internet</option>
                  {(cat?.venta.planesInternet ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </div>
            ) : (
              <Select value={detalle} onChange={(e) => setDetalle(e.target.value)} disabled={!respuesta}>
                <option value="">seleccione</option>
                {detalles.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
            )}
          </Field>

          <Field label="Responsable" hint="Queda a su nombre">
            <Input value={user?.name ?? ""} readOnly disabled />
          </Field>

          <Field label="Fecha">
            <Input value={fmtDate(fecha)} readOnly disabled />
          </Field>

          <Field label="Hora">
            <Input value={horaVisible(hora)} readOnly disabled />
          </Field>

          {esAcuerdo && (
            <Field label="Fecha de vencimiento" required hint="Hasta cuándo se compromete a pagar">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          )}

          <div className="sm:col-span-2">
            <Field label="Observacion" required>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Qué dijo el cliente" />
            </Field>
          </div>
        </div>

        {esVenta && (
          <p className="mt-2 text-[12px] text-text-tertiary">
            Quedará registrado como <strong>{detalleVenta || "— elija TV y/o internet —"}</strong>.
          </p>
        )}
        {esAcuerdo && (
          <p className="mt-2 text-[12px] text-warning-text">
            Al guardar, el cliente pasa a <strong>COMPROMISO</strong> y queda protegido del corte masivo hasta la fecha de vencimiento.
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Volver</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Registrar"}</Button>
        </div>
      </Modal>

      {confirmar && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void remove(confirmar.id)}
          tone="danger"
          icon="trash"
          title="Eliminar registro"
          confirmLabel="Eliminar"
          message={
            confirmar.isAgreement
              ? "Se borra el registro de la llamada. El cliente NO sale de COMPROMISO por esto: el estado se cambia desde su ficha."
              : "Se borra el registro de la llamada de la bitácora. No se puede deshacer."
          }
        />
      )}
    </div>
  );
}
