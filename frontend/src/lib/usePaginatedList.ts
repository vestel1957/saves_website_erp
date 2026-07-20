"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import type { PageMeta } from "@/components/ui/Pagination";
import type { SortState } from "@/components/ui/DataTable";

type Params = Record<string, string | undefined>;

/**
 * Maneja un listado paginado del backend (sobre `{ data, total, page, pageSize,
 * pageCount }`). Reusable por las tablas del módulo: lleva página, tamaño,
 * orden y filtros extra, y refetcha cuando cambian. Resetea a la página 1 al
 * cambiar filtros, tamaño u orden.
 */
export function usePaginatedList<T>(opts: {
  path: string;
  initialSort?: SortState;
  initialPageSize?: number;
  /** Filtros extra (search, type, warehouseId…). Valores vacíos se omiten. */
  params?: Params;
}) {
  const { authFetch } = useAuth();
  const { path, initialSort, initialPageSize = 25, params = {} } = opts;

  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [sort, setSort] = useState<SortState | undefined>(initialSort);
  const [rows, setRows] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta>({ page: 1, pageSize: initialPageSize, total: 0, pageCount: 1 });
  const [loading, setLoading] = useState(true);

  const paramsKey = JSON.stringify(params);

  // Al cambiar filtros, orden o tamaño, vuelve a la página 1.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setPage(1);
  }, [paramsKey, pageSize, sort?.by, sort?.dir]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (sort) {
      qs.set("sortBy", sort.by);
      qs.set("sortDir", sort.dir);
    }
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    try {
      const res = await authFetch(`${path}?${qs.toString()}`);
      if (res.ok) {
        const j = await res.json();
        setRows(j.data ?? []);
        setMeta({ page: j.page, pageSize: j.pageSize, total: j.total, pageCount: j.pageCount });
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch, path, page, pageSize, sort?.by, sort?.dir, paramsKey]);

  useEffect(() => {
    load();
  }, [load]);

  /** Click en encabezado: alterna asc/desc o cambia de columna (asc). */
  const toggleSort = useCallback((by: string) => {
    setSort((s) => (s && s.by === by ? { by, dir: s.dir === "asc" ? "desc" : "asc" } : { by, dir: "asc" }));
  }, []);

  const setPageSize = useCallback((n: number) => setPageSizeState(n), []);

  return { rows, meta, loading, sort, toggleSort, page, setPage, pageSize, setPageSize, reload: load };
}
