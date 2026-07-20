"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning" | "info" | "brand"> = {
  DRAFT: "default",
  PENDING: "warning",
  APPROVED: "info",
  COMPLETED: "success",
  CANCELED: "error",
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  COMPLETED: "Completada",
  CANCELED: "Anulada",
};

function InfoCard({ label, value, icon }: { label: string; value: React.ReactNode; icon: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
        <Icon name={icon} size={17} />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
        <span className="text-[14px] font-bold text-text-primary">{value}</span>
      </div>
    </div>
  );
}

export default function DevolucionDetallePage() {
  const { loading: authLoading, authFetch } = useAuth();
  const params = useParams();
  const id = params?.id as string;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/returns/${id}`);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading || !id) return;
    void load();
  }, [authLoading, id, load]);

  if (authLoading || loading) return <PageSkeleton />;

  if (!data) {
    return (
      <>
        <Link href="/devoluciones" className="inline-flex items-center gap-1 text-[13px] font-semibold text-text-secondary hover:text-text-primary">
          <Icon name="arrow-left" size={15} /> Devoluciones
        </Link>
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">
          No se encontró la devolución.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading icon="receipt" title={`Devolución ${data.tid ?? ""}`} subtitle={data.supplier?.name ?? "Proveedor"} />
        <Badge label={STATUS_LABEL[data.status] ?? data.status ?? "—"} tone={STATUS_TONE[data.status ?? ""] ?? "default"} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <InfoCard label="Proveedor" value={data.supplier?.name ?? "—"} icon="user" />
        <InfoCard label="NIT" value={data.supplier?.nit ?? "—"} icon="file-text" />
        <InfoCard label="Fecha" value={data.date ?? "—"} icon="receipt" />
        <InfoCard label="Total" value={cop(data.total)} icon="dollar-sign" />
      </div>

      <DataTable
        rows={data.items ?? []}
        empty="Esta devolución no tiene ítems."
        columns={[
          { key: "product", header: "Producto", render: (r: any) => <span className="font-medium text-text-primary">{r.product}</span> },
          { key: "qty", header: "Cant.", align: "right", render: (r: any) => <span className="text-text-secondary">{r.qty}</span> },
          { key: "price", header: "Precio", align: "right", render: (r: any) => <span className="text-text-secondary">{cop(r.price)}</span> },
          { key: "subtotal", header: "Subtotal", align: "right", render: (r: any) => <span className="font-semibold text-text-secondary">{cop(r.subtotal)}</span> },
        ]}
      />

      <div className="flex flex-col items-end gap-1 rounded-xl border border-border-subtle bg-surface px-4 py-3">
        {typeof data.subtotal === "number" && (
          <div className="flex w-full max-w-xs items-center justify-between text-[13px]">
            <span className="text-text-tertiary">Subtotal</span>
            <span className="text-text-secondary">{cop(data.subtotal)}</span>
          </div>
        )}
        {typeof data.tax === "number" && (
          <div className="flex w-full max-w-xs items-center justify-between text-[13px]">
            <span className="text-text-tertiary">Impuesto</span>
            <span className="text-text-secondary">{cop(data.tax)}</span>
          </div>
        )}
        <div className="flex w-full max-w-xs items-center justify-between border-t border-border-subtle pt-1 text-[14px] font-bold">
          <span className="text-text-primary">Total</span>
          <span className="text-text-primary">{cop(data.total)}</span>
        </div>
      </div>

      {data.notes && (
        <div className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
          <span className="mb-1 block text-[11px] font-semibold text-text-tertiary">Nota</span>
          <p className="text-[13px] text-text-secondary">{data.notes}</p>
        </div>
      )}
    </>
  );
}
