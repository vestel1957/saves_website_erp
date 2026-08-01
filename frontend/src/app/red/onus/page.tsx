"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/context/AuthProvider";
import { VincularClienteModal } from "@/components/network/VincularClienteModal";
import { rxTone, runTone } from "@/lib/olt";
import type { InvOnu, OltRow, OltMode, Paged } from "@/lib/olt";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";

export default function InventarioOnusPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [olts, setOlts] = useState<OltRow[]>([]);
  const [mode, setMode] = useState<OltMode | null>(null);
  const [search, setSearch] = useState("");
  const [oltId, setOltId] = useState("");
  const [estado, setEstado] = useState("");
  const [senal, setSenal] = useState("");
  const [cliente, setCliente] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [link, setLink] = useState<InvOnu | null>(null);
  // Confirmación de acción destructiva sobre una ONU del inventario.
  const [confirmar, setConfirmar] = useState<{ action: "reboot" | "delete"; onu: InvOnu } | null>(null);
  const [ejecutando, setEjecutando] = useState(false);
  const [vinculando, setVinculando] = useState(false);

  const live = !!mode?.live;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/olt/olts").then((r) => r.json()).then(setOlts).catch(() => {});
    void authFetch("/network/olt/mode").then((r) => r.json()).then(setMode).catch(() => {});
  }, [authLoading, authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo, para que
  // una respuesta lenta no pise a otra más nueva. Ver lib/useRequest.
  // El inventario pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<Paged<InvOnu>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (oltId) qs.set("oltId", oltId);
      if (estado) qs.set("estado", estado);
      if (senal) qs.set("senal", senal);
      if (cliente) qs.set("cliente", cliente);
      return `/network/olt/inventory?${qs}`;
    },
    [page, pageSize, search, oltId, estado, senal, cliente, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [search, oltId, estado, senal, cliente, pageSize, orden.clave]);

  const onuAction = async (action: "reboot" | "delete", o: InvOnu) => {
    if (!o.oltId) return;
    setEjecutando(true);
    try {
      const r = await authFetch(`/network/olt/${o.oltId}/onu/${action}`, {
        method: "POST", body: JSON.stringify({ frame: o.frame ?? 0, slot: o.slot, port: o.port, ont_id: o.ontId, sn: o.sn }),
      }).then((x) => x.json());
      if (r.ok) toast(r.dryRun ? "Plan generado (dry-run)" : (r.message || "OK"), "check");
      else toast(r.error || "Error", "x");
    } finally { setEjecutando(false); setConfirmar(null); }
  };

  // Auto-vínculo masivo: casa la descripción de la OLT (usuario/abonado) contra
  // la BD y vincula solo los matches únicos. Los vínculos existentes no se tocan.
  const autoLink = async () => {
    setVinculando(true);
    try {
      const r = await authFetch("/network/olt/auto-link", {
        method: "POST", body: JSON.stringify({ oltId: oltId || undefined }),
      }).then((x) => x.json());
      if (r.ok) {
        toast(`Auto-vínculo: ${r.vinculadas} vinculadas · ${r.ambiguas} ambiguas · ${r.sinMatch} sin match (de ${r.examinadas} con descripción)`, "check");
        load();
      } else {
        toast(r.message || "No se pudo auto-vincular", "x");
      }
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setVinculando(false);
    }
  };

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="wand-sparkles" title="Inventario de ONUs" />
        <div className="flex items-center gap-2">
          {mode && <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} />}
          <Button variant="secondary" disabled={vinculando} onClick={autoLink} title="Vincula ONUs a abonados casando la descripción de la OLT (usuario o número de abonado) contra la base; solo aplica matches únicos">
            {vinculando ? <Icon name="loader" size={15} className="mr-1 animate-spin" /> : <Icon name="link" size={15} className="mr-1" />}
            Auto-vincular
          </Button>
          <Link href="/red/olt"><Button variant="secondary"><Icon name="router" size={15} className="mr-1" />Gestión OLT</Button></Link>
        </div>
      </div>

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por serial (SN), cliente o descripción…">
        <Select value={oltId} onChange={(e) => setOltId(e.target.value)} className="w-auto">
          <option value="">Todas las OLTs</option>
          {olts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto">
          <option value="">Todo estado</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </Select>
        <Select value={senal} onChange={(e) => setSenal(e.target.value)} className="w-auto">
          <option value="">Toda señal</option>
          <option value="debil">Señal débil (-25..-28)</option>
          <option value="critica">Señal crítica (&lt;-28)</option>
        </Select>
        <Select value={cliente} onChange={(e) => setCliente(e.target.value)} className="w-auto">
          <option value="">Todos</option>
          <option value="con">Con cliente</option>
          <option value="sin">Sin cliente</option>
        </Select>
      </ListToolbar>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable rows={data?.items ?? []} empty="No se encontraron ONUs." sort={orden.sort} onSort={orden.onSort} columns={[
            { key: "sn", header: "Serial (SN)", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.sn ?? "—"}</span> },
            { key: "olt", header: "OLT", sortable: true, render: (r) => r.olt ?? "—" },
            { key: "pos", header: "F/S/P (ONT)", sortable: true, render: (r) => <span className="font-mono text-text-tertiary">{r.fsp} ({r.ontId ?? "-"})</span> },
            { key: "client", header: "Cliente", sortable: true, render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span className="text-text-tertiary">sin cliente</span> },
            { key: "rx", header: "RX (dBm)", sortable: true, render: (r) => <Badge label={r.rxPower ?? "—"} tone={rxTone(r.rxPower)} /> },
            { key: "run", header: "Estado", sortable: true, render: (r) => <Badge label={r.runState ?? "—"} tone={runTone(r.runState)} /> },
            { key: "sync", header: "Sync", sortable: true, render: (r) => <Badge label={r.syncState} tone={r.syncState === "presente" ? "success" : "warning"} /> },
            { key: "acc", header: "Acciones", render: (r) => (
              <div className="flex gap-1">
                <button title="Vincular cliente" onClick={() => setLink(r)} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="user" size={15} /></button>
                <button title="Reiniciar" onClick={() => setConfirmar({ action: "reboot", onu: r })} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-warning-text"><Icon name="rotate-cw" size={15} /></button>
                <button title="Eliminar" onClick={() => setConfirmar({ action: "delete", onu: r })} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="trash" size={15} /></button>
              </div>
            ) },
          ]} />
          {data && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </>
      )}

      {link && (
        <VincularClienteModal open onClose={() => setLink(null)} onuId={link.id} sn={link.sn}
          currentClient={link.client} currentSubscriberId={link.subscriberId}
          onDone={load} />
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={ejecutando}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void onuAction(confirmar.action, confirmar.onu)}
          tone={confirmar.action === "delete" ? "danger" : "primary"}
          icon={confirmar.action === "delete" ? "trash" : "rotate-cw"}
          title={confirmar.action === "delete" ? "Eliminar ONU de la OLT" : "Reiniciar ONU"}
          confirmLabel={confirmar.action === "delete" ? "Eliminar de la OLT" : "Reiniciar ahora"}
          // Solo en LIVE se exige teclear el serial: en dry-run no se toca el equipo.
          requireText={live && confirmar.action === "delete" ? (confirmar.onu.sn ?? undefined) : undefined}
          requireHint={<>Para confirmar, escriba el serial <span className="font-mono font-semibold text-text-primary">{confirmar.onu.sn}</span></>}
          message={
            confirmar.action === "delete" ? (
              <>
                Se borrará la ONU de la configuración de la OLT{confirmar.onu.olt ? <> <b>{confirmar.onu.olt}</b></> : null}.{" "}
                {live
                  ? <b className="text-error-text">{confirmar.onu.client ? `${confirmar.onu.client} quedará sin servicio de inmediato.` : "El abonado quedará sin servicio de inmediato."}</b>
                  : <>Está en <b>dry-run</b>: solo se generará el plan de comandos, no se toca el equipo.</>}
              </>
            ) : (
              <>
                La ONU se reiniciará y {confirmar.onu.client ? <b>{confirmar.onu.client}</b> : "el abonado"} perderá la conexión durante uno o dos minutos.{" "}
                {!live && <>Está en <b>dry-run</b>: no se toca el equipo.</>}
              </>
            )
          }
          detail={<OnuResumen onu={confirmar.onu} />}
        />
      )}
    </>
  );
}

/**
 * Ficha compacta de la ONU dentro de la confirmación: el inventario mezcla ONUs
 * de varias OLTs, así que se muestra también el abonado para que el operador
 * confirme a quién le va a tocar el servicio.
 */
function OnuResumen({ onu }: { onu: InvOnu }) {
  const filas: [string, React.ReactNode][] = [
    ["Serial", <span key="a" className="font-mono">{onu.sn ?? "—"}</span>],
    ["OLT", <span key="b">{onu.olt ?? "—"}</span>],
    ["F/S/P (ONT)", <span key="c" className="font-mono">{onu.fsp} ({onu.ontId ?? "-"})</span>],
    ["Abonado", onu.client ? <span key="d">{onu.client}</span> : <span key="d" className="text-text-tertiary">sin cliente</span>],
    ["Estado", <Badge key="e" label={onu.runState ?? "—"} tone={runTone(onu.runState)} />],
    ["Señal", <Badge key="f" label={onu.rxPower ? `${onu.rxPower} dBm` : "—"} tone={rxTone(onu.rxPower)} />],
  ];
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
