import type { JournalEntry } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

const money = (n: number | string) => {
  const v = Number(n);
  return v === 0 ? "—" : fullCurrency(v);
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });

const typeStyles: Record<JournalEntry["type"], string> = {
  MANUAL: "bg-surface-2 text-text-secondary",
  AUTOMATIC: "bg-ai-soft text-ai",
  RECURRING: "bg-success-soft text-success-text",
  CLOSING: "bg-error-soft text-error-text",
};

const typeLabel: Record<JournalEntry["type"], string> = {
  MANUAL: "Manual",
  AUTOMATIC: "Automático",
  RECURRING: "Recurrente",
  CLOSING: "Cierre",
};

export function JournalTable({
  entries,
  onReverse,
}: {
  entries: JournalEntry[];
  onReverse?: (id: string, number: number) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-[13px] text-text-tertiary">
        No hay asientos registrados todavía.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {entries.map((e) => {
        const totalDebit = e.lines.reduce((s, l) => s + Number(l.debit), 0);
        return (
          <div key={e.id} className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
            <div className="flex items-center gap-3 border-b border-border-subtle bg-surface-2 px-4 py-2.5">
              <span className="font-mono text-[12px] font-bold text-text-primary">#{e.number}</span>
              <span className="text-[12px] text-text-tertiary">{fmtDate(e.date)}</span>
              <span className="flex-1 truncate text-[13px] font-semibold text-text-primary">
                {e.description}
              </span>
              {e.status === "REVERSED" && (
                <span className="rounded-md bg-error-soft px-1.5 py-0.5 text-[10px] font-semibold text-error-text">
                  Reversado
                </span>
              )}
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${typeStyles[e.type]}`}>
                {typeLabel[e.type]}
              </span>
              {onReverse && e.status === "POSTED" && e.sourceType !== "REVERSAL" && (
                <button
                  type="button"
                  onClick={() => onReverse(e.id, e.number)}
                  className="min-h-8 rounded-md border border-border-subtle px-2 py-0.5 text-[10px] font-semibold text-text-secondary hover:border-error-text hover:text-error-text"
                  title="Reversar asiento"
                >
                  Reversar
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle text-[10px] uppercase tracking-wider text-text-tertiary">
                  <th className="px-4 py-1.5 text-left font-semibold">Cuenta</th>
                  <th className="px-4 py-1.5 text-right font-semibold">Débito</th>
                  <th className="px-4 py-1.5 text-right font-semibold">Crédito</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2 text-[13px] text-text-secondary">
                      <span className="font-mono text-[11px] text-text-tertiary">{l.account.code}</span>{" "}
                      {l.account.name}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">
                      {money(l.debit)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">
                      {money(l.credit)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-surface-2 font-semibold">
                  <td className="px-4 py-2 text-right text-[12px] text-text-tertiary">Total</td>
                  <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">
                    {fullCurrency(totalDebit)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">
                    {fullCurrency(totalDebit)}
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
