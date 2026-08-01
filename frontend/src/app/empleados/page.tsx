"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { StatCard } from "@/components/ui/StatCard";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";
import { CARGOS_LEGACY } from "@/lib/hr";

const emptyForm = {
  name: "",
  docNumber: "",
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
  const { loading: authLoading, authFetch, isSuperadmin } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [areas, setAreas] = useState<any[]>([]);

  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [areaId, setAreaId] = useState("");
  /**
   * Los inhabilitados no se listan con los demás: esto le da la vuelta a la lista
   * y muestra SOLO a los que están fuera, para poder volver a habilitar a alguien.
   * Es la única puerta que queda y solo la ve el superusuario.
   */
  const [verInhabilitados, setVerInhabilitados] = useState(false);
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

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (role) qs.set("role", role);
      if (areaId) qs.set("areaId", areaId);
      if (verInhabilitados) qs.set("inhabilitados", "1");
      return `/staff?${qs.toString()}`;
    },
    [page, pageSize, search, role, areaId, verInhabilitados, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  // Debounce de búsqueda/filtros.

  // Al cambiar filtros, vuelve a página 1.
  useEffect(() => { setPage(1); }, [search, role, areaId, verInhabilitados, pageSize, orden.clave]);

  const setF = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = useCallback(async () => {
    if (!form.name.trim()) { toast("El nombre es obligatorio.", "alert-triangle"); return; }
    setSaving(true);
    try {
      const body: any = { name: form.name.trim() };
      for (const k of ["docNumber", "email", "phone", "eps", "pension", "rh", "address", "city"]) {
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
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo crear el empleado."), "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [authFetch, form, load]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="users"
          title="Empleados"
          subtitle={stats ? `${(stats.total ?? 0).toLocaleString("es-CO")} empleados activos` : "Talento humano"}
        />
        <Button variant="primary" onClick={() => setOpenNew(true)}>
          <Icon name="plus" size={15} />
          Nuevo empleado
        </Button>
      </div>

      {/* Tarjetas de resumen */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="Empleados activos" value={(stats?.total ?? 0).toLocaleString("es-CO")} icon="users" />
        <StatCard label="Técnicos" value={(stats?.tecnicos ?? 0).toLocaleString("es-CO")} tone="text-brand" icon="activity" />
      </div>

      {/* Filtros */}
      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por nombre o documento…">
        <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-auto">
          <option value="">Todos los roles</option>
          {CARGOS_LEGACY.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={areaId} onChange={(e) => setAreaId(e.target.value)} className="w-auto">
          <option value="">Todas las áreas</option>
          {areas.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        {isSuperadmin && (
          <Button variant={verInhabilitados ? "primary" : "secondary"} onClick={() => setVerInhabilitados((v) => !v)}>
            <Icon name={verInhabilitados ? "users" : "lock"} size={15} />
            {verInhabilitados ? "Ver activos" : "Ver inhabilitados"}
          </Button>
        )}
      </ListToolbar>

      {/* Tabla */}
      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty={verInhabilitados ? "No hay empleados inhabilitados." : "No se encontraron empleados con esos criterios."}
            onRowClick={(r: any) => router.push(`/empleados/${r.id}`)}
            columns={[
              { key: "name", header: "Nombre", sortable: true, render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "docNumber", header: "Documento", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.docNumber ?? "—"}</span> },
              { key: "role", header: "Rol", sortable: true, render: (r: any) => <Badge label={r.roleLabel ?? "—"} tone="info" /> },
              { key: "area", header: "Área", sortable: true, render: (r: any) => r.area ?? "—" },
              { key: "phone", header: "Teléfono", sortable: true, render: (r: any) => r.phone ?? "—" },
            ]}
          />
          {data && (
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
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setF("email", e.target.value)} />
          </Field>
          <Field label="Teléfono">
            <Input value={form.phone} onChange={(e) => setF("phone", e.target.value)} />
          </Field>
          <Field label="Rol">
            <Select value={form.role} onChange={(e) => setF("role", e.target.value)}>
              <option value="">Sin rol</option>
              {CARGOS_LEGACY.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
