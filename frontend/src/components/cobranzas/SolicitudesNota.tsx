"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";
import type { PickedSub } from "@/components/cobranzas/SubscriberPicker";

const NuevaNotaModal = dynamic(() => import("@/components/billing/NuevaNotaModal").then((m) => m.NuevaNotaModal), { ssr: false });

type Tipo = "CREDITO" | "DEBITO";
type Estado = "PENDIENTE" | "APLICADA" | "RECHAZADA";
type Solicitud = {
  id: string; type: Tipo; amount: number | null; reason: string; status: Estado;
  requestedByName: string; assignedTo: { id: string; name: string };
  response: string | null; resolvedByName: string | null; resolvedAt: string | null; createdAt: string;
};
type Emisor = { id: string; name: string };

const cuando = (s: string) => new Date(s).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
const tipoTexto = (t: Tipo) => (t === "CREDITO" ? "Nota crédito" : "Nota débito");

/**
 * Pedir una nota crédito/débito para el cliente desde su pestaña Cobranza.
 *
 * Emitirla es nominal (sólo las personas con `billing.notes.emit`), así que quien
 * atiende la llamada la PIDE y se la asigna a una de ellas; a esa persona le llega el
 * aviso a la campanita, y desde aquí mismo la aplica (se abre la nota ya rellena) o
 * dice por qué no procede. Quien la pidió se entera al cerrarse.
 */
export function SolicitudesNota({ subscriberId }: { subscriberId: string }) {
  const { authFetch, user, puedeEmitirNotas } = useAuth();
  const [cliente, setCliente] = useState<PickedSub | null>(null);
  const [items, setItems] = useState<Solicitud[]>([]);
  const [loading, setLoading] = useState(true);
  const [emisores, setEmisores] = useState<Emisor[]>([]);

  // Pedir
  const [abierto, setAbierto] = useState(false);
  const [type, setType] = useState<Tipo>("CREDITO");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Atender
  const [aplicar, setAplicar] = useState<Solicitud | null>(null);
  const [rechazar, setRechazar] = useState<Solicitud | null>(null);
  const [respuesta, setRespuesta] = useState("");
  const [cerrando, setCerrando] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/collections/subscriber/${subscriberId}/note-requests`);
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message);
      setCliente(d.cliente); setItems(d.items ?? []);
    } catch { toast("No se pudieron cargar las solicitudes de nota", "alert-triangle"); }
    finally { setLoading(false); }
  }, [authFetch, subscriberId]);

  useEffect(() => { void load(); }, [load]);

  function abrirSolicitud() {
    setType("CREDITO"); setAmount(""); setReason(""); setAssignedToId(""); setErr(null);
    setAbierto(true);
    if (!emisores.length) {
      void authFetch("/collections/note-requests/assignees").then((r) => r.json()).then((d) => setEmisores(Array.isArray(d) ? d : [])).catch(() => {});
    }
  }

  async function enviar() {
    setErr(null);
    if (!assignedToId) { setErr("Elige a quién se le asigna."); return; }
    if (reason.trim().length < 5) { setErr("Escribe el motivo: por qué se pide la nota."); return; }
    const monto = Number(amount) || 0;
    if (amount && monto <= 0) { setErr("El monto sugerido no es válido."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/collections/note-requests", {
        method: "POST",
        body: JSON.stringify({ subscriberId, type, amount: monto > 0 ? monto : undefined, reason: reason.trim(), assignedToId }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo enviar la solicitud");
      toast(`Solicitud enviada a ${d.assignedTo?.name ?? "la persona asignada"}`, "check");
      setAbierto(false); void load();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  async function cerrar(s: Solicitud, status: "APLICADA" | "RECHAZADA", response?: string) {
    setCerrando(true);
    try {
      const res = await authFetch(`/collections/note-requests/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, response: response?.trim() || undefined }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo cerrar la solicitud");
      toast(status === "APLICADA" ? "Solicitud marcada como aplicada" : "Solicitud rechazada", "check");
      setRechazar(null); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setCerrando(false); }
  }

  const pendientes = items.filter((s) => s.status === "PENDIENTE").length;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
          <Icon name="file-text" size={16} /> Solicitudes de nota crédito / débito
          {pendientes > 0 && <Badge label={`${pendientes} pendiente${pendientes === 1 ? "" : "s"}`} tone="warning" />}
        </h2>
        <Button variant="secondary" size="sm" onClick={abrirSolicitud}><Icon name="file-text" size={14} /> Solicitar nota</Button>
      </div>

      {loading ? (
        <p className="text-[12px] text-text-tertiary">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-text-tertiary">Sin solicitudes. Pide aquí la nota crédito o débito y asígnasela a quien la emite: le llega un aviso.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {items.map((s) => {
            const puedeAtender = s.status === "PENDIENTE" && (s.assignedTo.id === user?.id || puedeEmitirNotas);
            return (
              <li key={s.id} className="flex flex-col gap-1.5 py-2.5 text-[12px] first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge label={tipoTexto(s.type)} tone={s.type === "CREDITO" ? "success" : "warning"} />
                  {s.amount != null && <span className="font-semibold text-text-primary">{cop(s.amount)}</span>}
                  <Badge
                    label={s.status === "PENDIENTE" ? "Pendiente" : s.status === "APLICADA" ? "Aplicada" : "Rechazada"}
                    tone={s.status === "PENDIENTE" ? "warning" : s.status === "APLICADA" ? "success" : "default"}
                  />
                  <span className="ml-auto text-text-tertiary">{cuando(s.createdAt)}</span>
                </div>
                <p className="text-text-primary">{s.reason}</p>
                <p className="text-text-tertiary">
                  Pedida por <span className="text-text-secondary">{s.requestedByName}</span> · asignada a{" "}
                  <span className="font-semibold text-text-secondary">{s.assignedTo.name}</span>
                </p>
                {s.status !== "PENDIENTE" && (
                  <p className="text-text-tertiary">
                    {s.status === "APLICADA" ? "Aplicada" : "Rechazada"} por {s.resolvedByName ?? "—"}
                    {s.resolvedAt ? ` · ${cuando(s.resolvedAt)}` : ""}
                    {s.response ? <>: <span className="text-text-secondary">{s.response}</span></> : null}
                  </p>
                )}
                {puedeAtender && (
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {puedeEmitirNotas && cliente && (
                      <Button size="sm" onClick={() => setAplicar(s)}>Aplicar nota</Button>
                    )}
                    <Button variant="secondary" size="sm" disabled={cerrando} onClick={() => void cerrar(s, "APLICADA", "Aplicada por fuera de la solicitud.")}>
                      Ya se aplicó
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setRespuesta(""); setRechazar(s); }}>No procede</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={abierto} onClose={() => setAbierto(false)} title="Solicitar nota crédito / débito" maxWidth="max-w-lg">
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Tipo" required>
              <Select value={type} onChange={(e) => setType(e.target.value as Tipo)}>
                <option value="CREDITO">Nota crédito (rebaja)</option>
                <option value="DEBITO">Nota débito (recargo)</option>
              </Select>
            </Field>
            <Field label="Monto sugerido" hint="Opcional: lo decide quien la emite">
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </Field>
          </div>
          <Field label="Asignar a" required hint="Personas autorizadas para emitir notas; le llega un aviso">
            <Select value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
              <option value="">seleccione</option>
              {emisores.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </Field>
          <Field label="Motivo" required>
            <Textarea
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej.: se le cobró la reconexión dos veces en la factura de agosto."
            />
          </Field>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAbierto(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={enviar} disabled={saving}>{saving ? "Enviando…" : "Enviar solicitud"}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!rechazar} onClose={() => setRechazar(null)} title="La nota no procede" maxWidth="max-w-md">
        <div className="flex flex-col gap-2.5">
          <Field label="¿Por qué?" required hint="Le llega a quien la pidió">
            <Textarea rows={3} maxLength={500} value={respuesta} onChange={(e) => setRespuesta(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRechazar(null)} disabled={cerrando}>Volver</Button>
            <Button
              onClick={() => rechazar && void cerrar(rechazar, "RECHAZADA", respuesta)}
              disabled={cerrando || respuesta.trim().length < 5}
            >
              {cerrando ? "Guardando…" : "Rechazar solicitud"}
            </Button>
          </div>
        </div>
      </Modal>

      {aplicar && cliente && puedeEmitirNotas && (
        <NuevaNotaModal
          open
          onClose={() => setAplicar(null)}
          inicial={{ sub: cliente, type: aplicar.type, amount: aplicar.amount, description: aplicar.reason }}
          onDone={() => {
            const s = aplicar;
            setAplicar(null);
            void cerrar(s, "APLICADA", "Nota aplicada desde la solicitud.");
          }}
        />
      )}
    </div>
  );
}
