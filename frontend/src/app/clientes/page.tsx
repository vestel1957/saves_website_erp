"use client";

import { useCallback, useEffect, useState } from "react";
import { listaJson, mensajeDeError } from "@/lib/errores";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { toast } from "@/components/ui/Toast";
import { ClienteWizardModal } from "@/components/subscribers/ClienteWizardModal";
import { SubscriberFilters } from "@/components/subscribers/SubscriberFilters";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import {
  type SubscriberList, type Branch,
  SUB_STATUS_LABEL, SUB_STATUS_TONE, cuentaParams, ubicacionDe,
} from "@/lib/subscribers";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { LoadError } from "@/components/ui/LoadError";

export default function ClientesPage() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [exportando, setExportando] = useState(false);
  const { loading: authLoading, authFetch, sedeScoped } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [servicio, setServicio] = useState("");
  const [tecnologia, setTecnologia] = useState("");
  const [cuenta, setCuenta] = useState("");
  // Plan concreto: llega por la URL desde /configuracion/planes ("125 abonado(s)"
  // es un enlace) y no tiene desplegable propio, porque el catálogo son 64 planes
  // y aquí sólo se usa para responder "¿quiénes son esos abonados?".
  const [planId, setPlanId] = useState("");
  const [planNombre, setPlanNombre] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // El listado se pagina en el servidor, así que el orden también: ordenar aquí
  // solo movería las 25 filas de la página.
  const orden = useOrden();

  // Carga catálogos una vez.
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/subscribers/branches").then(listaJson).then(setBranches).catch(() => {});
  }, [authLoading, authFetch]);

  // Filtro por plan venido de fuera. El nombre se busca en el catálogo en vez de
  // viajar en la URL para que un enlace guardado siga diciendo de qué plan habla.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("planId");
    if (id) setPlanId(id);
  }, []);
  useEffect(() => {
    if (authLoading || !planId) { setPlanNombre(""); return; }
    void authFetch("/plans").then(listaJson)
      .then((ps: { id: string; name: string }[]) => setPlanNombre(ps.find((p) => p.id === planId)?.name ?? ""))
      .catch(() => {});
  }, [authLoading, authFetch, planId]);

  /**
   * Los filtros que están puestos en pantalla, en forma de query.
   *
   * Lo usan la tabla y el Excel: si cada uno armara los suyos, el archivo acabaría
   * diciendo algo distinto de lo que se está mirando, que es la peor forma de
   * equivocarse con una lista de 21.000 clientes.
   */
  const filtrosQs = useCallback(() => {
    const qs = new URLSearchParams({ ...orden.params });
    if (search.trim()) qs.set("search", search.trim());
    if (status) qs.set("status", status);
    if (branchId) qs.set("branchId", branchId);
    if (servicio) qs.set("servicio", servicio);
    if (planId) qs.set("planId", planId);
    if (tecnologia) qs.set("tecnologia", tecnologia);
    const cp = cuentaParams(cuenta);
    if (cp.cuenta) qs.set("cuenta", cp.cuenta);
    if (cp.deuda) qs.set("deuda", cp.deuda);
    return qs;
  }, [orden.params, search, status, branchId, servicio, planId, tecnologia, cuenta]);

  /**
   * Excel de TODOS los clientes que cumplen los filtros, no de la página que se ve.
   *
   * Vive aquí y no solo en "Grupos de clientes" (2026-09-01, tras "las cajeras no
   * pueden descargar el excel con los clientes"): la API ya dejaba exportar al área
   * de caja, pero el único botón estaba en una pantalla que la cajera no tiene en su
   * menú. El listado es donde se busca, así que es donde tiene que estar el botón.
   * Lo que puede bajar cada quien lo sigue decidiendo el servidor: el archivo sale
   * acotado a sus sedes, igual que la tabla.
   */
  const exportar = async () => {
    setExportando(true);
    try {
      const res = await authFetch(`/subscribers/export.xlsx?${filtrosQs().toString()}`);
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `clientes-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setExportando(false);
    }
  };

  /** Quita el filtro y limpia la URL (si no, recargar lo devolvería). */
  function quitarPlan() {
    setPlanId("");
    setPlanNombre("");
    router.replace("/clientes");
  }

  // Carga con cancelación: al teclear en el filtro, la petición en vuelo se aborta.
  // Antes sólo se cancelaba el temporizador del debounce, así que una respuesta
  // lenta podía llegar después de otra más nueva y pisar la tabla con datos que ya
  // no correspondían al filtro escrito.
  const {
    data,
    cargando: loading,
    error,
    refrescar: load,
  } = useRequest<SubscriberList>(
    () => {
      // withPlan: la tabla enseña qué tiene contratado cada cliente. El backend lo
      // busca en el servicio registrado y, si no lo tiene, en sus facturas o en el
      // perfil de red (ver `serviciosDeRespaldo`).
      const qs = filtrosQs();
      qs.set("page", String(page));
      qs.set("pageSize", String(pageSize));
      qs.set("withPlan", "1");
      return `/subscribers?${qs.toString()}`;
    },
    [page, pageSize, search, status, branchId, servicio, planId, tecnologia, cuenta, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  // Al cambiar filtros o el orden, vuelve a página 1: lo que el usuario busca al
  // ordenar está al principio, no en la página en la que estaba.
  useEffect(() => { setPage(1); }, [search, status, branchId, servicio, planId, tecnologia, cuenta, pageSize, orden.clave]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading
        icon="users"
        title="Clientes"
        subtitle={data ? `${data.total.toLocaleString("es-CO")} clientes` : "Clientes ISP"}
      />

      {/* Filtros */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar por nombre, documento, celular, abonado o ID…"
        actions={
          <>
            {/* Se apaga mientras no hay nada que bajar: un Excel con la cabecera
                sola parece un fallo del sistema y no un filtro sin resultados. */}
            <Button variant="secondary" onClick={exportar} disabled={exportando || !data?.total}>
              <Icon name="download" size={15} /> {exportando ? "Exportando…" : "Excel"}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Icon name="user-plus" size={15} /> Nuevo cliente
            </Button>
          </>
        }
      >
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(SUB_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {/* Sin filtro de sede para quien está acotado a la suya: el listado ya viene
            sólo con sus clientes, así que elegir sede no tendría entre qué elegir. */}
        {!sedeScoped && (
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
            <option value="">Todas las sedes</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
        <SubscriberFilters
          servicio={servicio} tecnologia={tecnologia} cuenta={cuenta}
          onServicio={setServicio} onTecnologia={setTecnologia} onCuenta={setCuenta}
        />
        {/* El filtro por plan no se ve en ningún desplegable, así que se anuncia
            aquí: sin esto la lista saldría recortada sin decir por qué. */}
        {planId && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1 text-[12px] font-semibold text-brand">
            <Icon name="wifi" size={12} className="shrink-0" />
            Plan: {planNombre || "seleccionado"}
            <button type="button" onClick={quitarPlan} className="tap rounded-full p-0.5 hover:bg-surface-2" title="Quitar el filtro de plan">
              <Icon name="x" size={12} />
            </button>
          </span>
        )}
      </ListToolbar>

      <ClienteWizardModal
        mode="create"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(id) => { if (id) router.push(`/clientes/${id}`); else void load(); }}
      />

      {/* Tabla */}
      {error && !data ? (
        // Distingue "falló la carga" de "no hay clientes": antes un 500 dejaba la
        // tabla vacía y parecía que el filtro no devolvía nada.
        <LoadError message={error} onRetry={load} />
      ) : loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron clientes con esos criterios."
            sort={orden.sort}
            onSort={orden.onSort}
            columns={[
              { key: "abonado", header: "Abonado", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              // El ID del legacy: es el número por el que se pregunta al otro sistema.
              // Los clientes creados aquí no lo tienen.
              { key: "legacyId", header: "ID", sortable: true, render: (r) => <span className="font-mono text-text-tertiary">{r.legacyId ?? "—"}</span> },
              { key: "name", header: "Nombre", sortable: true, render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "doc", header: "Documento", sortable: true, render: (r) => <span className="text-text-secondary">{r.docNumber ?? "—"}</span> },
              { key: "phone", header: "Celular", sortable: true, render: (r) => r.phone ?? "—" },
              // Dónde vive: la dirección arriba y debajo el barrio y la sede, todo en
              // una columna —son la misma pregunta— para no sumarle otra a una tabla
              // que ya es ancha. Ordena por SEDE: la dirección se arma en el servidor
              // a partir de piezas sueltas y el barrio en la BD es un id de catálogo,
              // así que ninguno de los dos daría el alfabético que uno espera.
              {
                key: "branch",
                header: "Dirección",
                sortable: true,
                render: (r: any) => (
                  <div className="flex flex-col leading-tight">
                    {/* Sin dirección armada queda la referencia ('Frente a la
                        Hogareña', 'LOTE 16 Mz 3'): a 510 abonados es lo único que
                        se tiene para dar con la casa, y vale más que un guion. */}
                    {r.address ? (
                      <span className="text-text-secondary">{r.address}</span>
                    ) : r.addressRef ? (
                      <span className="text-text-tertiary">{r.addressRef}</span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                    {/* Barrio · municipio · sede, sin repetir: cada sede lleva el
                        nombre de su municipio y coinciden en el 99,7% de los
                        abonados ("Centro · Yopal · Yopal"). La sede solo se nombra
                        cuando difiere —los 44 clientes atendidos desde otra— que es
                        justo cuando enterarse importa. */}
                    <span className="text-[11px] text-text-tertiary">
                      {ubicacionDe(r) || "—"}
                    </span>
                  </div>
                ),
              },
              {
                key: "plan",
                header: "Plan",
                render: (r: any) => {
                  const partes = [r.internet, r.tv].filter(Boolean) as { plan: string | null }[];
                  if (!partes.length) return <span className="text-text-tertiary">—</span>;
                  return (
                    <div className="flex flex-col leading-tight">
                      {r.internet?.plan && (
                        <span className="flex items-center gap-1 font-semibold text-text-primary">
                          <Icon name="wifi" size={12} className="shrink-0 text-brand" />
                          {r.internet.plan}
                        </span>
                      )}
                      {r.tv?.plan && (
                        <span className="flex items-center gap-1 text-[11px] text-text-secondary">
                          <Icon name="tv" size={11} className="shrink-0 text-text-tertiary" />
                          {r.tv.plan}
                        </span>
                      )}
                    </div>
                  );
                },
              },
              { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={SUB_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "—"} tone={SUB_STATUS_TONE[r.status ?? ""] ?? "default"} /> },
              { key: "go", header: "", align: "right", render: (r) => <Link href={`/clientes/${r.id}`} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">Ver ficha →</Link> },
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
    </>
  );
}
