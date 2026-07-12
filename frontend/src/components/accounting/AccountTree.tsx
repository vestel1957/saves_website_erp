import type { AccountNode, AccountType } from "@/lib/accounting-types";

const typeStyles: Record<AccountType, { label: string; cls: string }> = {
  ASSET: { label: "Activo", cls: "bg-success-soft text-success-text" },
  LIABILITY: { label: "Pasivo", cls: "bg-error-soft text-error-text" },
  EQUITY: { label: "Patrimonio", cls: "bg-ai-soft text-ai" },
  INCOME: { label: "Ingreso", cls: "bg-success-soft text-success-text" },
  COST: { label: "Costo", cls: "bg-surface-2 text-text-secondary" },
  EXPENSE: { label: "Gasto", cls: "bg-error-soft text-error-text" },
};

function Row({ node, depth }: { node: AccountNode; depth: number }) {
  const t = typeStyles[node.type];
  return (
    <>
      <div
        className="flex items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0 hover:bg-surface-2"
        style={{ paddingLeft: 16 + depth * 22 }}
      >
        <span className="w-16 shrink-0 font-mono text-[12px] font-semibold text-text-tertiary">
          {node.code}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${node.isPostable ? "text-text-primary" : "font-semibold text-text-primary"}`}
        >
          {node.name}
        </span>
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${t.cls}`}>
          {t.label}
        </span>
        <span className="hidden w-20 shrink-0 text-right text-[10px] font-medium text-text-tertiary sm:block">
          {node.isPostable ? "Imputable" : "Mayor"}
        </span>
      </div>
      {node.children.map((c) => (
        <Row key={c.id} node={c} depth={depth + 1} />
      ))}
    </>
  );
}

export function AccountTree({ nodes }: { nodes: AccountNode[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      {nodes.map((n) => (
        <Row key={n.id} node={n} depth={0} />
      ))}
    </div>
  );
}
