"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { StatCard } from "@/components/ui/StatCard";

const ROLE_LABELS: Record<string, string> = {
  "2": "Cajero",
  "3": "Técnico",
  "4": "Administrativo",
  "5": "Administrador",
};

const emptyForm = {
  name: "",
  docNumber: "",
  username: "",
  email: "",
  role: "",
  areaId: "",
  phone: "",
  eps: "",
  pension: "",
  rh: "",
  address: "",
  city: "",
};

export default function EmpleadosPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [areas, setAreas] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [areaId, setAreaId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [openNew, setOpenNew] = useState(false);
  const [form, setForm] = useState<any>(emptyForm);
  const [saving, setSaving] = useState(false);

  // Carga catálogos una vez.
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/staff/stats").then((r) => r.json()).then(setStats).catch(() => {});
    void authFetch("/staff/areas").then((r) => r.json()).then(setAreas).catch(() => {});
  }, [authLoading, authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (role) qs.set("role", role);
    if (areaId) qs.set("areaId", areaId);
    if (status) qs.set("status", status);
    try {
      const res = await authFetch(`/staff?${qs.toString()}`);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, page, pageSize, search, role, areaId, status]);

  // Debounce de búsqueda/filtros.
  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [authLoading, load]);

  // Al cambiar filtros, vuelve a página 1.
  useEffect(() => { setPage(1); }, [search, role, areaId, status, pageSize]);

  const setF = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = useCallback(async () => {
    if (!form.name.trim()) { toast("El nombre es obligatorio.", "alert-triangle"); return; }
    setSaving(true);
    try {
      const body: any = { name: form.name.trim() };
      for (const k of ["docNumber", "username", "email", "phone", "eps", "pension", "rh", "address", "city"]) {
        if (form[k]?.trim()) body[k] = form[k].trim();
      }
      if (form.role) body.role = Number(form.role);
      if (form.areaId) body.areaId = form.areaId;
      const res = await authFetch("/staff", { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Empleado creado.", "check");
      setOpenNew(false);
      setForm(emptyForm);
      await load();
      void authFetch("/staff/stats").then((r) => r.json()).then(setStats).catch(() => {});
    } catch (e: any) {
      toast(e?.message || "No se pudo crear el empleado.", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [authFetch, form, load]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading
          icon="users"
          title="Empleados"
          subtitle={stats ? `${(stats.total ?? 0).toLocaleString("es-CO")} empleados · ${(stats.activos ?? 0).toLocaleString("es-CO")} activos` : "Talento humano"}
        />
        <Button variant="primary" onClick={() => setOpenNew(true)}>
          <Icon name="plus" size={15} />
          Nuevo empleado
        </Button>
      </div>

      {/* Tarjetas de resumen */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Total empleados" value={(stats?.total ?? 0).toLocaleString("es-CO")} icon="users" />
        <StatCard label="Activos" value={(stats?.activos ?? 0).toLocaleString("es-CO")} tone="text-success-text" icon="check" />
        <StatCard label="Técnicos" value={(stats?.tecnicos ?? 0).toLocaleString("es-CO")} tone="text-brand" icon="activity" />
      </div>

      {/* Filtros */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder="Buscar por nombre, documento o usuario…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-auto">
          <option value="">Todos los roles</option>
          {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={areaId} onChange={(e) => setAreaId(e.target.value)} className="w-auto">
          <option value="">Todas las áreas</option>
          {areas.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          <option value="active">Activos</option>
          <option value="banned">Inhabilitados</option>
        </Select>
      </div>

      {/* Tabla */}
      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron empleados con esos criterios."
            onRowClick={(r: any) => router.push(`/empleados/${r.id}`)}
            columns={[
              { key: "name", header: "Nombre", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "docNumber", header: "Documento", render: (r: any) => <span className="text-text-secondary">{r.docNumber ?? "—"}</span> },
              { key: "username", header: "Usuario", render: (r: any) => <span className="text-text-secondary">{r.username ?? "—"}</span> },
              { key: "role", header: "Rol", render: (r: any) => <Badge label={r.roleLabel ?? "—"} tone="info" /> },
              { key: "area", header: "Área", render: (r: any) => r.area ?? "—" },
              { key: "phone", header: "Teléfono", render: (r: any) => r.phone ?? "—" },
              { key: "banned", header: "Estado", render: (r: any) => <Badge label={r.banned ? "Inhabilitado" : "Activo"} tone={r.banned ? "error" : "success"} /> },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination
                meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      {/* Modal nuevo empleado */}
      <Modal open={openNew} onClose={() => setOpenNew(false)} title="Nuevo empleado">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Nombre" required>
              <Input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="Nombre completo" />
            </Field>
          </div>
          <Field label="Documento">
            <Input value={form.docNumber} onChange={(e) => setF("docNumber", e.target.value)} />
          </Field>
          <Field label="Usuario">
            <Input value={form.username} onChange={(e) => setF("username", e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setF("email", e.target.value)} />
          </Field>
          <Field label="Teléfono">
            <Input value={form.phone} onChange={(e) => setF("phone", e.target.value)} />
          </Field>
          <Field label="Rol">
            <Select value={form.role} onChange={(e) => setF("role", e.target.value)}>
              <option value="">Sin rol</option>
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Área">
            <Select value={form.areaId} onChange={(e) => setF("areaId", e.target.value)}>
              <option value="">Sin área</option>
              {areas.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="RH">
            <Input value={form.rh} onChange={(e) => setF("rh", e.target.value)} placeholder="O+" />
          </Field>
          <Field label="EPS">
            <Input value={form.eps} onChange={(e) => setF("eps", e.target.value)} />
          </Field>
          <Field label="Pensión">
            <Input value={form.pension} onChange={(e) => setF("pension", e.target.value)} />
          </Field>
          <Field label="Ciudad">
            <Input value={form.city} onChange={(e) => setF("city", e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Dirección">
              <Input value={form.address} onChange={(e) => setF("address", e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpenNew(false)} disabled={saving}>
            <Icon name="x" size={15} />
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            <Icon name="check" size={15} />
            {saving ? "Guardando…" : "Crear empleado"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
