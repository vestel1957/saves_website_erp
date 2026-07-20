"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

type Call = {
  id: string; callType: string | null; responseType: string | null; responseDetail: string | null;
  responsible: string | null; date: string | null; time: string | null; dueDate: string | null;
  notes: string | null; isAgreement: boolean;
};

const RESPONSE_DETAILS = ["Acuerdo de Pago", "No contesta", "Sin respuesta", "Número equivocado", "Solicitud de descuento", "Reclamo", "Otro"];
const CALL_TYPES = ["Saliente", "Entrante", "WhatsApp", "Visita", "Otro"];

function fmtDate(d?: string | null) {
  return d ? new Date(d + "T00:00:00").toLocaleDateString("es-CO") : "—";
}

export function CobranzaPanel({ subscriberId }: { subscriberId: string }) {
  const { authFetch } = useAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [callType, setCallType] = useState("Saliente");
  const [responseDetail, setResponseDetail] = useState("Acuerdo de Pago");
  const [responseType, setResponseType] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/collections/subscriber/${subscriberId}`);
      setCalls(await res.json());
    } catch { toast("No se pudo cargar la bitácora", "alert-triangle"); }
    finally { setLoading(false); }
  }, [authFetch, subscriberId]);

  useEffect(() => { void load(); }, [load]);

  function openModal() {
    setCallType("Saliente"); setResponseDetail("Acuerdo de Pago"); setResponseType("");
    setDate(new Date().toISOString().slice(0, 10)); setTime(""); setDueDate(""); setNotes("");
    setOpen(true);
  }

  async function submit() {
    const isAgreement = responseDetail === "Acuerdo de Pago";
    if (isAgreement && !dueDate) { toast("El acuerdo de pago requiere la fecha de compromiso", "alert-triangle"); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/collections`, {
        method: "POST",
        body: JSON.stringify({ subscriberId, callType, responseDetail, responseType: responseType || undefined, date, time: time || undefined, dueDate: isAgreement ? dueDate : undefined, notes: notes || undefined }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo registrar");
      toast(isAgreement ? "Acuerdo registrado · cliente en COMPROMISO" : "Llamada registrada", "check");
      setOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setSaving(false); }
  }

  async function remove(id: string) {
    if (!confirm("¿Eliminar este registro?")) return;
    try {
      const res = await authFetch(`/collections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Eliminado", "check"); void load();
    } catch { toast("No se pudo eliminar", "alert-triangle"); }
  }

  const isAgreement = responseDetail === "Acuerdo de Pago";

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary"><Icon name="hand-coins" size={16} /> Cobranza · Llamadas y acuerdos</h2>
        <Button variant="secondary" size="sm" onClick={openModal}><Icon name="plus" size={14} /> Registrar llamada</Button>
      </div>

      {loading ? (
        <p className="text-[12px] text-text-tertiary">Cargando…</p>
      ) : calls.length === 0 ? (
        <p className="text-[12px] text-text-tertiary">Sin llamadas registradas. Un «Acuerdo de Pago» pone al cliente en COMPROMISO y lo protege del corte masivo hasta la fecha pactada.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {calls.map((c) => (
            <div key={c.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-text-primary">{c.responseDetail ?? "Llamada"}</span>
                  {c.isAgreement && <Badge label={`Compromiso ${fmtDate(c.dueDate)}`} tone="warning" />}
                  {c.callType && <span className="text-[11px] text-text-tertiary">{c.callType}</span>}
                </div>
                <div className="text-[12px] text-text-tertiary">
                  {fmtDate(c.date)}{c.time ? ` ${c.time}` : ""}{c.responsible ? ` · ${c.responsible}` : ""}{c.responseType ? ` · ${c.responseType}` : ""}
                </div>
                {c.notes && <div className="mt-0.5 text-[12px] text-text-secondary">{c.notes}</div>}
              </div>
              <button onClick={() => remove(c.id)} className="text-text-tertiary hover:text-error-text" title="Eliminar"><Icon name="trash" size={15} /></button>
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Registrar llamada de cobranza" maxWidth="max-w-lg">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tipo de llamada"><Select value={callType} onChange={(e) => setCallType(e.target.value)}>{CALL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
          <Field label="Resultado" required><Select value={responseDetail} onChange={(e) => setResponseDetail(e.target.value)}>{RESPONSE_DETAILS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
          <Field label="Fecha" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Hora"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          {isAgreement && (
            <Field label="Fecha de compromiso" required><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          )}
          <Field label="Detalle / respuesta"><Input value={responseType} onChange={(e) => setResponseType(e.target.value)} placeholder="Opcional" /></Field>
          <div className="sm:col-span-2"><Field label="Notas"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" /></Field></div>
        </div>
        {isAgreement && <p className="mt-2 text-[12px] text-warning-text">Al guardar, el cliente pasa a <strong>COMPROMISO</strong> y queda protegido del corte masivo hasta la fecha de compromiso.</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Registrar"}</Button>
        </div>
      </Modal>
    </div>
  );
}
