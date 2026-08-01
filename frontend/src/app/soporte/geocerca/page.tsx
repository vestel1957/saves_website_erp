"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { mensajeDeError } from "@/lib/errores";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { type Column } from "@/components/ui/DataTable";
import { PagedTable } from "@/components/ui/PagedTable";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { formatearDistancia } from "@/lib/geo";
import { fmtDate } from "@/lib/format";

type Caso = {
  id: string;
  code: number | null;
  type: string | null;
  tecnico: string | null;
  fecha: string | null;
  distanciaM: number | null;
  precisionM: number | null;
  justificacion: string | null;
  senales: string[];
  cierre: { lat: number; lng: number } | null;
  cliente: { id: string; abonado: number; nombre: string | null; punto: { lat: number; lng: number } | null } | null;
};

type Informe = {
  dias: number;
  modo: "off" | "observar" | "exigir";
  radioM: number;
  resumen: { fuera: number; dentro: number; sinDato: number; sospechosos: number };
  casos: Caso[];
  sospechosos: {
    id: string; code: number | null; type: string | null; tecnico: string | null;
    fecha: string | null; senales: string[]; dentroDeRango: boolean | null;
    cliente: { id: string; abonado: number; nombre: string | null } | null;
  }[];
};

/** Qué significa cada señal, en cristiano. Ninguna prueba nada por sí sola. */
const SENAL: Record<string, string> = {
  "precision-perfecta": "Precisión demasiado buena para un GPS real",
  "punto-repetido": "Coordenada calcada a otra anterior",
  "salto-imposible": "Se habría movido a una velocidad imposible",
  "desde-la-oficina": "Cerró desde el wifi de la oficina",
  "foto-en-otro-sitio": "La foto de evidencia se tomó lejos",
};

function Senales({ lista }: { lista: string[] }) {
  if (!lista?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {lista.map((s) => (
        <span
          key={s}
          title={SENAL[s] ?? s}
          className="inline-flex items-center gap-1 rounded-md bg-error-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-error-text"
        >
          <Icon name="alert-triangle" size={10} /> {SENAL[s] ?? s}
        </span>
      ))}
    </div>
  );
}

const MODO_TEXTO: Record<Informe["modo"], { label: string; tone: "warning" | "success" | "default"; ayuda: string }> = {
  observar: {
    label: "Observando",
    tone: "warning",
    ayuda:
      "La cerca NO bloquea todavía: solo registra. Estos son los cierres que se habrían frenado. Cuando el número te parezca razonable, pásala a Exigir.",
  },
  exigir: {
    label: "Exigiendo",
    tone: "success",
    ayuda:
      "La cerca bloquea. Estos cierres se hicieron fuera de rango justificando el motivo.",
  },
  off: {
    label: "Desactivada",
    tone: "default",
    ayuda: "La cerca está apagada; no se comprueba nada al cerrar órdenes.",
  },
};

type IpVista = {
  ip: string;
  escrituras: number;
  usuarios: string[];
  ultima: string;
  esOficina: boolean;
};

/**
 * Marcar qué IPs son de la oficina.
 *
 * Nadie sabe de memoria la IP pública de su oficina, y menos si es dinámica. En
 * vez de pedir un dato que hay que ir a buscar, se enseña lo que el sistema ya
 * registró en la auditoría y se marca con un clic.
 */
function PanelIps() {
  const { authFetch } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [marcadas, setMarcadas] = useState<Set<string> | null>(null);

  const ips = useRequest<{ ips: IpVista[]; configuradas: string[] }>(
    () => "/support/known-ips?dias=365",
    [],
    { saltar: !abierto },
  );

  // Sincroniza la selección la primera vez que llegan los datos.
  const lista = ips.data?.ips ?? [];
  const sel = marcadas ?? new Set(ips.data?.configuradas ?? []);

  const alternar = (ip: string) => {
    const s = new Set(sel);
    if (s.has(ip)) s.delete(ip);
    else s.add(ip);
    setMarcadas(s);
  };

  const guardar = async () => {
    setGuardando(true);
    try {
      const res = await authFetch("/support/office-ips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ips: [...sel] }),
      });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      toast(`${sel.size} IP(s) marcadas como oficina`, "check");
      ips.refrescar();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudieron guardar"), "alert-circle");
    } finally {
      setGuardando(false);
    }
  };

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand hover:underline"
      >
        <Icon name="settings" size={14} /> Marcar las IPs de la oficina
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-text-primary">IPs de la oficina</p>
        <button
          type="button"
          onClick={() => setAbierto(false)}
          className="text-[12px] text-text-tertiary hover:text-text-secondary"
        >
          Cerrar
        </button>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-text-secondary">
        Un técnico que está de verdad en la casa de un cliente sale por datos móviles, no por el
        wifi de la oficina. Marcando aquí las conexiones de tus locales, cerrar una visita desde
        ellas queda señalado. Estas son las IPs desde las que ya se ha trabajado:
      </p>

      {ips.cargando && <p className="text-[12px] text-text-tertiary">Cargando…</p>}

      <div className="space-y-1.5">
        {lista.map((i) => (
          <label
            key={i.ip}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border-subtle px-3 py-2 hover:bg-surface-2"
          >
            <input
              type="checkbox"
              checked={sel.has(i.ip)}
              onChange={() => alternar(i.ip)}
              className="h-4 w-4 accent-[var(--color-brand)]"
            />
            <span className="font-mono text-[12.5px] font-semibold text-text-primary">{i.ip}</span>
            <span className="text-[11.5px] text-text-tertiary">
              {i.escrituras} escritura{i.escrituras === 1 ? "" : "s"}
              {i.usuarios.length > 0 && ` · ${i.usuarios.slice(0, 3).join(", ")}`}
            </span>
            <span className="ml-auto text-[11px] text-text-tertiary">{fmtDate(i.ultima)}</span>
          </label>
        ))}
        {!ips.cargando && lista.length === 0 && (
          <p className="text-[12px] text-text-tertiary">
            Todavía no hay escrituras con IP pública registrada.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11.5px] leading-snug text-text-tertiary">
          Ojo: como Vestel <em>es</em> el proveedor, tus clientes también salen por rangos tuyos.
          Marca solo las IPs exactas de tus locales, nunca un rango entero.
        </p>
        <Button size="sm" onClick={() => void guardar()} disabled={guardando}>
          {guardando ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  );
}

export default function GeocercaPage() {
  const { loading: authLoading } = useAuth();
  const [dias, setDias] = useState("30");

  const inf = useRequest<Informe>(() => `/support/geofence-report?dias=${dias}`, [dias], {
    saltar: authLoading,
  });

  if (authLoading || (inf.cargando && !inf.data)) return <PageSkeleton />;
  if (inf.error) return <LoadError message={inf.error} onRetry={inf.refrescar} />;
  if (!inf.data) return null;

  const d = inf.data;
  const modo = MODO_TEXTO[d.modo];
  const comprobados = d.resumen.fuera + d.resumen.dentro;
  const pctFuera = comprobados ? Math.round((100 * d.resumen.fuera) / comprobados) : 0;

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="map-pin"
          title="Geo-cerca de cierres"
          subtitle="Órdenes de campo cerradas lejos del domicilio del cliente"
        />
        <div className="flex items-center gap-2">
          <Badge tone={modo.tone} label={modo.label} />
          <Select value={dias} onChange={(e) => setDias(e.target.value)} className="w-auto">
            <option value="7">7 días</option>
            <option value="30">30 días</option>
            <option value="90">90 días</option>
          </Select>
        </div>
      </div>

      <p className="mb-3 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
        {modo.ayuda} Radio actual: <strong>{d.radioM} m</strong> (más el margen de error que reporte
        cada GPS).
      </p>

      <PanelIps />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tarjeta
          titulo="Fuera de rango"
          valor={d.resumen.fuera}
          detalle={comprobados ? `${pctFuera}% de los cierres comprobados` : "sin cierres comprobados"}
          tono="error"
        />
        <Tarjeta titulo="Dentro de rango" valor={d.resumen.dentro} detalle="cierres correctos" tono="success" />
        <Tarjeta
          titulo="Sin comprobar"
          valor={d.resumen.sinDato}
          detalle="órdenes remotas, exentos o clientes sin coordenada"
          tono="neutral"
        />
      </div>

      {d.sospechosos.length > 0 && (
        <div className="mb-4 rounded-xl border border-error bg-error-soft p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-error-text">
            <Icon name="alert-triangle" size={15} /> Ubicaciones que podrían estar simuladas
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
            Estos cierres traen señales que un GPS real no produce. <strong>No prueban nada</strong>:
            son motivos para preguntar, no para acusar. El caso a mirar primero es el que además
            pasó la cerca, porque la habría pasado justamente por el punto falso.
          </p>
          <div className="mt-3 space-y-2">
            {d.sospechosos.map((s) => (
              <div key={s.id} className="rounded-lg bg-surface px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px]">
                  <Link href={`/soporte/${s.id}`} className="font-semibold text-brand hover:underline">
                    #{s.code ?? "—"}
                  </Link>
                  <span className="text-text-secondary">{s.type ?? "—"}</span>
                  <span className="text-text-primary">{s.tecnico ?? "sin técnico"}</span>
                  {s.cliente && (
                    <Link href={`/clientes/${s.cliente.id}`} className="text-text-tertiary hover:underline">
                      {s.cliente.nombre ?? `#${s.cliente.abonado}`}
                    </Link>
                  )}
                  {s.dentroDeRango === true && (
                    <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10.5px] font-bold text-warning-text">
                      pasó la cerca
                    </span>
                  )}
                  <span className="ml-auto text-[11.5px] text-text-tertiary">
                    {s.fecha ? fmtDate(s.fecha) : "—"}
                  </span>
                </div>
                <Senales lista={s.senales} />
              </div>
            ))}
          </div>
        </div>
      )}

      {d.casos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center">
          <Icon name="check" size={22} className="text-success-text" />
          <p className="mt-2 text-[13px] text-text-secondary">
            Ningún cierre fuera de rango en este periodo.
          </p>
        </div>
      ) : (
        <PagedTable
          columns={[
            {
              key: "orden", header: "Orden",
              render: (c) => (
                <Link href={`/soporte/${c.id}`} className="font-semibold text-brand hover:underline">
                  #{c.code ?? "—"}
                </Link>
              ),
            },
            { key: "tipo", header: "Tipo", render: (c) => <span className="text-text-secondary">{c.type ?? "—"}</span> },
            { key: "tecnico", header: "Técnico", render: (c) => c.tecnico ?? "—" },
            {
              key: "cliente", header: "Cliente",
              render: (c) =>
                c.cliente ? (
                  <Link href={`/clientes/${c.cliente.id}`} className="text-text-primary hover:text-brand hover:underline">
                    {c.cliente.nombre ?? `#${c.cliente.abonado}`}
                  </Link>
                ) : (
                  "—"
                ),
            },
            {
              key: "distancia", header: "Distancia", align: "right",
              render: (c) => (
                <>
                  <span className="font-bold text-error-text">
                    {c.distanciaM != null ? formatearDistancia(Math.round(c.distanciaM)) : "—"}
                  </span>
                  {/* La precisión es la diferencia entre "hizo trampa" y "el GPS
                      no agarraba". Sin ella la distancia sola acusa a ciegas. */}
                  {c.precisionM != null && (
                    <span className="block text-[11px] text-text-tertiary">
                      GPS ±{Math.round(c.precisionM)} m
                    </span>
                  )}
                </>
              ),
            },
            {
              key: "motivo", header: "Motivo dado",
              render: (c) => (
                <div className="max-w-[260px] text-text-secondary">
                  {c.justificacion ?? (
                    <span className="text-text-tertiary">— (no se pidió: modo observación)</span>
                  )}
                  <Senales lista={c.senales} />
                </div>
              ),
            },
            { key: "fecha", header: "Fecha", render: (c) => <span className="text-text-tertiary">{c.fecha ? fmtDate(c.fecha) : "—"}</span> },
          ] satisfies Column<Caso>[]}
          rows={d.casos}
        />
      )}
    </>
  );
}

function Tarjeta({
  titulo,
  valor,
  detalle,
  tono,
}: {
  titulo: string;
  valor: number;
  detalle: string;
  tono: "error" | "success" | "neutral";
}) {
  const color =
    tono === "error" ? "text-error-text" : tono === "success" ? "text-success-text" : "text-text-primary";
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <p className="text-[12px] text-text-tertiary">{titulo}</p>
      <p className={`text-[24px] font-bold leading-tight ${color}`}>{valor.toLocaleString("es-CO")}</p>
      <p className="text-[11.5px] text-text-tertiary">{detalle}</p>
    </div>
  );
}
