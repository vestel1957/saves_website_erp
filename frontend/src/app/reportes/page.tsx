import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { REPORTS, REPORT_GROUPS, reportHref } from "@/lib/reportes";

/**
 * Índice de reportes.
 *
 * Antes esta ruta ERA el sistema de reportes entero: una página con un selector
 * que cambiaba el contenido sin cambiar la URL. Ahora cada reporte vive en su
 * propia ruta y esto queda como el mapa: sirve para descubrir qué hay, que es
 * justo lo que un desplegable no permite (hay que abrirlo para saber).
 */
export default function ReportesIndex() {
  return (
    <>
      <PageHeading icon="file-spreadsheet" title="Reportes"
        subtitle="Cada reporte tiene su propia página, con filtros y exportación a PDF o Excel" />

      <div className="flex flex-col gap-7">
        {REPORT_GROUPS.map((g) => {
          const items = REPORTS.filter((r) => r.group === g.key);
          return (
            <div key={g.key} className="flex flex-col gap-3">
              <div>
                <h2 className="text-[13px] font-bold uppercase tracking-wide text-text-tertiary">{g.title}</h2>
                <p className="text-[12px] text-text-tertiary">{g.hint}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((r) => (
                  <Link key={r.key} href={reportHref(r.key)}
                    className="group flex items-start gap-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm transition-colors hover:border-brand hover:bg-surface-2">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <Icon name={r.icon} size={16} />
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[13px] font-semibold text-text-primary group-hover:text-brand">{r.label}</span>
                      <span className="text-[12px] leading-snug text-text-secondary">{r.desc}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
