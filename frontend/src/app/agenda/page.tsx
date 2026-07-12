"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

export default function AgendaPage() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);

  // ── Eventos ───────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [pages, setPages] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // ── Stats ─────────────────────────────────────────────────────────────────
  const [stats, setStats] = useState<any>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/omni/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${page}&pageSize=${pageSize}`;
      const d: any = await (await authFetch(url)).json();
      setRows(d.items ?? []);
      setTotal(d.total ?? 0);
      setPages(d.pages ?? 1);
    } finally {
      setLoading(false);
    }
  }, [authFetch, from, to, page, pageSize]);

  const loadStats = useCallback(async () => {
    const d: any = await (await authFetch("/omni/events/stats")).json();
    setStats(d);
  }, [authFetch]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const columns = [
    {
      key: "start",
      header: "Inicio",
      render: (r: any) =>
        r.start
          ? new Date(r.start).toLocaleString("es-CO", {
              day: "2-digit",
              month: "short",
              hour: r.allDay ? undefined : "2-digit",
              minute: r.allDay ? undefined : "2-digit",
            })
          : "—",
    },
    {
      key: "title",
      header: "Título",
      render: (r: any) => (
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: r.color || "var(--color-brand, #6366f1)" }}
          />
          <span className="font-medium text-text-primary">{r.title || "—"}</span>
        </span>
      ),
    },
    {
      key: "description",
      header: "Descripción",
      render: (r: any) => <span className="text-text-secondary">{r.description || "—"}</span>,
    },
    {
      key: "orderNo",
      header: "Orden",
      render: (r: any) =>
        r.orderNo ? <span className="font-mono text-[12px] text-text-secondary">#{r.orderNo}</span> : "—",
    },
    { key: "assignedBy", header: "Asignó", render: (r: any) => r.assignedBy || "—" },
  ];

  if (loading && rows.length === 0 && !stats) return <PageSkeleton />;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="calendar-clock" title="Agenda" subtitle="Eventos y programación de órdenes" />
        <Link href="/ordenes" className="hidden sm:block">
          <Button variant="ghost" size="sm">
            <Icon name="arrow-left" size={14} /> Órdenes
          </Button>
        </Link>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft">
            <Icon name="calendar-clock" size={18} className="text-brand" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Total eventos</p>
            <p className="text-[18px] font-bold text-text-primary">{stats?.total ?? 0}</p>
          </div>
        </div>
        {stats?.ultimo && (
          <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2">
              <Icon name="activity" size={18} className="text-text-secondary" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Último evento</p>
              <p className="truncate text-[13px] font-semibold text-text-primary">
                {new Date(stats.ultimo).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Eventos */}
      <div className="flex flex-col gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void loadEvents();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <Field label="Desde">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary">
            <Icon name="search" size={14} /> Filtrar
          </Button>
        </form>

        <DataTable columns={columns} rows={rows} empty="No hay eventos en el rango seleccionado" />

        {total > 0 && (
          <Pagination
            meta={{ page, pageSize, total, pageCount: pages }}
            onPage={setPage}
            onPageSize={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        )}
      </div>
    </>
  );
}
