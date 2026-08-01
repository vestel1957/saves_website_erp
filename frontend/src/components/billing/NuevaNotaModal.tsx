"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Fact = {
  id: string; tid: number; date: string | null; dueDate: string | null;
  total: number; paid: number; balance: number; status: string;
};
type Deuda = {
  name: string; abonado: number | null; docNumber: string | null;
  balance: number; totalDebt: number; scope: "due" | "all"; items: Fact[];
};

const fecha = (s: string | null) => (s ? new Date(s).toLocaleDateString("es-CO") : "—");

/**
 * Aplica una nota crédito (rebaja) o débito (recargo) sobre una factura.
 * Se abre desde el botón "Nueva nota" del listado de notas.
 *
 * La factura NO se escribe por número: se busca el cliente (nombre, cédula o
 * abonado) y se elige de la lista de lo que debe. Escribir el `tid` a mano era
 * el flujo del legacy y obligaba a irse a otra pantalla a averiguarlo — y un
 * dígito mal puesto aplicaba la nota a la factura de otro cliente.
 */
export function NuevaNotaModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras aplicar con éxito para refrescar el listado. */
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [deuda, setDeuda] = useState<Deuda | null>(null);
  const [cargando, setCargando] = useState(false);
  const [todas, setTodas] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [type, setType] = useState<"CREDITO" | "DEBITO">("CREDITO");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [retentionType, setRetentionType] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset al cerrar para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (open) return;
    setSub(null); setDeuda(null); setTodas(false); setInvoiceId("");
    setType("CREDITO"); setAmount(""); setDescription(""); setRetentionType("");
    setErr(null); setSaving(false);
  }, [open]);

  // Facturas del cliente elegido. `todas` alterna entre lo que debe y el histórico.
  useEffect(() => {
    if (!sub) { setDeuda(null); setInvoiceId(""); return; }
    let vivo = true;
    setCargando(true); setErr(null);
    authFetch(`/billing/subscribers/${sub.id}/invoices${todas ? "?scope=all" : ""}`)
      .then((r) => r.json())
      .then((d: Deuda) => {
        if (!vivo) return;
        setDeuda(d);
        // Si la factura marcada ya no está en la lista nueva, se suelta.
        setInvoiceId((prev) => (d.items?.some((i) => i.id === prev) ? prev : ""));
      })
      .catch((e) => { if (vivo) setErr(mensajeDeError(e)); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [sub, todas, authFetch]);

  const elegida = useMemo(() => deuda?.items.find((i) => i.id === invoiceId) ?? null, [deuda, invoiceId]);
  // La nota crédito rebaja el total: pasarse del saldo lo dejaría en cero y
  // sobraría plata sin aplicar. Se avisa, no se bloquea (el legacy lo permitía).
  const exceso = type === "CREDITO" && elegida ? Number(amount) > elegida.balance : false;

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Busca y elige el cliente."); return; }
    if (!invoiceId) { setErr("Elige la factura sobre la que se aplica la nota."); return; }
    if ((Number(amount) || 0) <= 0) { setErr("Ingresa un monto válido."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/billing/invoices/${invoiceId}/notes`, {
        method: "POST",
        body: JSON.stringify({
          type, amount: Number(amount), description: description || undefined,
          retentionType: retentionType || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la nota");
      toast(`Nota ${type === "CREDITO" ? "crédito" : "débito"} aplicada · nuevo total ${cop(d.newTotal)}`);
      onClose();
      onDone?.();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Aplicar nota crédito / débito" maxWidth="max-w-2xl">
      <div className="flex flex-col gap-2.5">
        <Field label="Cliente" required>
          <SubscriberPicker
            value={sub}
            onChange={(s) => { setSub(s); setTodas(false); setInvoiceId(""); }}
            placeholder="Buscar por nombre, cédula o número de abonado…"
          />
        </Field>

        {sub && (
          <div className="rounded-lg border border-border-subtle bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
                <Icon name="file-text" size={13} />
                {todas ? "Facturas del cliente" : "Facturas que debe"}
              </span>
              <div className="flex items-center gap-3">
                {deuda && !todas && (
                  <span className="text-[11px] text-text-tertiary">
                    Debe <span className="font-semibold text-error-text">{cop(deuda.totalDebt)}</span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setTodas((v) => !v)}
                  className="text-[11px] font-medium text-brand hover:underline"
                >
                  {todas ? "Sólo las que debe" : "Ver todas"}
                </button>
              </div>
            </div>

            {cargando ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando facturas…</div>
            ) : !deuda?.items.length ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
                {todas ? "El cliente no tiene facturas." : "El cliente no tiene facturas pendientes."}
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                {deuda.items.map((f) => {
                  const marcada = f.id === invoiceId;
                  return (
                    <label
                      key={f.id}
                      className={`flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2 text-[12px] last:border-0 ${marcada ? "bg-surface-2" : "hover:bg-surface-2"}`}
                    >
                      <input
                        type="radio"
                        name="nota-factura"
                        className="h-4 w-4 shrink-0 cursor-pointer accent-brand"
                        checked={marcada}
                        onChange={() => { setInvoiceId(f.id); setErr(null); }}
                      />
                      <span className="font-mono font-medium text-text-primary">#{f.tid}</span>
                      <span className="text-text-tertiary">{fecha(f.date)}</span>
                      <span className="text-text-secondary">total {cop(f.total)}</span>
                      <span className="ml-auto flex items-center gap-2">
                        {f.balance > 0 && <span className="font-semibold text-error-text">saldo {cop(f.balance)}</span>}
                        <Badge
                          label={f.status === "PAID" ? "Pagada" : f.status === "PARTIAL" ? "Abonada" : f.status === "CANCELED" ? "Anulada" : "Pendiente"}
                          tone={f.status === "PAID" ? "success" : f.status === "PARTIAL" ? "warning" : f.status === "CANCELED" ? "default" : "error"}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <Field label="Tipo" required>
          <Select value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="CREDITO">Nota crédito (rebaja)</option>
            <option value="DEBITO">Nota débito (recargo)</option>
          </Select>
        </Field>
        {/* Retención: paridad legacy — se captura aquí (no al facturar) y el valor lo
            digita el usuario en "Monto"; el sistema no lo calcula. */}
        <Field label="¿Tiene retención? ¿Qué tipo?">
          <Select value={retentionType} onChange={(e) => setRetentionType(e.target.value)}>
            <option value="">- Seleccionar -</option>
            <option value="Retefuente Servicios">Retefuente Servicios</option>
            <option value="Compras">Compras</option>
            <option value="Personas no declarantes">Personas no declarantes</option>
            <option value="Reteiva">Reteiva</option>
          </Select>
        </Field>
        <Field label="Monto" required>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            {type === "CREDITO" && elegida && elegida.balance > 0 && (
              <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => setAmount(String(elegida.balance))}>
                Todo el saldo
              </Button>
            )}
          </div>
        </Field>
        {exceso && (
          <p className="text-[11px] text-warning-text">
            El monto supera el saldo de la factura #{elegida?.tid} ({cop(elegida?.balance ?? 0)}): el total quedará en cero.
          </p>
        )}
        <Field label="Descripción">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Motivo" />
        </Field>
        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !invoiceId}>{saving ? "Aplicando…" : "Aplicar nota"}</Button>
        </div>
      </div>
    </Modal>
  );
}
