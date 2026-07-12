"use client";

import { useMemo, useState } from "react";
import { Icon } from "../Icon";
import { AccountTree } from "./AccountTree";
import type { AccountNode, AccountType } from "@/lib/accounting-types";

/* Metadatos por clase contable — pensados para que alguien sin formación
   contable entienda de un vistazo qué significa cada grupo. */
const TYPE_META: Record<
  AccountType,
  { label: string; icon: string; desc: string; iconWrap: string; chip: string }
> = {
  ASSET: {
    label: "Activos",
    icon: "wallet",
    desc: "Lo que la empresa tiene: caja, bancos, cartera e inventario.",
    iconWrap: "bg-success-soft text-success-text",
    chip: "bg-success-soft text-success-text",
  },
  LIABILITY: {
    label: "Pasivos",
    icon: "hand-coins",
    desc: "Lo que la empresa debe: proveedores, impuestos y créditos.",
    iconWrap: "bg-error-soft text-error-text",
    chip: "bg-error-soft text-error-text",
  },
  EQUITY: {
    label: "Patrimonio",
    icon: "scale",
    desc: "El capital propio: aportes de los socios y resultados.",
    iconWrap: "bg-info-soft text-info-text",
    chip: "bg-info-soft text-info-text",
  },
  INCOME: {
    label: "Ingresos",
    icon: "trending-up",
    desc: "El dinero que entra por ventas y operación.",
    iconWrap: "bg-brand-soft text-brand",
    chip: "bg-brand-soft text-brand",
  },
  COST: {
    label: "Costos",
    icon: "package",
    desc: "El costo directo de lo que se vende.",
    iconWrap: "bg-surface-2 text-text-secondary",
    chip: "bg-surface-2 text-text-secondary",
  },
  EXPENSE: {
    label: "Gastos",
    icon: "receipt",
    desc: "Los gastos para operar: servicios y administración.",
    iconWrap: "bg-warning-soft text-warning-text",
    chip: "bg-warning-soft text-warning-text",
  },
};

const norm = (s: string) => s.toLowerCase().trim();

function nodeMatches(n: AccountNode, q: string) {
  return norm(n.code).includes(q) || norm(n.name).includes(q);
}

/** Filtra el árbol conservando ramas que coincidan o que tengan hijos que coincidan. */
function filterTree(nodes: AccountNode[], q: string): AccountNode[] {
  if (!q) return nodes;
  const out: AccountNode[] = [];
  for (const n of nodes) {
    const kids = filterTree(n.children, q);
    if (nodeMatches(n, q) || kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

/** Cuenta cuántas cuentas imputables (donde se registra) cuelgan de un nodo. */
function countPostable(n: AccountNode): number {
  if (n.isPostable) return 1;
  return n.children.reduce((acc, c) => acc + countPostable(c), 0);
}

function collectParentIds(nodes: AccountNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) {
      acc.push(n.id);
      collectParentIds(n.children, acc);
    }
  }
  return acc;
}

/* ---- fila recursiva dentro de una categoría ---- */
function NodeRow({
  node,
  depth,
  isOpen,
  toggle,
}: {
  node: AccountNode;
  depth: number;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const open = isOpen(node.id);
  const pad = 12 + depth * 18;

  if (hasChildren) {
    // Cuenta MAYOR — agrupa, no recibe movimientos.
    return (
      <>
        <button
          onClick={() => toggle(node.id)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
          style={{ paddingLeft: pad }}
        >
          <Icon
            name="chevron-right"
            size={14}
            className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
          />
          <Icon name="folder" size={15} className="shrink-0 text-text-tertiary" />
          <span className="w-14 shrink-0 font-mono text-[12px] font-semibold text-text-tertiary">
            {node.code}
          </span>
          <span className="flex-1 text-[13px] font-semibold text-text-primary">{node.name}</span>
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
            {countPostable(node)} cta{countPostable(node) === 1 ? "" : "s"}
          </span>
        </button>
        {open &&
          node.children.map((c) => (
            <NodeRow key={c.id} node={c} depth={depth + 1} isOpen={isOpen} toggle={toggle} />
          ))}
      </>
    );
  }

  // Cuenta IMPUTABLE — aquí sí se registran los movimientos.
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-2"
      style={{ paddingLeft: pad + 20 }}
    >
      <Icon name="file-text" size={15} className="shrink-0 text-text-tertiary" />
      <span className="w-14 shrink-0 font-mono text-[12px] font-semibold text-text-primary">
        {node.code}
      </span>
      <span className="flex-1 text-[13px] text-text-primary">{node.name}</span>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
          node.normalSide === "DEBIT"
            ? "bg-info-soft text-info-text"
            : "bg-warning-soft text-warning-text"
        }`}
        title="Naturaleza de la cuenta"
      >
        {node.normalSide === "DEBIT" ? "Débito" : "Crédito"}
      </span>
      <span className="hidden shrink-0 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand sm:inline">
        Imputable
      </span>
    </div>
  );
}

/* ---- tarjeta por clase contable ---- */
function CategoryCard({
  node,
  isOpen,
  toggle,
}: {
  node: AccountNode;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
}) {
  const meta = TYPE_META[node.type];
  const open = isOpen(node.id);

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      <button
        onClick={() => toggle(node.id)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
      >
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${meta.iconWrap}`}
        >
          <Icon name={meta.icon} size={20} />
        </span>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-text-tertiary">
              {node.code}
            </span>
            <span className="text-[15px] font-bold text-text-primary">{meta.label}</span>
          </div>
          <span className="truncate text-[12px] text-text-tertiary">{meta.desc}</span>
        </div>
        <span className="ml-auto shrink-0 text-right">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.chip}`}>
            {countPostable(node)} cuentas
          </span>
        </span>
        <Icon
          name="chevron-right"
          size={18}
          className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border-subtle py-1">
          {node.children.map((c) => (
            <NodeRow key={c.id} node={c} depth={0} isOpen={isOpen} toggle={toggle} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AccountChart({ nodes }: { nodes: AccountNode[] }) {
  const [view, setView] = useState<"categorias" | "arbol">("categorias");
  const [query, setQuery] = useState("");
  // Por defecto las 6 categorías abiertas; los grupos internos cerrados.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(nodes.map((n) => n.id)),
  );

  const q = norm(query);
  const filtered = useMemo(() => filterTree(nodes, q), [nodes, q]);

  // Al buscar, todo se muestra desplegado para no esconder coincidencias.
  const isOpen = (id: string) => (q ? true : expanded.has(id));
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allParentIds = useMemo(() => collectParentIds(nodes), [nodes]);
  const expandAll = () => setExpanded(new Set(allParentIds));
  const collapseAll = () => setExpanded(new Set());

  const totalPostable = useMemo(
    () => nodes.reduce((acc, n) => acc + countPostable(n), 0),
    [nodes],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* barra de herramientas */}
      <div className="flex flex-wrap items-center gap-3">
        {/* selector de vista */}
        <div className="flex rounded-lg border border-border-subtle bg-surface p-0.5">
          {(["categorias", "arbol"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                view === v
                  ? "bg-brand text-on-brand"
                  : "text-text-secondary hover:bg-surface-2"
              }`}
            >
              <Icon name={v === "categorias" ? "layers" : "list-tree"} size={14} />
              {v === "categorias" ? "Categorías" : "Árbol"}
            </button>
          ))}
        </div>

        {/* buscador */}
        <div className="flex h-9 w-full min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 sm:w-auto sm:min-w-[220px]">
          <Icon name="search" size={14} className="text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por código o nombre…"
            className="flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Limpiar">
              <Icon name="x" size={14} className="text-text-tertiary hover:text-text-secondary" />
            </button>
          )}
        </div>

        {view === "categorias" && !q && (
          <div className="flex items-center gap-1">
            <button
              onClick={expandAll}
              className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
            >
              Expandir todo
            </button>
            <button
              onClick={collapseAll}
              className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
            >
              Contraer todo
            </button>
          </div>
        )}
      </div>

      {/* contenido */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border-subtle bg-surface px-4 py-10 text-center text-[13px] text-text-tertiary">
          No se encontraron cuentas para “{query}”.
        </div>
      ) : view === "categorias" ? (
        <div className="flex flex-col gap-2.5">
          {filtered.map((n) => (
            <CategoryCard key={n.id} node={n} isOpen={isOpen} toggle={toggle} />
          ))}
        </div>
      ) : (
        <AccountTree nodes={filtered} />
      )}

      {/* leyenda — qué significa cada cosa */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-[11px] text-text-tertiary">
        <span className="font-semibold text-text-secondary">¿Cómo leer esto?</span>
        <span className="flex items-center gap-1.5">
          <Icon name="folder" size={13} /> <strong className="text-text-secondary">Mayor</strong>:
          agrupa cuentas, no recibe movimientos.
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="file-text" size={13} />{" "}
          <strong className="text-text-secondary">Imputable</strong>: aquí sí se registran los
          movimientos.
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-info-soft px-1.5 py-0.5 font-semibold text-info-text">
            Débito
          </span>{" "}
          /{" "}
          <span className="rounded bg-warning-soft px-1.5 py-0.5 font-semibold text-warning-text">
            Crédito
          </span>{" "}
          = naturaleza de la cuenta.
        </span>
        <span className="ml-auto font-medium text-text-secondary">
          {totalPostable} cuentas imputables
        </span>
      </div>
    </div>
  );
}
