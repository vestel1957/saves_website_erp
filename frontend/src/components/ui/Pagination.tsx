"use client";

import { Icon } from "../Icon";

export type PageMeta = {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

const PAGE_SIZES = [25, 50, 100];

/** Lista de páginas a mostrar con elipsis: 1 … (p-1) p (p+1) … N */
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

export function Pagination({
  meta,
  onPage,
  onPageSize,
}: {
  meta: PageMeta;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
}) {
  const { page, pageSize, total, pageCount } = meta;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const navBtn =
    "flex h-8 min-w-8 items-center justify-center rounded-md border border-border-subtle bg-surface px-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-text-tertiary">
      <div className="flex items-center gap-3">
        <span>
          Mostrando <span className="font-semibold text-text-secondary">{from}–{to}</span> de{" "}
          <span className="font-semibold text-text-secondary">{total.toLocaleString("es-CO")}</span>
        </span>
        {onPageSize && (
          <label className="flex items-center gap-1.5">
            <span className="hidden sm:inline">por página</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="rounded-md border border-border-subtle bg-surface px-1.5 py-1 text-[12px] font-semibold text-text-secondary"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button className={navBtn} onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Anterior">
          <Icon name="arrow-left" size={14} />
        </button>

        {/* números — ocultos en móvil muy angosto, visibles desde sm */}
        <div className="hidden items-center gap-1 sm:flex">
          {pageList(page, pageCount).map((p, i) =>
            p === "…" ? (
              <span key={`e${i}`} className="px-1 text-text-tertiary">…</span>
            ) : (
              <button
                key={p}
                onClick={() => onPage(p)}
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

        {/* móvil: indicador compacto */}
        <span className="px-2 sm:hidden">
          {page} / {pageCount}
        </span>

        <button className={navBtn} onClick={() => onPage(page + 1)} disabled={page >= pageCount} aria-label="Siguiente">
          <Icon name="arrow-right" size={14} />
        </button>
      </div>
    </div>
  );
}
