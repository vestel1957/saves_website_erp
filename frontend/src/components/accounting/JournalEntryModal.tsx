"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import type { Account } from "@/lib/accounting-types";

type CostCenter = { id: string; code?: string | null; name: string; isActive?: boolean };

type LineForm = {
  accountId: string;
  costCenterId: string;
  debit: string;
  credit: string;
  description: string;
};

const emptyLine = (): LineForm => ({ accountId: "", costCenterId: "", debit: "", credit: "", description: "" });

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Fecha de hoy en formato YYYY-MM-DD para el <input type="date">. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Modal para registrar un asiento contable manual (partida doble).
 * Editor de líneas dinámico con totales en vivo y validación de cuadre
 * antes de habilitar el guardado. Reusa el endpoint POST /accounting/journal-entries.
 */
export function JournalEntryModal({
  open,
  onClose,
  onSaved,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accounts: Account[];
}) {
  const { authFetch } = useAuth();

  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<LineForm[]>([emptyLine(), emptyLine()]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // Reinicia el formulario cada vez que se abre.
  useEffect(() => {
    if (!open) return;
    setDate(todayISO());
    setDescription("");
    setReference("");
    setLines([emptyLine(), emptyLine()]);
    setMsg("");
  }, [open]);

  useEffect(() => {
    if (!open || costCenters.length) return;
    authFetch("/accounting/cost-centers")
      .then((r) => (r.ok ? r.json() : []))
      .then((cc: CostCenter[]) => setCostCenters(cc.filter((c) => c.isActive !== false)))
      .catch(() => setCostCenters([]));
  }, [open, costCenters.length, authFetch]);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      debit += Number(l.debit) || 0;
      credit += Number(l.credit) || 0;
    }
    debit = round2(debit);
    credit = round2(credit);
    return { debit, credit, diff: round2(debit - credit) };
  }, [lines]);

  const balanced = totals.diff === 0 && totals.debit > 0;

  function setLine(i: number, patch: Partial<LineForm>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((ls) => [...ls, emptyLine()]);
  }

  function removeLine(i: number) {
    setLines((ls) => (ls.length <= 2 ? ls : ls.filter((_, idx) => idx !== i)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");

    if (!description.trim()) {
      setMsg("✗ La descripción es obligatoria.");
      return;
    }
    const payloadLines = lines
      .map((l) => ({
        accountId: l.accountId,
        costCenterId: l.costCenterId || undefined,
        debit: round2(Number(l.debit) || 0),
        credit: round2(Number(l.credit) || 0),
        description: l.description.trim() || undefined,
      }))
      .filter((l) => l.accountId && (l.debit > 0 || l.credit > 0));

    if (payloadLines.length < 2) {
      setMsg("✗ Un asiento requiere al menos 2 líneas con cuenta e importe.");
      return;
    }
    if (payloadLines.some((l) => l.debit > 0 && l.credit > 0)) {
      setMsg("✗ Cada línea debe tener débito O crédito, no ambos.");
      return;
    }
    if (!balanced) {
      setMsg("✗ El asiento no está cuadrado (débitos ≠ créditos).");
      return;
    }

    setSaving(true);
    const res = await authFetch("/accounting/journal-entries", {
      method: "POST",
      body: JSON.stringify({
        date,
        description: description.trim(),
        reference: reference.trim() || undefined,
        lines: payloadLines,
      }),
    });
    setSaving(false);

    if (res.ok) {
      onSaved();
      onClose();
    } else {
      const err = await res.json().catch(() => ({}));
      const m = Array.isArray(err.message) ? err.message.join(", ") : err.message;
      setMsg(`✗ ${m ?? "Error al guardar el asiento"}`);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nuevo asiento manual" maxWidth="max-w-3xl">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Fecha" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Descripción" required>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ej. Causación gasto bancario"
            />
          </Field>
          <Field label="Referencia" hint="Documento o soporte (opcional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="N° soporte" />
          </Field>
        </div>

        {/* Editor de líneas */}
        <div className="overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-border-subtle bg-surface-2 text-[10px] uppercase tracking-wider text-text-tertiary">
                <th className="px-2 py-1.5 text-left font-semibold">Cuenta</th>
                <th className="px-2 py-1.5 text-left font-semibold">Centro de costo</th>
                <th className="px-2 py-1.5 text-right font-semibold">Débito</th>
                <th className="px-2 py-1.5 text-right font-semibold">Crédito</th>
                <th className="w-8 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-border-subtle last:border-0 align-top">
                  <td className="px-2 py-1.5">
                    <Select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })}>
                      <option value="">Cuenta…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </Select>
                    <input
                      className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-text-secondary outline-none"
                      value={l.description}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                      placeholder="Detalle de la línea (opcional)"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Select value={l.costCenterId} onChange={(e) => setLine(i, { costCenterId: e.target.value })}>
                      <option value="">—</option>
                      {costCenters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code ? `${c.code} · ` : ""}
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      className="text-right"
                      value={l.debit}
                      onChange={(e) => setLine(i, { debit: e.target.value, credit: "" })}
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      className="text-right"
                      value={l.credit}
                      onChange={(e) => setLine(i, { credit: e.target.value, debit: "" })}
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      disabled={lines.length <= 2}
                      className="rounded-md p-1 text-text-tertiary hover:bg-error-soft hover:text-error-text disabled:opacity-30"
                      title="Eliminar línea"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="bg-surface-2 font-semibold">
                <td className="px-2 py-2 text-[12px] text-text-tertiary" colSpan={2}>
                  <button type="button" onClick={addLine} className="inline-flex items-center gap-1 text-brand hover:underline">
                    <Icon name="plus" size={13} /> Agregar línea
                  </button>
                </td>
                <td className="px-2 py-2 text-right font-mono text-[13px] text-text-primary">{fullCurrency(totals.debit)}</td>
                <td className="px-2 py-2 text-right font-mono text-[13px] text-text-primary">{fullCurrency(totals.credit)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={`text-[12px] font-semibold ${
              balanced ? "text-success-text" : "text-error-text"
            }`}
          >
            {balanced ? "✓ Asiento cuadrado" : `Diferencia: ${fullCurrency(totals.diff)}`}
          </span>
          <div className="flex items-center gap-3">
            {msg && <span className="text-[12px] text-error-text">{msg}</span>}
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || !balanced}>
              {saving ? "Guardando…" : "Registrar asiento"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
