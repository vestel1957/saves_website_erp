"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { cop, fmtDate, PAYSLIP_STATUS_LABEL, Payslip, PayslipLine, toNumber } from "@/lib/payroll";

/**
 * Vista detallada de un desprendible. Cada línea muestra origen, fórmula,
 * cantidad, valor unitario y total → el empleado entiende cada peso recibido.
 * Presentacional: recibe los datos y callbacks; no hace fetch.
 */
export function PayslipView({
  slip,
  onDownload,
  onIssue,
  downloading,
}: {
  slip: Payslip;
  onDownload: () => void;
  onIssue?: () => void;
  downloading?: boolean;
}) {
  const lines = slip.lines ?? [];
  const earnings = lines.filter((l) => l.type === "EARNING");
  const deductions = lines.filter((l) => l.type === "DEDUCTION");

  return (
    <div className="flex flex-col gap-5">
      {/* encabezado */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border-subtle bg-surface p-5">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-[20px] font-bold text-text-primary">
              {slip.employee ? `${slip.employee.firstName} ${slip.employee.lastName}` : "Desprendible"}
            </h1>
            <Badge label={PAYSLIP_STATUS_LABEL[slip.status]} tone={slip.status === "DRAFT" ? "warning" : "success"} />
          </div>
          <p className="text-[13px] text-text-tertiary">
            {slip.employee?.docNumber && <>Doc. {slip.employee.docNumber} · </>}
            {slip.employee?.position ?? ""} {slip.employee?.area ? `· ${slip.employee.area}` : ""}
          </p>
          {slip.period && (
            <p className="mt-1 text-[13px] text-text-secondary">
              {slip.period.name} · {fmtDate(slip.period.startDate)} – {fmtDate(slip.period.endDate)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onDownload} disabled={downloading}>
            <Icon name="download" size={15} /> {downloading ? "Generando…" : "Descargar PDF"}
          </Button>
          {onIssue && slip.status === "DRAFT" && (
            <Button onClick={onIssue}><Icon name="send" size={15} /> Emitir</Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Devengados" tone="success" lines={earnings} />
        <Section title="Deducciones" tone="error" lines={deductions} />
      </div>

      {/* totales */}
      <div className="rounded-xl border border-border-subtle bg-surface p-5">
        <Row label="Total devengado" value={cop(slip.totalEarnings)} />
        <Row label="Total deducciones" value={`−${cop(slip.totalDeductions)}`} muted />
        <div className="my-2 border-t border-border-subtle" />
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-bold text-text-primary">Neto a pagar</span>
          <span className="text-[20px] font-bold text-brand">{cop(slip.netSalary)}</span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, tone, lines }: { title: string; tone: "success" | "error"; lines: PayslipLine[] }) {
  const total = lines.reduce((s, l) => s + toNumber(l.amount), 0);
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className={`text-[13px] font-bold uppercase tracking-wide ${tone === "success" ? "text-success-text" : "text-error-text"}`}>{title}</h2>
        <span className="text-[13px] font-semibold text-text-secondary">{cop(total)}</span>
      </div>
      {lines.length === 0 ? (
        <p className="text-[13px] text-text-tertiary">Ninguno.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {lines.map((l) => (
            <li key={l.id} className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-medium text-text-primary">{l.label}</p>
                <p className="text-[11px] text-text-tertiary">
                  {[l.origin, l.formula].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
              <span className="shrink-0 text-[13px] font-semibold text-text-primary">{cop(l.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[13px] text-text-secondary">{label}</span>
      <span className={`text-[13px] font-semibold ${muted ? "text-error-text" : "text-text-primary"}`}>{value}</span>
    </div>
  );
}
