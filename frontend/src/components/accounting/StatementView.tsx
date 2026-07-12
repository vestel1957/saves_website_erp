import type { StatementLine } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

export function StatementSection({
  title,
  lines,
  total,
}: {
  title: string;
  lines: StatementLine[];
  total: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
      <div className="border-b border-border-subtle bg-surface-2 px-4 py-2.5 text-[12px] font-bold uppercase tracking-wider text-text-secondary">
        {title}
      </div>
      <table className="w-full">
        <tbody>
          {lines.length === 0 && (
            <tr>
              <td className="px-4 py-3 text-[13px] text-text-tertiary">Sin movimientos</td>
            </tr>
          )}
          {lines.map((l) => (
            <tr key={l.code} className="border-b border-border-subtle last:border-0">
              <td className="px-4 py-2 font-mono text-[11px] text-text-tertiary">{l.code}</td>
              <td className="px-4 py-2 text-[13px] text-text-secondary">{l.name}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">
                {fullCurrency(l.amount)}
              </td>
            </tr>
          ))}
          <tr className="bg-surface-2 font-bold">
            <td className="px-4 py-2.5 text-[12px] text-text-tertiary" colSpan={2}>
              Total {title.toLowerCase()}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-[13px] text-text-primary">
              {fullCurrency(total)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function TotalRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "error";
}) {
  const cls =
    tone === "success" ? "text-success-text" : tone === "error" ? "text-error-text" : "text-text-primary";
  return (
    <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-surface px-4 py-3">
      <span className="text-[13px] font-bold text-text-primary">{label}</span>
      <span className={`font-mono text-[16px] font-bold ${cls}`}>{fullCurrency(value)}</span>
    </div>
  );
}
