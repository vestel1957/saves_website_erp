  "use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field, Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { listaJson, mensajeDeError } from "@/lib/errores";

type PlanRow = { subscriberId: string; action: "BILL" | "SKIP" | "FAIL"; reason?: string; error?: string; total?: number; planDeUltimaFactura?: boolean };
type RunResult = {
  targeted: number; generated: number; skipped: number; failed: number;
  /** Facturas que nacieron pagadas con el saldo a favor del cliente. */
  anticipos?: number; anticiposMonto?: number;
  dryRun?: boolean; invoiceDate?: string; dueDate?: string; plan?: PlanRow[];
};

/** GenerateSkipReason del backend, en lenguaje del negocio. */
const REASON_LABEL: Record<string, string> = {
  ALREADY_BILLED: "Ya tiene factura este mes",
  REACTIVATED: "Reactivado en el mes (lo cubre la reconexión)",
  NO_SERVICES: "Sin servicios activos con precio",
  PROMO: "Mes de promoción gratis",
  PROMO2: "Mes de promoción gratis (2º contador)",
  ERROR: "Error al generar",
};

/**
 * Día 1 del mes CORRIENTE: cada mes lleva su factura, con vencimiento el día 20 de ese
 * mismo mes. La fecha se puede cambiar a mano si hay que rehacer un mes atrasado —es
 * la vía de la corrida puente cuando un mes queda sin emitir.
 */
const primeroDelMesActual = () => {
  const h = new Date();
  return new Date(Date.UTC(h.getFullYear(), h.getMonth(), 1)).toISOString().slice(0, 10);
};

/**
 * Corrida de facturación del mes (POST /billing/invoices/generate).
 *
 * Obliga a simular antes de emitir: el backend expone `dryRun`, que calcula el
 * lote completo sin escribir nada, y aquí el botón de emitir solo se habilita
 * cuando ya se revisó esa previsualización. Es un lote que crea facturas reales
 * a todos los abonados activos; sin este paso no hay forma de ver a quién
 * alcanza antes de que ocurra.
 */
export function GenerarFacturasModal({
  open, onClose, onDone,
}: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch, sedeScoped } = useAuth();
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(primeroDelMesActual);
  const [dueDays, setDueDays] = useState("");
  const [preview, setPreview] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setConfirming(false);
    void authFetch("/subscribers/branches").then(listaJson).then(setBranches).catch(() => {});
  }, [open, authFetch]);

  // Cambiar los parámetros invalida la simulación: si no, se podría emitir un
  // lote distinto del que se revisó.
  useEffect(() => { setPreview(null); setConfirming(false); }, [branchId, invoiceDate, dueDays]);

  const body = useCallback((dryRun: boolean) => {
    const b: any = { dryRun };
    if (branchId) b.branchId = branchId;
    if (invoiceDate) b.invoiceDate = invoiceDate;
    if (dueDays.trim()) b.dueDays = Number(dueDays);
    return JSON.stringify(b);
  }, [branchId, invoiceDate, dueDays]);

  const run = useCallback(async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await authFetch("/billing/invoices/generate", { method: "POST", body: body(dryRun) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      if (dryRun) {
        setPreview(d);
        if ((d.generated ?? 0) === 0) toast("La simulación no generaría ninguna factura.", "alert-triangle");
      } else {
        toast(`Corrida terminada: ${d.generated} factura(s) generada(s).`, "check");
        // Las que nacieron ya pagadas con lo que el cliente había adelantado en
        // ventanilla: quien corre la facturación tiene que saber que esas no van a
        // cobranza (ver anticipos.ts).
        if (d.anticipos > 0) {
          toast(
            `${d.anticipos} nacieron pagadas con saldo a favor del cliente ` +
            `($${(d.anticiposMonto ?? 0).toLocaleString("es-CO")})`,
            "wallet",
          );
        }
        onDone();
        onClose();
      }
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo ejecutar la corrida."), "alert-triangle");
    } finally {
      setBusy(false);
    }
  }, [authFetch, body, onDone, onClose]);

  const sedeLabel = branchId ? branches.find((b) => b.id === branchId)?.name ?? "la sede" : "TODAS las sedes";

  return (
    <Modal open={open} onClose={onClose} title="Generar facturas del mes" maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-text-tertiary">
          Emite una mensualidad por abonado a partir de su plan, con fecha del mes que cubre.
          Solo alcanza a los abonados
          <strong className="text-text-secondary"> activos o en compromiso</strong>, y omite a quien ya tenga factura de ese mes.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Acotado a una sede: no elige — la corrida sale con sus abonados y ya. */}
          {!sedeScoped && (
            <Field label="Sede">
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Todas las sedes</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Mes que se factura" hint="Día 1 del mes que cubre">
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
          <Field label="Días de vencimiento" hint="Vacío = el día configurado">
            <Input type="number" min={1} value={dueDays} onChange={(e) => setDueDays(e.target.value)} placeholder="Por defecto" />
          </Field>
        </div>

        {preview && (
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary">
              <Icon name="search" size={15} className="text-brand" />
              Simulación — no se ha creado nada todavía
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="default" label={`${preview.targeted} evaluados`} />
              <Badge tone={preview.generated > 0 ? "success" : "default"} label={`${preview.generated} se facturarían`} />
              <Badge tone={preview.skipped > 0 ? "info" : "default"} label={`${preview.skipped} omitidos`} />
              {preview.failed > 0 && <Badge tone="error" label={`${preview.failed} con error`} />}
              {(() => {
                // Abonados sin servicio registrado cuyo plan se derivó de su última
                // factura (hueco de la migración): se enseña para que no pase colado.
                const n = (preview.plan ?? []).filter((p) => p.action === "BILL" && p.planDeUltimaFactura).length;
                return n > 0 ? <Badge tone="warning" label={`${n} con plan de su última factura`} /> : null;
              })()}
            </div>

            {/* Desglose de los omitidos/fallidos por motivo. */}
            {(() => {
              const byReason = new Map<string, number>();
              for (const p of preview.plan ?? []) {
                if (p.action === "BILL") continue; // los que sí se facturan no son omisiones
                const k = p.reason || p.action;
                byReason.set(k, (byReason.get(k) ?? 0) + 1);
              }
              if (byReason.size === 0) return null;
              return (
                <div className="mt-3 flex flex-col gap-1 border-t border-border-subtle pt-2">
                  {[...byReason.entries()].map(([reason, n]) => (
                    <div key={reason} className="flex justify-between gap-3 text-[12px]">
                      <span className="text-text-tertiary">{REASON_LABEL[reason] ?? reason}</span>
                      <span className="font-semibold text-text-primary">{n}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {confirming && preview && (
          <div className="flex gap-3 rounded-xl border border-error-soft bg-error-soft p-3">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-error-text" />
            <p className="text-[12px] text-text-secondary">
              Se van a crear <strong>{preview.generated} factura(s) reales</strong> para {sedeLabel}, con fecha{" "}
              <strong>{invoiceDate}</strong>. Las facturas quedan a nombre de los abonados y afectan su cartera.
              Esta acción no tiene un botón de deshacer: revertirla exige anular cada factura una por una.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            <Icon name="x" size={15} /> Cancelar
          </Button>
          <Button variant="secondary" onClick={() => void run(true)} disabled={busy}>
            {busy && !confirming ? <Icon name="loader" size={15} className="animate-spin" /> : <Icon name="search" size={15} />}
            {preview ? "Volver a simular" : "Simular corrida"}
          </Button>
          {!confirming ? (
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={busy || !preview || preview.generated === 0}>
              <Icon name="arrow-right" size={15} /> Continuar
            </Button>
          ) : (
            <Button variant="danger" onClick={() => void run(false)} disabled={busy}>
              {busy ? <Icon name="loader" size={15} className="animate-spin" /> : <Icon name="check" size={15} />}
              {busy ? "Generando…" : `Sí, generar ${preview?.generated} factura(s)`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
