import type { Ledger } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

const money = (n: number) => (n === 0 ? "—" : fullCurrency(n));
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });

export function LedgerTable({ data }: { data: Ledger }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-4 py-3">
        <div>
          <span className="font-mono text-[12px] text-text-tertiary">{data.account.code}</span>{" "}
          <span className="text-[14px] font-bold text-text-primary">{data.account.name}</span>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Saldo final</div>
          <div className="font-mono text-[16px] font-bold text-text-primary">
            {fullCurrency(data.closingBalance)}
          </div>
        </div>
      </div>
      {/* Móvil: tarjetas por movimiento */}
      <div className="flex flex-col gap-2 p-3 sm:hidden">
        <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-[12px]">
          <span className="italic text-text-tertiary">Saldo inicial</span>
          <span className="font-mono font-semibold text-text-secondary">{fullCurrency(data.openingBalance)}</span>
        </div>
        {data.lines.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-text-tertiary">Sin movimientos en esta cuenta.</div>
        ) : (
          data.lines.map((l) => (
            <div key={l.lineId} className="rounded-lg border border-border-subtle px-3 py-2">
              <div className="flex items-center justify-between text-[11px] text-text-tertiary">
                <span className="font-mono">#{l.number}</span>
                <span>{fmtDate(l.date)}</span>
              </div>
              <p className="mt-0.5 text-[13px] text-text-secondary">{l.description}</p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                <div><span className="block text-[10px] uppercase text-text-tertiary">Débito</span><span className="font-mono text-text-primary">{money(l.debit)}</span></div>
                <div><span className="block text-[10px] uppercase text-text-tertiary">Crédito</span><span className="font-mono text-text-primary">{money(l.credit)}</span></div>
                <div className="text-right"><span className="block text-[10px] uppercase text-text-tertiary">Saldo</span><span className="font-mono font-semibold text-text-primary">{fullCurrency(l.balance)}</span></div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop: tabla */}
      <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="border-b border-border-subtle text-[10px] uppercase tracking-wider text-text-tertiary">
            <th className="px-4 py-2 text-left font-semibold">Fecha</th>
            <th className="px-4 py-2 text-left font-semibold">N°</th>
            <th className="px-4 py-2 text-left font-semibold">Detalle</th>
            <th className="px-4 py-2 text-right font-semibold">Débito</th>
            <th className="px-4 py-2 text-right font-semibold">Crédito</th>
            <th className="px-4 py-2 text-right font-semibold">Saldo</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border-subtle bg-surface-2">
            <td className="px-4 py-2 text-[12px] italic text-text-tertiary" colSpan={5}>
              Saldo inicial
            </td>
            <td className="px-4 py-2 text-right font-mono text-[13px] font-medium text-text-secondary">
              {fullCurrency(data.openingBalance)}
            </td>
          </tr>
          {data.lines.map((l) => (
            <tr key={l.lineId} className="border-b border-border-subtle last:border-0 hover:bg-surface-2">
              <td className="px-4 py-2 text-[12px] text-text-tertiary">{fmtDate(l.date)}</td>
              <td className="px-4 py-2 font-mono text-[12px] text-text-tertiary">#{l.number}</td>
              <td className="px-4 py-2 text-[13px] text-text-secondary">{l.description}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">{money(l.debit)}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] text-text-primary">{money(l.credit)}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] font-medium text-text-primary">
                {fullCurrency(l.balance)}
              </td>
            </tr>
          ))}
          {data.lines.length === 0 && (
            <tr>
              <td className="px-4 py-3 text-center text-[13px] text-text-tertiary" colSpan={6}>
                Sin movimientos en esta cuenta.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
