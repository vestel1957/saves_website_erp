"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Select, Field } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";

type Account = {
  id: string; role: string; companyName: string | null; username: string;
  apiBaseUrl: string; authUrl: string; subscriptionKey: string | null;
  documentId: number | null; sellerId: number | null; ivaTaxId: number | null;
  paymentCash: number | null; paymentCredit: number | null; contactEmail: string | null;
  active: boolean; hasAccessKey: boolean; hasToken: boolean; tokenExpires: string | null;
  ready: boolean; missing: string[];
};

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

export default function CuentasSiigoPage() {
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [eMode, setEMode] = useState<{ live: boolean } | null>(null);

  useEffect(() => {
    if (authLoading || !canEmit) return;
    void authFetch("/einvoice/accounts").then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => setAccounts([]));
    void authFetch("/einvoice/mode").then((r) => (r.ok ? r.json() : null)).then(setEMode).catch(() => {});
  }, [authLoading, canEmit, authFetch]);

  function onUpdated(a: Account) {
    setAccounts((list) => list?.map((x) => (x.id === a.id ? a : x)) ?? null);
  }

  if (authLoading) return <PageSkeleton />;
  if (!canEmit) return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Solo contabilidad puede configurar las cuentas Siigo.</div>;

  return (
    <>
      <Link href="/facturacion/electronica" className="mb-1 inline-flex items-center gap-1 text-[12px] text-text-tertiary hover:text-text-secondary">
        <Icon name="arrow-left" size={13} /> Facturación electrónica
      </Link>
      <PageHeading icon="settings" title="Cuentas Siigo" subtitle="Configura el mapeo DIAN y las credenciales de cada cuenta para habilitar la emisión real." />

      {eMode && !eMode.live && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[12.5px] text-warning-text">
          <Icon name="alert-triangle" size={16} className="mt-0.5 shrink-0" />
          <div>
            El sistema está en <b>modo prueba (DRY-RUN)</b>. Aunque dejes las cuentas listas, la emisión seguirá simulada hasta activar <code className="font-mono">EINVOICE_LIVE=true</code> en el servidor (lo hace sistemas/infra al desplegar). La configuración de aquí queda guardada y lista.
          </div>
        </div>
      )}

      {!accounts ? <PageSkeleton /> : accounts.length === 0 ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">No hay cuentas Siigo registradas.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {accounts.map((a) => <AccountCard key={a.id} account={a} onUpdated={onUpdated} authFetch={authFetch} />)}
        </div>
      )}
    </>
  );
}

function AccountCard({ account, onUpdated, authFetch }: {
  account: Account;
  onUpdated: (a: Account) => void;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [form, setForm] = useState({
    companyName: account.companyName ?? "", role: account.role ?? "Internet", username: account.username ?? "",
    accessKey: "", apiBaseUrl: account.apiBaseUrl ?? "", authUrl: account.authUrl ?? "",
    subscriptionKey: account.subscriptionKey ?? "", contactEmail: account.contactEmail ?? "", active: account.active,
    documentId: account.documentId?.toString() ?? "", sellerId: account.sellerId?.toString() ?? "",
    ivaTaxId: account.ivaTaxId?.toString() ?? "", paymentCash: account.paymentCash?.toString() ?? "",
    paymentCredit: account.paymentCredit?.toString() ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        companyName: form.companyName, role: form.role, username: form.username,
        apiBaseUrl: form.apiBaseUrl, authUrl: form.authUrl, subscriptionKey: form.subscriptionKey,
        contactEmail: form.contactEmail, active: form.active,
        documentId: numOrNull(form.documentId), sellerId: numOrNull(form.sellerId),
        ivaTaxId: numOrNull(form.ivaTaxId), paymentCash: numOrNull(form.paymentCash),
        paymentCredit: numOrNull(form.paymentCredit),
      };
      if (form.accessKey.trim()) payload.accessKey = form.accessKey.trim();
      const res = await authFetch(`/einvoice/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo guardar");
      onUpdated(d);
      setForm((f) => ({ ...f, accessKey: "" }));
      toast(d.ready ? "Cuenta guardada — lista para emitir" : "Cuenta guardada", "check");
    } catch (e: any) {
      toast(e.message ?? "Error al guardar", "alert-circle");
    } finally { setSaving(false); }
  }

  async function test() {
    setTesting(true);
    try {
      const res = await authFetch(`/einvoice/accounts/${account.id}/test`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (d?.ok) { toast("Conexión con Siigo exitosa", "check"); onUpdated({ ...account, hasToken: true, tokenExpires: d.tokenExpires }); }
      else toast(d?.error ?? "No se pudo autenticar con Siigo", "alert-triangle");
    } catch { toast("Error probando la conexión", "alert-circle"); }
    finally { setTesting(false); }
  }

  return (
    <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm">
      {/* Cabecera de la tarjeta */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon name={form.role === "Tv" ? "tv" : "wifi"} size={18} className="text-brand" />
          <div>
            <div className="text-[14px] font-bold text-text-primary">{form.companyName || `Cuenta ${account.role}`}</div>
            <div className="text-[11px] text-text-tertiary">Rol: {account.role}{account.hasToken && account.tokenExpires ? ` · token válido hasta ${new Date(account.tokenExpires).toLocaleString("es-CO")}` : ""}</div>
          </div>
        </div>
        {account.ready
          ? <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-bold text-success-text"><Icon name="check" size={12} /> Lista para emitir</span>
          : <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-1 text-[11px] font-bold text-warning-text"><Icon name="alert-triangle" size={12} /> Faltan datos</span>}
      </div>

      {!account.ready && account.missing.length > 0 && (
        <div className="mb-4 rounded-lg bg-warning-soft/60 px-3 py-2 text-[11.5px] text-warning-text">
          Para emitir faltan: {account.missing.join(" · ")}
        </div>
      )}

      {/* Identidad / credenciales */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Razón social"><Input value={form.companyName} onChange={(e) => set("companyName", e.target.value)} /></Field>
        <Field label="Rol / servicio">
          <Select value={form.role} onChange={(e) => set("role", e.target.value)}>
            <option value="Internet">Internet</option>
            <option value="Tv">TV</option>
            <option value="Todo">Todo</option>
          </Select>
        </Field>
        <Field label="Email de contacto"><Input value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} /></Field>
        <Field label="Usuario API"><Input value={form.username} onChange={(e) => set("username", e.target.value)} /></Field>
        <Field label={`Access key${account.hasAccessKey ? " (guardada)" : ""}`}>
          <Input type="password" placeholder={account.hasAccessKey ? "•••••••• (dejar vacío = no cambiar)" : "Pegar access key de Siigo"} value={form.accessKey} onChange={(e) => set("accessKey", e.target.value)} />
        </Field>
        <Field label="Subscription key"><Input value={form.subscriptionKey} onChange={(e) => set("subscriptionKey", e.target.value)} /></Field>
        <Field label="URL API"><Input value={form.apiBaseUrl} onChange={(e) => set("apiBaseUrl", e.target.value)} /></Field>
        <Field label="URL Auth"><Input value={form.authUrl} onChange={(e) => set("authUrl", e.target.value)} /></Field>
      </div>

      {/* Mapeo DIAN */}
      <div className="mt-4 mb-2 text-[12px] font-bold text-text-secondary">Mapeo DIAN <span className="font-normal text-text-tertiary">(los campos con * son obligatorios para emitir)</span></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Field label="Comprobante DIAN *"><Input type="number" value={form.documentId} onChange={(e) => set("documentId", e.target.value)} /></Field>
        <Field label="Vendedor (sellerId) *"><Input type="number" value={form.sellerId} onChange={(e) => set("sellerId", e.target.value)} /></Field>
        <Field label="Medio pago efectivo *"><Input type="number" value={form.paymentCash} onChange={(e) => set("paymentCash", e.target.value)} /></Field>
        <Field label="Medio pago crédito"><Input type="number" value={form.paymentCredit} onChange={(e) => set("paymentCredit", e.target.value)} /></Field>
        <Field label="IVA (taxId)"><Input type="number" value={form.ivaTaxId} onChange={(e) => set("ivaTaxId", e.target.value)} /></Field>
      </div>

      {/* Acciones */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] font-medium text-text-secondary">
          <input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Cuenta activa
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={test} disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3.5 py-2 text-[13px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50">
            <Icon name={testing ? "loader" : "signal"} size={15} className={testing ? "animate-spin" : ""} /> Probar conexión
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-50">
            <Icon name={saving ? "loader" : "save"} size={15} className={saving ? "animate-spin" : ""} /> Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
