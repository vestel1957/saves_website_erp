"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Icon } from "@/components/Icon";

/** Páginas a mostrar con elipsis: 1 … (p-1) p (p+1) … N */
function pageList(page: number, pageCount: number): (number | "…")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  if (start > 2) out.push("…");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < pageCount - 1) out.push("…");
  out.push(pageCount);
  return out;
}

/**
 * Tabla con paginación en el cliente y selector de tamaño (10 / 20 / 50 / Todo).
 * Envuelve el DataTable existente; corta las filas en memoria.
 */
export function PagedTable<T>({
  columns, rows, empty, onRowClick, defaultPageSize = 10,
}: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  onRowClick?: (row: T) => void;
  defaultPageSize?: number;
}) {
  const [pageSize, setPageSize] = useState<number | "all">(defaultPageSize);
  const [page, setPage] = useState(1);

  const total = rows.length;
  const size = pageSize === "all" ? Math.max(total, 1) : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / size));

  // Al cambiar los datos o el tamaño, no dejar la página fuera de rango.
  useEffect(() => { setPage((p) => Math.min(Math.max(1, p), pageCount)); }, [pageCount]);

  const startIdx = (page - 1) * size;
  const pageRows = useMemo(() => rows.slice(startIdx, startIdx + size), [rows, startIdx, size]);

  const from = total === 0 ? 0 : startIdx + 1;
  const to = Math.min(total, startIdx + size);

  const navBtn =
    "flex h-8 min-w-8 items-center justify-center rounded-md border border-border-subtle bg-surface px-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-col gap-3">
      <DataTable columns={columns} rows={pageRows} empty={empty} onRowClick={onRowClick} />

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-text-tertiary">
          <div className="flex items-center gap-3">
            <span>
              Mostrando <span className="font-semibold text-text-secondary">{from}–{to}</span> de{" "}
              <span className="font-semibold text-text-secondary">{total.toLocaleString("es-CO")}</span>
            </span>
            <label className="flex items-center gap-1.5">
              <span className="hidden sm:inline">Mostrar</span>
              <select
                value={String(pageSize)}
                onChange={(e) => { const v = e.target.value; setPageSize(v === "all" ? "all" : Number(v)); setPage(1); }}
                className="rounded-md border border-border-subtle bg-surface px-1.5 py-1 text-[12px] font-semibold text-text-secondary"
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="all">Todo</option>
              </select>
            </label>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <button className={navBtn} onClick={() => setPage((p) => p - 1)} disabled={page <= 1} aria-label="Anterior">
                <Icon name="arrow-left" size={14} />
              </button>
              <div className="hidden items-center gap-1 sm:flex">
                {pageList(page, pageCount).map((p, i) =>
                  p === "…" ? (
                    <span key={`e${i}`} className="px-1 text-text-tertiary">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-[12px] font-semibold transition-colors ${
                        p === page
                          ? "border-brand bg-brand text-on-brand"
                          : "border-border-subtle bg-surface text-text-secondary hover:bg-surface-2"
                      }`}
                    >
                      {p}
                    </button>
                  ),
                )}
              </div>
              <span className="px-2 sm:hidden">{page} / {pageCount}</span>
              <button className={navBtn} onClick={() => setPage((p) => p + 1)} disabled={page >= pageCount} aria-label="Siguiente">
                <Icon name="arrow-right" size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
