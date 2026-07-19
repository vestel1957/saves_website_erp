"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { exportReportPDF, exportReportExcel, type ReportDoc } from "@/lib/report-export";

/* Menú de exportación (PDF / Excel). */
export function ExportMenu({ doc }: { doc: ReportDoc | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const disabled = !doc || doc.tables.every((t) => t.rows.length === 0);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 py-2 text-[12px] font-semibold text-text-secondary shadow-sm transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon name="download" size={14} /> Exportar <Icon name="chevron-down" size={13} />
      </button>
      {open && doc && (
        <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border-subtle bg-surface py-1 shadow-lg">
          <button onClick={() => { exportReportPDF(doc); setOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2">
            <Icon name="file-text" size={14} /> PDF (imprimir)
          </button>
          <button onClick={() => { exportReportExcel(doc); setOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2">
            <Icon name="file-spreadsheet" size={14} /> Excel (.xls)
          </button>
        </div>
      )}
    </div>
  );
}
