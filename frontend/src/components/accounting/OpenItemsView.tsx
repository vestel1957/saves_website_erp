import type { AgingBuckets, OpenItems } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });

const statusStyles: Record<string, string> = {
  ISSUED: "bg-surface-2 text-text-secondary",
  PARTIAL: "bg-ai-soft text-ai",
  PAID: "bg-success-soft text-success-text",
  VOID: "bg-error-soft text-error-text",
};

export function OpenItemsView({
  data,
  aging,
}: {
  data: OpenItems;
  aging: AgingBuckets;
}) {
  const buckets = [
    { label: "Corriente", value: aging.current },
    { label: "1–30 días", value: aging.d1_30 },
    { label: "31–60 días", value: aging.d31_60 },
    { label: "61–90 días", value: aging.d61_90 },
    { label: "+90 días", value: aging.d90_plus },
  ];

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {buckets.map((b) => (
          <div
            key={b.label}
            className="flex flex-1 flex-col gap-1 rounded-xl border border-border-subtle bg-surface p-3"
          >
            <span className="text-[11px] font-semibold text-text-tertiary">{b.label}</span>
            <span className="font-mono text-[16px] font-bold text-text-primary">
              {fullCurrency(b.value)}
            </span>
          </div>
        ))}
      </div>

      {/* Móvil: tarjetas */}
      <div className="flex flex-col gap-2 sm:hidden">
        {data.items.length === 0 ? (
          <div className="rounded-xl border border-border-subtle bg-surface px-3 py-6 text-center text-[13px] text-text-tertiary">
            No hay documentos pendientes.
          </div>
        ) : (
          data.items.map((it) => (
            <div
              key={it.invoiceId ?? it.billId}
              className="rounded-xl border border-border-subtle bg-surface p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-text-primary">{it.party}</p>
                  <p className="font-mono text-[12px] text-text-tertiary">{it.number}</p>
                </div>
                <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${statusStyles[it.status] ?? "bg-surface-2 text-text-secondary"}`}>
                  {it.status}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border-subtle pt-2">
                <div>
                  <span className="block text-[10px] uppercase tracking-wider text-text-tertiary">Vence</span>
                  <span className="text-[12px] text-text-secondary">{fmtDate(it.dueDate)}</span>
                </div>
                <div className="text-right">
                  <span className="block text-[10px] uppercase tracking-wider text-text-tertiary">Total</span>
                  <span className="font-mono text-[12px] text-text-secondary">{fullCurrency(it.total)}</span>
                </div>
                <div className="text-right">
                  <span className="block text-[10px] uppercase tracking-wider text-text-tertiary">Saldo</span>
                  <span className="font-mono text-[12px] font-medium text-text-primary">{fullCurrency(it.balance)}</span>
                </div>
              </div>
            </div>
          ))
        )}
        <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
          <span className="text-[12px] font-bold text-text-tertiary">Total pendiente</span>
          <span className="font-mono text-[13px] font-bold text-text-primary">{fullCurrency(data.total)}</span>
        </div>
      </div>

      {/* Desktop: tabla */}
      <div className="hidden overflow-x-auto rounded-xl border border-border-subtle bg-surface sm:block">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-2 text-[10px] uppercase tracking-wider text-text-tertiary">
              <th className="px-4 py-2.5 text-left font-semibold">Documento</th>
              <th className="px-4 py-2.5 text-left font-semibold">Tercero</th>
              <th className="px-4 py-2.5 text-left font-semibold">Vencimiento</th>
              <th className="px-4 py-2.5 text-right font-semibold">Total</th>
              <th className="px-4 py-2.5 text-right font-semibold">Saldo</th>
              <th className="px-4 py-2.5 text-right font-semibold">Estado</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-center text-[13px] text-text-tertiary" colSpan={6}>
                  No hay documentos pendientes.
                </td>
              </tr>
            )}
            {data.items.map((it) => (
              <tr
                key={it.invoiceId ?? it.billId}
                className="border-b border-border-subtle last:border-0 hover:bg-surface-2"
              >
                <td className="px-4 py-2 font-mono text-[12px] text-text-secondary">{it.number}</td>
                <td className="px-4 py-2 text-[13px] text-text-secondary">{it.party}</td>
                <td className="px-4 py-2 text-[12px] text-text-tertiary">{fmtDate(it.dueDate)}</td>
                <td className="px-4 py-2 text-right font-mono text-[13px] text-text-secondary">
                  {fullCurrency(it.total)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-[13px] font-medium text-text-primary">
                  {fullCurrency(it.balance)}
                </td>
                <td className="px-4 py-2 text-right">
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${statusStyles[it.status] ?? "bg-surface-2 text-text-secondary"}`}>
                    {it.status}
                  </span>
                </td>
              </tr>
            ))}
            <tr className="bg-surface-2 font-bold">
              <td className="px-4 py-2.5 text-[12px] text-text-tertiary" colSpan={4}>
                Total pendiente
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[13px] text-text-primary" colSpan={2}>
                {fullCurrency(data.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
