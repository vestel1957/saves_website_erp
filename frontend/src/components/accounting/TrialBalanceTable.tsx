import type { TrialBalance } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

const money = (n: number) => (n === 0 ? "—" : fullCurrency(n));

export function TrialBalanceTable({ data }: { data: TrialBalance }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
      {/* Móvil: tarjetas por cuenta */}
      <div className="flex flex-col gap-2 p-3 sm:hidden">
        {data.rows.map((r) => (
          <div key={r.accountId} className="rounded-lg border border-border-subtle px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-text-tertiary">{r.code}</span>
              <span className="text-[13px] font-medium text-text-secondary">{r.name}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
              <div><span className="block text-[10px] uppercase text-text-tertiary">Mov. Débito</span><span className="font-mono text-text-secondary">{money(r.debit)}</span></div>
              <div><span className="block text-[10px] uppercase text-text-tertiary">Mov. Crédito</span><span className="font-mono text-text-secondary">{money(r.credit)}</span></div>
              <div><span className="block text-[10px] uppercase text-text-tertiary">Saldo Deudor</span><span className="font-mono font-medium text-text-primary">{money(r.saldoDeudor)}</span></div>
              <div><span className="block text-[10px] uppercase text-text-tertiary">Saldo Acreedor</span><span className="font-mono font-medium text-text-primary">{money(r.saldoAcreedor)}</span></div>
            </div>
          </div>
        ))}
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-[11px] font-bold uppercase text-text-tertiary">Totales</span>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[12px]">
            <div><span className="block text-[10px] uppercase text-text-tertiary">Mov. Débito</span><span className="font-mono font-bold text-text-primary">{fullCurrency(data.totals.debit)}</span></div>
            <div><span className="block text-[10px] uppercase text-text-tertiary">Mov. Crédito</span><span className="font-mono font-bold text-text-primary">{fullCurrency(data.totals.credit)}</span></div>
            <div><span className="block text-[10px] uppercase text-text-tertiary">Saldo Deudor</span><span className="font-mono font-bold text-text-primary">{fullCurrency(data.totals.saldoDeudor)}</span></div>
            <div><span className="block text-[10px] uppercase text-text-tertiary">Saldo Acreedor</span><span className="font-mono font-bold text-text-primary">{fullCurrency(data.totals.saldoAcreedor)}</span></div>
          </div>
        </div>
      </div>

      {/* Desktop: tabla */}
      <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[560px]">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-2 text-[10px] uppercase tracking-wider text-text-tertiary">
            <th className="px-4 py-2.5 text-left font-semibold">Código</th>
            <th className="px-4 py-2.5 text-left font-semibold">Cuenta</th>
            <th className="px-4 py-2.5 text-right font-semibold">Mov. Débito</th>
            <th className="px-4 py-2.5 text-right font-semibold">Mov. Crédito</th>
            <th className="px-4 py-2.5 text-right font-semibold">Saldo Deudor</th>
            <th className="px-4 py-2.5 text-right font-semibold">Saldo Acreedor</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.accountId} className="border-b border-border-subtle last:border-0 hover:bg-surface-2">
              <td className="px-4 py-2 font-mono text-[12px] text-text-tertiary">{r.code}</td>
              <td className="px-4 py-2 text-[13px] text-text-secondary">{r.name}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] text-text-secondary">{money(r.debit)}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] text-text-secondary">{money(r.credit)}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] font-medium text-text-primary">{money(r.saldoDeudor)}</td>
              <td className="px-4 py-2 text-right font-mono text-[13px] font-medium text-text-primary">{money(r.saldoAcreedor)}</td>
            </tr>
          ))}
          <tr className="bg-surface-2 font-bold">
            <td className="px-4 py-2.5 text-[12px] text-text-tertiary" colSpan={2}>
              TOTALES
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-[13px] text-text-primary">{fullCurrency(data.totals.debit)}</td>
            <td className="px-4 py-2.5 text-right font-mono text-[13px] text-text-primary">{fullCurrency(data.totals.credit)}</td>
            <td className="px-4 py-2.5 text-right font-mono text-[13px] text-text-primary">{fullCurrency(data.totals.saldoDeudor)}</td>
            <td className="px-4 py-2.5 text-right font-mono text-[13px] text-text-primary">{fullCurrency(data.totals.saldoAcreedor)}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <div
        className={`flex items-center gap-2 px-4 py-2.5 text-[12px] font-semibold ${
          data.balanced ? "text-success-text" : "text-error-text"
        }`}
      >
        {data.balanced ? "✓ Partida doble cuadrada (deudor = acreedor)" : "✗ Descuadre detectado"}
      </div>
    </div>
  );
}
