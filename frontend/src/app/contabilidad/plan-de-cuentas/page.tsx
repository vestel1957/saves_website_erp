"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { AccountChart } from "@/components/accounting/AccountChart";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi } from "@/lib/accounting";
import type { AccountNode } from "@/lib/accounting-types";

export default function PlanDeCuentasPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tree = await api.getAccountsTree();
        if (alive) setNodes(tree);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [api]);

  if (loading) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="list-tree" title="Plan de cuentas" subtitle="Estructura PUC del negocio (clase → grupo → cuenta → auxiliar)" />
      {error ? (
        <div className="rounded-xl border border-error-subtle bg-error-soft p-4 text-[13px] text-error-text">{error}</div>
      ) : (
        <AccountChart nodes={nodes} />
      )}
    </div>
  );
}
