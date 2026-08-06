"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { SUB_STATUS_LABEL } from "@/lib/subscribers";
import {
  type PromotionAudience, type PromotionCatalogs, type PromotionSubscriber,
  EMPTY_AUDIENCE,
} from "@/lib/promotions";

const STATUS_KEYS = Object.keys(SUB_STATUS_LABEL);

type Opcion = { value: string; label: string; sub?: string };

/** Cuántas opciones caben a la vista antes de necesitar buscador. */
const TOPE_FICHAS = 8;

/**
 * Cierra un desplegable al pulsar fuera de él.
 *
 * Escucha en FASE DE CAPTURA a propósito. El diálogo corta la propagación del
 * `mousedown` en su panel (Modal.tsx) para que un clic dentro no lo cierre, y eso
 * dejaba sin efecto cualquier detector de «clic afuera» montado en `document`: los
 * buscadores se abrían y ya no había forma de cerrarlos sin elegir algo. En captura
 * el evento se ve bajando, antes de que nadie pueda pararlo.
 */
function useCerrarAlPulsarFuera(activo: boolean, onFuera: () => void) {
  const caja = useRef<HTMLDivElement>(null);
  // En una ref para que el efecto dependa solo de `activo`: si dependiera de la
  // función, que se recrea en cada render, se re-suscribiría en cada tecla.
  const cb = useRef(onFuera);
  cb.current = onFuera;

  useEffect(() => {
    if (!activo) return;
    const onDoc = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [activo]);
  return caja;
}

/** Lo ya elegido, con su botón para soltarlo y volver a buscar. */
function Elegido({ label, onQuitar }: { label: React.ReactNode; onQuitar: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-brand bg-brand-soft px-3 py-2">
      <Icon name="check" size={14} className="shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-brand">{label}</span>
      <button type="button" onClick={onQuitar}
        className="tap shrink-0 rounded-md p-1 text-brand hover:bg-brand/15" aria-label="Cambiar">
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/**
 * Opciones a la vista, de las que se elige UNA. Solo para catálogos cortos
 * (estados, sedes): ahí un buscador estorba — lo que hace falta es ver todas las
 * alternativas sin abrir nada.
 */
function Opciones({
  opciones, valor, onChange,
}: {
  opciones: Opcion[];
  valor: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {opciones.map((o) => {
        const activo = o.value === valor;
        return (
          <button key={o.value} type="button" aria-pressed={activo}
            onClick={() => onChange(activo ? null : o.value)}
            className={`tap rounded-full border px-3 py-1 text-[12px] transition-colors ${
              activo
                ? "border-brand bg-brand-soft font-semibold text-brand"
                : "border-border-subtle bg-surface text-text-secondary hover:border-brand hover:text-brand"
            }`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Buscador de UNA opción para catálogos largos (72 planes, 493 barrios): se escribe,
 * se elige y el desplegable se cierra dejando a la vista lo elegido.
 */
function BuscadorOpcion({
  opciones, valor, onChange, placeholder,
}: {
  opciones: Opcion[];
  valor: string | null;
  onChange: (v: string | null) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const caja = useCerrarAlPulsarFuera(open, () => setOpen(false));

  const porValor = useMemo(() => new Map(opciones.map((o) => [o.value, o])), [opciones]);
  const filtradas = useMemo(() => {
    const term = q.trim().toLowerCase();
    return opciones
      .filter((o) => !term || `${o.label} ${o.sub ?? ""}`.toLowerCase().includes(term))
      .slice(0, 50);
  }, [opciones, q]);

  if (valor) {
    return <Elegido label={porValor.get(valor)?.label ?? valor} onQuitar={() => { onChange(null); setQ(""); }} />;
  }

  return (
    // `data-buscador`: el asistente usa Enter para pasar de paso y aquí dentro esa
    // tecla es del propio desplegable, no del formulario.
    <div ref={caja} data-buscador className="relative">
      <Input value={q} placeholder={placeholder} onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (
        <div className="absolute z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-border-default bg-surface shadow-lg">
          {filtradas.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-text-tertiary">Sin coincidencias.</div>
          ) : filtradas.map((o) => (
            <button key={o.value} type="button"
              onClick={() => { onChange(o.value); setQ(""); setOpen(false); }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2">
              <span className="truncate text-text-primary">{o.label}</span>
              {o.sub && <span className="shrink-0 text-[11px] text-text-tertiary">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Buscador de UN cliente contra el servidor. */
function BuscadorCliente({
  valor, nombres, onChange,
}: {
  valor: string | null;
  nombres: Map<string, PromotionSubscriber>;
  onChange: (id: string | null, nuevo?: PromotionSubscriber) => void;
}) {
  const { authFetch } = useAuth();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PromotionSubscriber[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const caja = useCerrarAlPulsarFuera(open, () => setOpen(false));

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setItems([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await authFetch(`/subscribers?search=${encodeURIComponent(term)}&pageSize=8`);
        const d = await r.json();
        setItems((d.items ?? []).map((x: any) => ({
          id: x.id, fullName: x.name ?? x.fullName ?? null, abonado: x.abonado, status: x.status ?? null,
        })));
        setOpen(true);
      } finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, authFetch]);

  if (valor) {
    const s = nombres.get(valor);
    return (
      <Elegido
        label={<>{s?.fullName?.trim() || "Cliente"} <span className="font-mono opacity-70">#{s?.abonado ?? "—"}</span></>}
        onQuitar={() => { onChange(null); setQ(""); }}
      />
    );
  }

  return (
    <div ref={caja} data-buscador className="relative">
      <div className="relative">
        <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <Input className="pl-9" value={q} placeholder="Buscar por nombre, documento o abonado…"
          onFocus={() => items.length && setOpen(true)} onChange={(e) => setQ(e.target.value)} />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-border-default bg-surface shadow-lg">
          {loading && <div className="px-3 py-2 text-[12px] text-text-tertiary">Buscando…</div>}
          {!loading && items.length === 0 && <div className="px-3 py-2 text-[12px] text-text-tertiary">Sin resultados.</div>}
          {items.map((s) => (
            <button key={s.id} type="button"
              onClick={() => { onChange(s.id, s); setQ(""); setOpen(false); }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2">
              <span className="truncate text-text-primary">{s.fullName || "Sin nombre"}</span>
              <span className="shrink-0 font-mono text-[11px] text-text-tertiary">#{s.abonado}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Las cinco dimensiones por las que se puede acotar el público. */
type CriterioKey = "estado" | "plan" | "sede" | "barrio" | "cliente";

const CRITERIOS: { key: CriterioKey; label: string; campo: keyof PromotionAudience }[] = [
  { key: "estado", label: "Por estado del cliente", campo: "subscriberStatuses" },
  { key: "plan", label: "Por plan contratado", campo: "planIds" },
  { key: "sede", label: "Por sede", campo: "branchIds" },
  { key: "barrio", label: "Por barrio", campo: "neighborhoodRefs" },
  { key: "cliente", label: "Un cliente en concreto", campo: "subscriberIds" },
];

const campoDe = (k: CriterioKey) => CRITERIOS.find((c) => c.key === k)!.campo;

/** Botón grande de modo: todos los clientes o solo algunos. */
function Modo({
  activo, onClick, title, detail,
}: {
  activo: boolean; onClick: () => void; title: string; detail: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={activo}
      className={`tap rounded-xl border p-3 text-left transition-colors ${
        activo ? "border-brand bg-brand-soft" : "border-border-subtle bg-surface-2 hover:border-brand"
      }`}>
      <span className="block text-[13px] font-semibold text-text-primary">{title}</span>
      <span className="block text-[11.5px] text-text-tertiary">{detail}</span>
    </button>
  );
}

/**
 * Paso «¿a qué clientes les llega?» del asistente de promociones.
 *
 * UNA sola elección: o todos los clientes, o un grupo (un estado, un plan, una sede,
 * un barrio), o un cliente en concreto. Se escoge el criterio en el desplegable y
 * debajo se marca la opción; elegir otra reemplaza a la anterior. Nada de cruzar
 * criterios ni de acumular fichas.
 *
 * El conteo de alcanzados NO se pinta aquí: lo muestra el asistente en su línea de
 * pie, que es la misma en los tres pasos.
 */
export function PasoPublico({
  value, onChange, catalogs, nombres, onNombre,
}: {
  value: PromotionAudience;
  onChange: (next: PromotionAudience) => void;
  catalogs: PromotionCatalogs | null;
  nombres: Map<string, PromotionSubscriber>;
  onNombre: (s: PromotionSubscriber) => void;
}) {
  // Qué criterio se está usando: el que traiga algo elegido, o «estado» por defecto.
  const [criterio, setCriterio] = useState<CriterioKey>(
    () => CRITERIOS.find((c) => (value[c.campo] as string[]).length > 0)?.key ?? "estado",
  );

  const elegido = (value[campoDe(criterio)] as string[])[0] ?? null;

  /** Guardar deja SIEMPRE un único campo con un único valor: el resto se limpia. */
  function elegir(v: string | null) {
    onChange({ ...EMPTY_AUDIENCE, ...(v ? { [campoDe(criterio)]: [v] } : {}) });
  }

  function cambiarCriterio(k: CriterioKey) {
    setCriterio(k);
    onChange({ ...EMPTY_AUDIENCE });
  }

  const opciones: Record<CriterioKey, Opcion[]> = {
    estado: STATUS_KEYS.map((k) => ({ value: k, label: SUB_STATUS_LABEL[k] })),
    plan: (catalogs?.plans ?? []).map((p) => ({ value: p.id, label: p.name, sub: p.kind === "TV" ? "TV" : "Internet" })),
    sede: (catalogs?.branches ?? []).map((b) => ({ value: b.id, label: b.name })),
    barrio: (catalogs?.neighborhoods ?? []).map((n) => ({ value: n.ref, label: n.name })),
    cliente: [],
  };

  const todos = value.allSubscribers;
  const opts = opciones[criterio];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Modo
          activo={todos}
          onClick={() => onChange({ ...EMPTY_AUDIENCE, allSubscribers: true })}
          title="Todos"
          detail="Sin excepciones"
        />
        <Modo
          activo={!todos}
          onClick={() => onChange({ ...EMPTY_AUDIENCE })}
          title="Solo algunos"
          detail="Un grupo o un cliente"
        />
      </div>

      {!todos && (
        <div className="flex flex-col gap-2">
          <Select aria-label="Criterio" value={criterio}
            onChange={(e) => cambiarCriterio(e.target.value as CriterioKey)}>
            {CRITERIOS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>

          {criterio === "cliente" ? (
            <BuscadorCliente valor={elegido} nombres={nombres}
              onChange={(id, nuevo) => { if (nuevo) onNombre(nuevo); elegir(id); }} />
          ) : opts.length <= TOPE_FICHAS ? (
            <Opciones opciones={opts} valor={elegido} onChange={elegir} />
          ) : (
            <BuscadorOpcion opciones={opts} valor={elegido} onChange={elegir}
              placeholder={`Buscar ${CRITERIOS.find((c) => c.key === criterio)!.label.replace(/^Por /, "").toLowerCase()}…`} />
          )}
        </div>
      )}
    </div>
  );
}
