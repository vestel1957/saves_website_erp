"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import { type Plan, type ChangePlanResult, type ServiceKind, SERVICE_KIND_LABEL } from "@/lib/plans";

type SubService = { kind: ServiceKind | string; planName?: string | null; price?: number };

/** Orden en que se muestran los servicios en el modal. */
const KIND_ORDER: ServiceKind[] = ["INTERNET", "TV", "PUNTOS", "STREAMING"];

/**
 * Cambia los planes de un abonado desde el catálogo. Internet y TV se manejan
 * por separado: hay un selector por cada servicio y se pueden cambiar juntos o
 * uno solo. El nuevo precio manda la facturación mensual (no reprecia facturas
 * ya emitidas) y el perfil del plan se empuja al router (dry-run salvo LIVE).
 */
export function CambiarPlanModal({
  subscriberId,
  services = [],
  open,
  onClose,
  onDone,
}: {
  subscriberId: string;
  services?: SubService[];
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  // Selección por kind: kind → planId elegido ("" = mantener el actual).
  const [sel, setSel] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ChangePlanResult[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setResults(null);
    setSel({});
    void authFetch(`/plans?activeOnly=true`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPlans)
      .catch(() => setPlans([]));
  }, [open, authFetch]);

  // Planes agrupados por kind, respetando el orden de KIND_ORDER.
  const byKind = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of plans ?? []) {
      if (!map.has(p.kind)) map.set(p.kind, []);
      map.get(p.kind)!.push(p);
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => ({ kind: k, plans: map.get(k)! }));
  }, [plans]);

  const currentByKind = useMemo(() => {
    const m: Record<string, string | null | undefined> = {};
    for (const s of services) m[s.kind] = s.planName;
    return m;
  }, [services]);

  const chosenIds = Object.values(sel).filter(Boolean);

  async function apply() {
    if (chosenIds.length === 0) return;
    setBusy(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/plans`, {
        method: "POST",
        body: JSON.stringify({ planIds: chosenIds }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => null);
        throw new Error(msg?.message || "No se pudieron cambiar los planes");
      }
      const data: { ok: boolean; results: ChangePlanResult[] } = await res.json();
      setResults(data.results ?? []);
      toast("Planes actualizados", "check");
      onDone?.();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar planes del abonado">
      {/* Resultado (tras aplicar) */}
      {results ? (
        <div className="flex flex-col gap-3">
          {results.map((result, idx) => (
            <div key={idx} className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-primary">{result.plan.name}</span>
                <span className="text-[14px] font-bold text-text-primary">{fullCurrency(result.plan.price)}/mes</span>
              </div>
              {result.router && (
                <div className="mt-2 flex items-center gap-2">
                  <Icon name="router" size={14} />
                  <span className="text-[11px] font-semibold text-text-secondary">Router</span>
                  <Badge
                    tone={result.router.dryRun ? "warning" : result.router.ok ? "success" : "error"}
                    label={result.router.dryRun ? "DRY-RUN" : result.router.ok ? "APLICADO" : "ERROR"}
                  />
                  <span className="truncate text-[11px] text-text-tertiary">{result.router.message}</span>
                </div>
              )}
            </div>
          ))}
          <p className="text-[12px] text-text-tertiary">
            Los nuevos valores se facturan desde la próxima facturación mensual. Las facturas ya emitidas no cambian.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {!plans && <p className="text-[12px] text-text-tertiary">Cargando planes…</p>}

          {plans && byKind.length === 0 && (
            <p className="text-[12px] text-text-tertiary">
              No hay planes en el catálogo. Créalos en Configuración → Planes.
            </p>
          )}

          {byKind.map(({ kind, plans: kindPlans }) => {
            const current = currentByKind[kind];
            const selected = kindPlans.find((p) => p.id === sel[kind]) ?? null;
            return (
              <div key={kind} className="rounded-lg border border-border-subtle p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-text-primary">{SERVICE_KIND_LABEL[kind]}</span>
                  <span className="text-[11px] text-text-tertiary">
                    Actual: <span className="font-medium text-text-secondary">{current || "sin plan"}</span>
                  </span>
                </div>
                <Select value={sel[kind] ?? ""} onChange={(e) => setSel((s) => ({ ...s, [kind]: e.target.value }))}>
                  <option value="">— Mantener actual —</option>
                  {kindPlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {fullCurrency(p.price)}/mes{p.pppProfile ? ` (${p.pppProfile})` : ""}
                    </option>
                  ))}
                </Select>
                {selected && (
                  <p className="mt-1.5 text-[11px] text-text-tertiary">
                    {selected.pppProfile
                      ? `Se empuja el perfil "${selected.pppProfile}" al router (dry-run si el backend no está en LIVE).`
                      : "Este plan no tiene perfil de router; solo actualiza la mensualidad."}
                  </p>
                )}
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-text-tertiary">
              {chosenIds.length === 0 ? "Elige al menos un servicio a cambiar." : `${chosenIds.length} servicio(s) por cambiar.`}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>Cancelar</Button>
              <Button onClick={apply} disabled={chosenIds.length === 0 || busy}>
                {busy ? "Aplicando…" : "Cambiar planes"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
