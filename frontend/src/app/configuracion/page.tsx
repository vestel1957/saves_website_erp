"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type Tab = "Empresa" | "Sedes" | "Cajas" | "Geografía";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "Empresa", label: "Empresa", icon: "settings" },
  { key: "Sedes", label: "Sedes", icon: "map-pin" },
  { key: "Cajas", label: "Cajas", icon: "banknote" },
  { key: "Geografía", label: "Geografía", icon: "map-pin" },
];

/* -------------------------------------------------------------------------- */
/* Empresa                                                                    */
/* -------------------------------------------------------------------------- */

function EmpresaTab() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState<any>(null);
  const [form, setForm] = useState<any>({
    name: "",
    taxId: "",
    address: "",
    city: "",
    region: "",
    phone: "",
    email: "",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data: any = await (await authFetch("/config/company")).json();
      setCompany(data);
      setForm({
        name: data?.name ?? "",
        taxId: data?.taxId ?? "",
        address: data?.address ?? "",
        city: data?.city ?? "",
        region: data?.region ?? "",
        phone: data?.phone ?? "",
        email: data?.email ?? "",
      });
    } catch {
      toast("No se pudo cargar la empresa", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f: any) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch("/config/company", {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          address: form.address,
          city: form.city,
          region: form.region,
          phone: form.phone,
          email: form.email,
          taxId: form.taxId,
        }),
      });
      const d: any = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      setCompany(d);
      toast("Empresa actualizada");
    } catch (e: any) {
      toast(e?.message || "No se pudo guardar", "x");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <PageSkeleton />;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon name="settings" size={16} className="text-text-secondary" />
        <h2 className="text-[14px] font-bold text-text-primary">Datos de la empresa</h2>
        {company?.currency && (
          <Badge label={company.currency} tone="info" />
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={form.name} onChange={set("name")} placeholder="Nombre de la empresa" />
        </Field>
        <Field label="NIT / Tax ID">
          <Input value={form.taxId} onChange={set("taxId")} placeholder="NIT" />
        </Field>
        <Field label="Dirección">
          <Input value={form.address} onChange={set("address")} placeholder="Dirección" />
        </Field>
        <Field label="Ciudad">
          <Input value={form.city} onChange={set("city")} placeholder="Ciudad" />
        </Field>
        <Field label="Departamento / Región">
          <Input value={form.region} onChange={set("region")} placeholder="Región" />
        </Field>
        <Field label="Teléfono">
          <Input value={form.phone} onChange={set("phone")} placeholder="Teléfono" />
        </Field>
        <Field label="Correo">
          <Input value={form.email} onChange={set("email")} placeholder="correo@empresa.com" />
        </Field>
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={saving}>
          <Icon name="check" size={15} />
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sedes                                                                       */
/* -------------------------------------------------------------------------- */

function SedesTab() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<any>({ name: "", summary: "", dir: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data: any = await (await authFetch("/config/branches")).json();
      setBranches(Array.isArray(data) ? data : []);
    } catch {
      toast("No se pudieron cargar las sedes", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = (row: any) => {
    setEditing(row);
    setForm({ name: row?.name ?? "", summary: row?.summary ?? "", dir: row?.dir ?? "" });
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await authFetch(`/config/branches/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: form.name, summary: form.summary, dir: form.dir }),
      });
      const d: any = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Sede actualizada");
      setEditing(null);
      await load();
    } catch (e: any) {
      toast(e?.message || "No se pudo guardar", "x");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <PageSkeleton />;

  return (
    <>
      <DataTable
        rows={branches}
        columns={[
          { key: "name", header: "Sede", render: (r: any) => <span className="font-medium">{r.name}</span> },
          { key: "dir", header: "Dirección", render: (r: any) => r.dir || "—" },
          {
            key: "subscribers",
            header: "# Abonados",
            align: "right",
            render: (r: any) => r.subscribers ?? 0,
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (r: any) => (
              <Button variant="secondary" size="sm" onClick={() => openEdit(r)}>
                Editar
              </Button>
            ),
          },
        ]}
      />

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Editar sede">
        <div className="flex flex-col gap-3">
          <Field label="Nombre">
            <Input
              value={form.name}
              onChange={(e) => setForm((f: any) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label="Resumen">
            <Input
              value={form.summary}
              onChange={(e) => setForm((f: any) => ({ ...f, summary: e.target.value }))}
            />
          </Field>
          <Field label="Dirección">
            <Input
              value={form.dir}
              onChange={(e) => setForm((f: any) => ({ ...f, dir: e.target.value }))}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              <Icon name="check" size={15} />
              {saving ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Cajas                                                                       */
/* -------------------------------------------------------------------------- */

function CajasTab() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data: any = await (await authFetch("/config/cash-accounts")).json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch {
      toast("No se pudieron cargar las cajas", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <PageSkeleton />;

  return (
    <DataTable
      rows={accounts}
      columns={[
        { key: "holder", header: "Titular", render: (r: any) => <span className="font-medium">{r.holder}</span> },
        { key: "accountNumber", header: "Nº cuenta", render: (r: any) => r.accountNumber || "—" },
        { key: "sede", header: "Sede", render: (r: any) => r.sede || "—" },
        {
          key: "balance",
          header: "Saldo",
          align: "right",
          render: (r: any) => (
            <span className={Number(r.balance) < 0 ? "font-semibold text-error-text" : "font-medium"}>
              {cop(Number(r.balance) || 0)}
            </span>
          ),
        },
      ]}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Geografía                                                                   */
/* -------------------------------------------------------------------------- */

function GeografiaTab() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [geo, setGeo] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data: any = await (await authFetch("/config/geography")).json();
      setGeo(data);
    } catch {
      toast("No se pudo cargar la geografía", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <PageSkeleton />;

  const totals = geo?.totals ?? {};
  const cards = [
    { label: "Departamentos", value: totals.departamentos ?? 0, icon: "map-pin" },
    { label: "Ciudades", value: totals.ciudades ?? 0, icon: "map-pin" },
    { label: "Localidades", value: totals.localidades ?? 0, icon: "boxes" },
    { label: "Barrios", value: totals.barrios ?? 0, icon: "package" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-border-subtle bg-surface p-4">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2">
              <Icon name={c.icon} size={16} className="text-text-secondary" />
            </div>
            <div className="text-[22px] font-bold text-text-primary">{c.value}</div>
            <div className="text-[12px] text-text-tertiary">{c.label}</div>
          </div>
        ))}
      </div>

      <DataTable
        rows={geo?.departamentos ?? []}
        empty="Sin departamentos."
        columns={[
          { key: "name", header: "Departamento", render: (r: any) => <span className="font-medium">{r.name}</span> },
          {
            key: "ciudades",
            header: "# Ciudades",
            align: "right",
            render: (r: any) => r.ciudades ?? 0,
          },
        ]}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Página                                                                      */
/* -------------------------------------------------------------------------- */

export default function ConfiguracionPage() {
  const { loading: authLoading } = useAuth();
  const [tab, setTab] = useState<Tab>("Empresa");

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        icon="sliders-horizontal"
        title="Configuración"
        subtitle="Empresa, sedes, cajas y geografía"
      />

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                active
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-border-default text-text-secondary hover:bg-surface-2"
              }`}
            >
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "Empresa" && <EmpresaTab />}
      {tab === "Sedes" && <SedesTab />}
      {tab === "Cajas" && <CajasTab />}
      {tab === "Geografía" && <GeografiaTab />}
    </div>
  );
}
