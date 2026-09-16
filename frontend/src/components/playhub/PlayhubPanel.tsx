"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

type CatalogItem = { code: string; name: string; assignable: boolean; category: string };
type LocalSub = { id: string; productId: string | null; productName: string | null; voucher: string | null; syncedAt: string | null };
type Elegibilidad = { megas: number; plan: string | null; minMegas: number; elegible: boolean };

/**
 * Panel de PlayHub en la ficha del cliente: suscripciones locales, alta/baja de
 * productos (los que el operador asigna por API), y sincronización de la cuenta.
 */
export function PlayhubPanel({ subscriberId, email }: { subscriberId: string; email?: string | null }) {
  const { authFetch } = useAuth();
  const [status, setStatus] = useState<{ configured: boolean } | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [local, setLocal] = useState<LocalSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState("");
  const [busy, setBusy] = useState(false);
  const [toUnsub, setToUnsub] = useState<LocalSub | null>(null);
  const [eleg, setEleg] = useState<Elegibilidad | null>(null);
  const [vetado, setVetado] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // El 403 se marca aparte: si se traga como "sin datos", el panel acaba
      // diciendo "PlayHub no configurado" y parece una avería del servicio cuando
      // lo que falta es permiso (le pasaba a la cajera antes del 2026-09-04).
      let sinPermiso = false;
      const leer = async <T,>(url: string, vacio: T): Promise<T> => {
        const r = await authFetch(url);
        if (r.status === 403) { sinPermiso = true; return vacio; }
        return r.ok ? ((await r.json()) as T) : vacio;
      };
      const [st, cat, loc, el] = await Promise.all([
        leer<{ configured: boolean } | null>("/playhub/status", null),
        leer<CatalogItem[]>("/playhub/catalog", []),
        leer<LocalSub[]>(`/playhub/subscribers/${subscriberId}/local`, []),
        leer<Elegibilidad | null>(`/playhub/subscribers/${subscriberId}/eligibility`, null),
      ]);
      setStatus(st); setCatalog(cat); setLocal(loc); setEleg(el); setVetado(sinPermiso);
    } finally { setLoading(false); }
  }, [authFetch, subscriberId]);
  useEffect(() => { void load(); }, [load]);

  const assignable = catalog.filter((c) => c.assignable);

  async function subscribe() {
    if (!product) return;
    setBusy(true);
    try {
      const res = await authFetch(`/playhub/subscribers/${subscriberId}/subscribe`, { method: "POST", body: JSON.stringify({ productId: product }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo suscribir");
      toast(`Suscripción creada${d.voucher ? ` · voucher ${d.voucher}` : ""}`, "check");
      setProduct(""); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  async function doUnsub() {
    if (!toUnsub?.productId) return;
    setBusy(true);
    try {
      const res = await authFetch(`/playhub/subscribers/${subscriberId}/unsubscribe`, { method: "POST", body: JSON.stringify({ productId: toUnsub.productId }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo cancelar");
      toast("Suscripción cancelada", "check"); setToUnsub(null); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); setToUnsub(null); } finally { setBusy(false); }
  }

  async function action(path: string, okMsg: string) {
    setBusy(true);
    try {
      const res = await authFetch(`/playhub/subscribers/${subscriberId}/${path}`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(okMsg, "check"); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  if (loading) return <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-[13px] text-text-tertiary">Cargando PlayHub…</div>;

  if (vetado) return (
    <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-[13px] text-text-tertiary">
      No tienes permiso para ver PlayHub de este cliente.
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge label={status?.configured ? "PlayHub configurado" : "PlayHub no configurado"} tone={status?.configured ? "success" : "error"} />
        <span className="text-[12px] text-text-secondary">Login (email): <b className="font-mono">{email?.trim() || "— sin email —"}</b></span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => action("sync-customer", "Cuenta sincronizada con PlayHub")}><Icon name="user-check" size={13} /> Sincronizar cuenta</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => action("sync-local", "Suscripciones refrescadas desde PlayHub")}><Icon name="refresh-cw" size={13} /> Refrescar</Button>
        </div>
      </div>

      {eleg && !eleg.elegible && (
        <p className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          PlayHub sólo puede asignarse con plan de internet de {eleg.minMegas} Megas en adelante.
          Plan actual: <b>{eleg.plan ?? "sin internet"}</b>{eleg.megas > 0 ? ` (${eleg.megas} Megas)` : ""}.
        </p>
      )}

      {!email?.trim() && (
        <p className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          El cliente no tiene email. El login de PlayHub es el email, así que debes cargarlo antes de suscribir.
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 max-w-md">
          <label className="mb-1 block text-[12px] font-medium text-text-secondary">Suscribir producto (operador)</label>
          <Select value={product} onChange={(e) => setProduct(e.target.value)}>
            <option value="">— Elegir producto —</option>
            {assignable.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </Select>
        </div>
        <Button size="sm" disabled={busy || !product || !email?.trim() || (!!eleg && !eleg.elegible)} onClick={subscribe}><Icon name="plus" size={13} /> Suscribir</Button>
      </div>

      <div>
        <h3 className="mb-2 text-[13px] font-bold text-text-primary">Suscripciones activas</h3>
        {local.length === 0 ? (
          <p className="text-[12px] text-text-tertiary">Sin suscripciones registradas. Usa «Refrescar» para traerlas desde PlayHub.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {local.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface p-3">
                <div>
                  <div className="text-[13px] font-medium text-text-primary">{s.productName || s.productId}</div>
                  <div className="text-[11px] text-text-tertiary">
                    <span className="font-mono">{s.productId}</span>
                    {s.voucher && <> · voucher <span className="font-mono">{s.voucher}</span></>}
                    {s.syncedAt && <> · {new Date(s.syncedAt).toLocaleDateString("es-CO")}</>}
                  </div>
                </div>
                <button type="button" disabled={busy} onClick={() => setToUnsub(s)} className="text-[12px] font-medium text-error-text hover:underline disabled:opacity-40">Cancelar</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!toUnsub}
        title="Cancelar suscripción"
        message={<>¿Cancelar la suscripción a <b>{toUnsub?.productName || toUnsub?.productId}</b> en PlayHub?</>}
        confirmLabel="Cancelar suscripción"
        onConfirm={doUnsub}
        onClose={() => setToUnsub(null)}
      />
    </div>
  );
}
