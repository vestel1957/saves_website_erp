"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { TabBar } from "@/components/accounting/TabBar";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type TabKey = "datos" | "permisos";

/** Rol legacy del empleado (aauth_users.roleid). Distinto de los roles RBAC. */
const ROLE_LABELS: Record<string, string> = {
  "2": "Cajero",
  "3": "Técnico",
  "4": "Administrativo",
  "5": "Administrador",
};

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");
const fmtDateTime = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—");

function Card({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2.5 flex items-center gap-2 text-[13px] font-bold text-text-primary">
        <Icon name={icon} size={15} className="text-brand" />
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <span className="text-[12px] text-text-tertiary">{label}</span>
      <span className="text-right text-[12px] font-medium text-text-primary">{value ?? "—"}</span>
    </div>
  );
}

function ActivityCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
        <Icon name={icon} size={17} />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
        <span className="text-[18px] font-bold text-text-primary">{value}</span>
      </div>
    </div>
  );
}

type PermItem = { key: string; label: string; inRole: boolean; effect: string | null; effective: boolean };
type PermGroup = { group: string; items: PermItem[] };
type PermAccount = { email: string; name: string; isActive: boolean; createdAt: string; lastLogin: string | null };
type PermData = {
  linked: boolean;
  userId: string | null;
  userActive: boolean | null;
  isSuperadmin: boolean;
  hasEmail: boolean;
  account: PermAccount | null;
  roles: { key: string; name: string }[];
  groups: PermGroup[];
};

// ── Árbol de permisos ───────────────────────────────────────────────────────
// Los permisos son jerárquicos: Sección → Módulo → Permiso. Construimos el árbol
// a partir de los grupos que envía el backend y lo pintamos con nodos anidados,
// casillas tri-estado que cascadean y líneas de árbol.
type PermLeaf = { kind: "leaf"; key: string; label: string; inRole: boolean };
type PermBranch = { kind: "branch"; id: string; label: string; children: PermNode[] };
type PermNode = PermLeaf | PermBranch;

const BUCKET_ORDER = ["Módulos del sistema", "Pantallas del menú", "Áreas de acceso"];
const bucketOf = (group: string) =>
  group.startsWith("Pantalla") ? "Pantallas del menú" : group === "Áreas Vestel" ? "Áreas de acceso" : "Módulos del sistema";

function buildPermTree(groups: PermGroup[]): PermBranch[] {
  const buckets = new Map<string, PermBranch>();
  for (const name of BUCKET_ORDER) buckets.set(name, { kind: "branch", id: `bucket:${name}`, label: name, children: [] });
  for (const g of groups) {
    const bucket = buckets.get(bucketOf(g.group))!;
    const leaves: PermLeaf[] = g.items.map((it) => ({ kind: "leaf", key: it.key, label: it.label, inRole: it.inRole }));
    if (bucket.id === "bucket:Áreas de acceso") {
      bucket.children.push(...leaves); // las áreas cuelgan directas de su sección
    } else {
      const label = g.group.startsWith("Pantalla · ") ? g.group.slice("Pantalla · ".length) : g.group;
      bucket.children.push({ kind: "branch", id: `mod:${g.group}`, label, children: leaves });
    }
  }
  return BUCKET_ORDER.map((n) => buckets.get(n)!).filter((b) => b.children.length);
}

const leafKeysOf = (node: PermNode, acc: string[] = []): string[] => {
  if (node.kind === "leaf") acc.push(node.key);
  else for (const c of node.children) leafKeysOf(c, acc);
  return acc;
};

function prunePermTree(nodes: PermNode[], keep: (l: PermLeaf) => boolean): PermNode[] {
  const out: PermNode[] = [];
  for (const n of nodes) {
    if (n.kind === "leaf") { if (keep(n)) out.push(n); }
    else { const kids = prunePermTree(n.children, keep); if (kids.length) out.push({ ...n, children: kids }); }
  }
  return out;
}

const allBranchIds = (nodes: PermNode[], acc: string[] = []): string[] => {
  for (const n of nodes) if (n.kind === "branch") { acc.push(n.id); allBranchIds(n.children, acc); }
  return acc;
};

/** Casilla tri-estado (todo / parcial / nada) que cascadea a los hijos. */
function TriCheck({ state, onClick }: { state: "all" | "some" | "none"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={state === "all" ? "Quitar todo" : "Activar todo"}
      className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        state === "none" ? "border-border-default bg-surface hover:border-brand" : "border-brand bg-brand text-on-brand"
      }`}
    >
      {state === "all" && <Icon name="check" size={12} />}
      {state === "some" && <span className="h-[2px] w-2 rounded-full bg-on-brand" />}
    </button>
  );
}

/** Caja con la contraseña temporal recién generada (se muestra una sola vez). */
function TempPasswordBox({ pw, onClose }: { pw: string; onClose: () => void }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg bg-warning-soft p-2.5 text-[12px]">
      <Icon name="key-round" size={15} className="mt-0.5 shrink-0 text-warning-text" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-warning-text">Contraseña temporal — guárdala, no se vuelve a mostrar</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="rounded bg-surface px-2 py-1 font-mono text-[12px] text-text-primary">{pw}</code>
          <button type="button" onClick={() => navigator.clipboard?.writeText(pw)} className="text-[11px] font-semibold text-brand hover:underline">Copiar</button>
        </div>
      </div>
      <button type="button" onClick={onClose} className="shrink-0 text-text-tertiary hover:text-text-primary"><Icon name="x" size={14} /></button>
    </div>
  );
}

/** Fila (recursiva) del árbol de permisos. */
function PermTreeRow({ node, depth, granted, baseline, readOnly, openIds, toggleOpen, setLeaves, forceOpen }: {
  node: PermNode; depth: number; granted: Set<string>; baseline: Set<string>; readOnly: boolean;
  openIds: Set<string>; toggleOpen: (id: string) => void; setLeaves: (keys: string[], on: boolean) => void; forceOpen: boolean;
}) {
  if (node.kind === "leaf") {
    const on = granted.has(node.key);
    const inRole = baseline.has(node.key);
    return (
      <div className="flex items-center gap-2 rounded-md py-[5px] pl-1 pr-2 hover:bg-surface-2/50">
        <span className="w-[15px] shrink-0" />
        {readOnly ? (
          <Icon name="check" size={14} className="shrink-0 text-success-text" />
        ) : (
          <TriCheck state={on ? "all" : "none"} onClick={() => setLeaves([node.key], !on)} />
        )}
        <span className={`min-w-0 truncate text-[12px] ${on ? "text-text-primary" : "text-text-secondary"}`}>{node.label}</span>
        {on && !inRole && <span className="shrink-0 rounded bg-brand-soft px-1 py-0.5 text-[9px] font-semibold text-brand">extra</span>}
        {!readOnly && !on && inRole && <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9px] font-semibold text-text-tertiary">del rol</span>}
      </div>
    );
  }

  const keys = leafKeysOf(node);
  const onCount = keys.reduce((n, k) => n + (granted.has(k) ? 1 : 0), 0);
  const state: "all" | "some" | "none" = onCount === 0 ? "none" : onCount === keys.length ? "all" : "some";
  const isOpen = forceOpen || openIds.has(node.id);
  const isBucket = depth === 0;
  return (
    <div>
      <div
        onClick={() => toggleOpen(node.id)}
        className="flex cursor-pointer items-center gap-2 rounded-md py-[5px] pr-2 hover:bg-surface-2/40"
      >
        <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-text-tertiary">
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={15} />
        </span>
        {!readOnly && <TriCheck state={state} onClick={() => setLeaves(keys, state !== "all")} />}
        <span className={`min-w-0 flex-1 truncate font-semibold ${isBucket ? "text-[11px] uppercase tracking-wide text-text-secondary" : "text-[12.5px] text-text-primary"}`}>
          {node.label}
        </span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${onCount ? "bg-brand-soft text-brand" : "bg-surface-2 text-text-tertiary"}`}>
          {readOnly ? onCount : `${onCount}/${keys.length}`}
        </span>
      </div>
      {isOpen && (
        <div className={`ml-[7px] border-l border-border-subtle pl-2 ${isBucket ? "mb-1" : ""}`}>
          {node.children.map((c) => (
            <PermTreeRow
              key={c.kind === "leaf" ? c.key : c.id}
              node={c} depth={depth + 1} granted={granted} baseline={baseline} readOnly={readOnly}
              openIds={openIds} toggleOpen={toggleOpen} setLeaves={setLeaves} forceOpen={forceOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Ficha de permisos del empleado (árbol). Solo el superusuario puede editarlos. */
function PermisosCard({ staffId }: { staffId: string }) {
  const { authFetch, isSuperadmin } = useAuth();
  const [data, setData] = useState<PermData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [roleCat, setRoleCat] = useState<any[] | null>(null);
  const [roleDraft, setRoleDraft] = useState<Set<string>>(new Set());
  const [rolesMenuOpen, setRolesMenuOpen] = useState(false);
  const rolesRef = useRef<HTMLDivElement>(null);
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [busyAcct, setBusyAcct] = useState(false);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/staff/${staffId}/permissions`);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, staffId]);

  useEffect(() => { void load(); }, [load]);

  const effectiveKeys = useMemo(() => {
    const s = new Set<string>();
    for (const g of data?.groups ?? []) for (const it of g.items) if (it.effective) s.add(it.key);
    return s;
  }, [data]);

  const tree = useMemo(() => (data ? buildPermTree(data.groups) : []), [data]);

  // Al cargar, abre las secciones (nivel 0); los módulos quedan colapsados.
  useEffect(() => { setOpen(new Set(tree.map((b) => b.id))); }, [tree]);

  const q = query.trim().toLowerCase();
  const editTree = useMemo(
    () => (q ? prunePermTree(tree, (l) => l.label.toLowerCase().includes(q)) : tree),
    [tree, q],
  );
  const viewTree = useMemo(
    () => prunePermTree(tree, (l) => effectiveKeys.has(l.key)),
    [tree, effectiveKeys],
  );

  // ── Roles ──
  // Carga el catálogo de roles (solo si es superusuario y hay cuenta vinculada).
  useEffect(() => {
    if (!isSuperadmin || !data?.linked || roleCat) return;
    authFetch("/staff/role-catalog").then((r) => r.json()).then(setRoleCat).catch(() => {});
  }, [isSuperadmin, data, roleCat, authFetch]);

  const currentRoleKeys = useMemo(() => new Set((data?.roles ?? []).map((r) => r.key)), [data]);
  const roleNameByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data?.roles ?? []) m.set(r.key, r.name);
    for (const r of roleCat ?? []) m.set(r.key, r.name);
    return m;
  }, [data, roleCat]);
  const rolesByArea = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of roleCat ?? []) { const a = r.area ?? "Otros"; if (!map.has(a)) map.set(a, []); map.get(a)!.push(r); }
    return [...map.entries()];
  }, [roleCat]);
  const unionPerms = useCallback((keys: Set<string>) => {
    const s = new Set<string>();
    for (const r of roleCat ?? []) if (keys.has(r.key)) for (const k of r.permissionKeys ?? []) s.add(k);
    return s;
  }, [roleCat]);
  // Baseline = permisos que dan los roles. En lectura, del backend; en edición, de los roles elegidos.
  const readBaseline = useMemo(() => {
    const s = new Set<string>();
    for (const g of data?.groups ?? []) for (const it of g.items) if (it.inRole) s.add(it.key);
    return s;
  }, [data]);
  const editBaseline = useMemo(() => (roleCat ? unionPerms(roleDraft) : readBaseline), [roleCat, roleDraft, unionPerms, readBaseline]);
  const rolesDirty = useMemo(() => {
    if (roleDraft.size !== currentRoleKeys.size) return true;
    for (const k of roleDraft) if (!currentRoleKeys.has(k)) return true;
    return false;
  }, [roleDraft, currentRoleKeys]);

  const toggleOpen = useCallback((id: string) =>
    setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  const setLeaves = useCallback((keys: string[], on: boolean) =>
    setDraft((prev) => {
      const next = new Set(prev);
      for (const k of keys) { if (on) next.add(k); else next.delete(k); }
      return next;
    }), []);

  const activeTree = editing ? editTree : viewTree;
  const branchIds = useMemo(() => allBranchIds(activeTree), [activeTree]);
  const allOpen = branchIds.length > 0 && branchIds.every((id) => open.has(id));
  const toggleAllOpen = () => setOpen(allOpen ? new Set() : new Set(branchIds));

  const startEdit = () => {
    setDraft(new Set(effectiveKeys));
    setRoleDraft(new Set(currentRoleKeys));
    setQuery("");
    setRolesMenuOpen(false);
    setOpen(new Set(tree.map((b) => b.id)));
    setEditing(true);
  };
  const cancelEdit = () => { setRolesMenuOpen(false); setEditing(false); };

  // Marca/desmarca un rol y activa (o retira) sus permisos en el árbol.
  const toggleRoleEdit = useCallback((roleKey: string) => {
    const role = (roleCat ?? []).find((r) => r.key === roleKey);
    if (!role) return;
    const perms: string[] = role.permissionKeys ?? [];
    const adding = !roleDraft.has(roleKey);
    const nextRoles = new Set(roleDraft);
    if (adding) nextRoles.add(roleKey); else nextRoles.delete(roleKey);
    setRoleDraft(nextRoles);
    const remaining = unionPerms(nextRoles);
    setDraft((prev) => {
      const nd = new Set(prev);
      if (adding) for (const p of perms) nd.add(p);
      else for (const p of perms) if (!remaining.has(p)) nd.delete(p);
      return nd;
    });
  }, [roleCat, roleDraft, unionPerms]);

  // Cierra el desplegable de roles al hacer click fuera.
  useEffect(() => {
    if (!rolesMenuOpen) return;
    const onDoc = (e: MouseEvent) => { if (rolesRef.current && !rolesRef.current.contains(e.target as Node)) setRolesMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [rolesMenuOpen]);

  const changedCount = useMemo(() => {
    let c = 0;
    const all = new Set([...draft, ...effectiveKeys]);
    for (const k of all) if (draft.has(k) !== effectiveKeys.has(k)) c++;
    return c;
  }, [draft, effectiveKeys]);
  const dirty = changedCount > 0 || rolesDirty;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      if (rolesDirty) {
        const rr = await authFetch(`/staff/${staffId}/roles`, { method: "PATCH", body: JSON.stringify({ roleKeys: [...roleDraft] }) });
        const rd = await rr.json();
        if (!rr.ok) throw new Error(rd?.message || "Error al guardar los roles");
      }
      const res = await authFetch(`/staff/${staffId}/permissions`, { method: "PATCH", body: JSON.stringify({ granted: [...draft] }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      setData(d);
      setEditing(false);
      void reloadAudit();
      toast("Cambios guardados.", "check");
    } catch (e: any) {
      toast(e?.message || "No se pudieron guardar los cambios.", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [authFetch, staffId, draft, roleDraft, rolesDirty]);

  const noop = useCallback(() => {}, []);

  // Restablecer al rol: deja el árbol exactamente con lo que dan los roles (sin overrides).
  const overrideCount = useMemo(() => {
    let c = 0;
    const all = new Set([...draft, ...editBaseline]);
    for (const k of all) if (draft.has(k) !== editBaseline.has(k)) c++;
    return c;
  }, [draft, editBaseline]);
  const resetToRole = () => setDraft(new Set(editBaseline));

  // ── Cuenta de acceso ──
  const account = data?.account ?? null;

  const reloadAudit = useCallback(async () => {
    try { const r = await authFetch(`/staff/${staffId}/audit`); setAudit(await r.json()); } catch { /* silencioso */ }
  }, [authFetch, staffId]);

  useEffect(() => { if (data?.linked && audit === null) void reloadAudit(); }, [data, audit, reloadAudit]);

  const createAccount = useCallback(async () => {
    setBusyAcct(true);
    try {
      const res = await authFetch(`/staff/${staffId}/account`, { method: "POST", body: JSON.stringify({}) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      setData(d); setTempPw(d.tempPassword ?? null); setAudit(null);
      toast("Acceso creado. Ya puedes asignarle roles y permisos.", "check");
    } catch (e: any) { toast(e?.message || "No se pudo crear el acceso.", "alert-triangle"); }
    finally { setBusyAcct(false); }
  }, [authFetch, staffId]);

  const toggleActive = useCallback(async () => {
    if (!account) return;
    setBusyAcct(true);
    try {
      const res = await authFetch(`/staff/${staffId}/account/active`, { method: "PATCH", body: JSON.stringify({ isActive: !account.isActive }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      setData(d); void reloadAudit();
      toast(d.account?.isActive ? "Acceso habilitado." : "Acceso inhabilitado.", "check");
    } catch (e: any) { toast(e?.message || "No se pudo cambiar el estado.", "alert-triangle"); }
    finally { setBusyAcct(false); }
  }, [authFetch, staffId, account, reloadAudit]);

  const resetPassword = useCallback(async () => {
    setBusyAcct(true);
    try {
      const res = await authFetch(`/staff/${staffId}/account/password`, { method: "POST", body: JSON.stringify({}) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      setData(d); setTempPw(d.tempPassword ?? null); void reloadAudit();
      toast("Contraseña restablecida.", "check");
    } catch (e: any) { toast(e?.message || "No se pudo restablecer la contraseña.", "alert-triangle"); }
    finally { setBusyAcct(false); }
  }, [authFetch, staffId, reloadAudit]);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name="shield-check" size={15} className="text-brand" />
          Permisos y accesos
        </div>
        {data?.linked && (
          isSuperadmin ? (
            editing ? (
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>
                  <Icon name="x" size={14} /> Cancelar
                </Button>
                <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
                  <Icon name="save" size={14} /> {saving ? "Guardando…" : changedCount > 0 ? `Guardar (${changedCount})` : "Guardar"}
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={startEdit}>
                <Icon name="pencil" size={14} /> Editar permisos
              </Button>
            )
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-text-tertiary">
              <Icon name="lock" size={13} /> Solo el superusuario puede editar
            </span>
          )
        )}
      </div>

      {loading && !data ? (
        <div className="py-6 text-center text-[12px] text-text-tertiary">Cargando permisos…</div>
      ) : !data?.linked ? (
        <div>
          <div className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-[12px] text-text-secondary">
            <Icon name="key-round" size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
            <span>Este empleado <strong>no tiene cuenta del sistema</strong>, así que aún no puede acceder ni tiene permisos.</span>
          </div>
          {isSuperadmin && (
            data?.hasEmail ? (
              <div className="mt-2">
                <Button variant="primary" size="sm" onClick={createAccount} disabled={busyAcct}>
                  <Icon name="key-round" size={14} /> {busyAcct ? "Creando…" : "Crear acceso al sistema"}
                </Button>
                <p className="mt-1 text-[11px] text-text-tertiary">Se crea el usuario con su correo y una contraseña temporal. Después le asignas roles y permisos.</p>
                {tempPw && <TempPasswordBox pw={tempPw} onClose={() => setTempPw(null)} />}
              </div>
            ) : (
              <p className="mt-2 text-[12px] text-text-tertiary">Primero agrégale un <strong>correo</strong> en Datos personales para poder crearle el acceso.</p>
            )
          )}
        </div>
      ) : (
        <>
          {/* Cuenta de acceso */}
          {account && (
            <div className="mb-3 rounded-lg border border-border-subtle bg-surface-2/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-text-primary">
                  <Icon name="user-check" size={15} className="text-brand" />
                  Cuenta del sistema
                  <Badge label={account.isActive ? "Activa" : "Inhabilitada"} tone={account.isActive ? "success" : "error"} />
                </div>
                {isSuperadmin && (
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={toggleActive} disabled={busyAcct}>
                      <Icon name={account.isActive ? "lock" : "check"} size={14} /> {account.isActive ? "Inhabilitar" : "Habilitar"}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={resetPassword} disabled={busyAcct}>
                      <Icon name="key-round" size={14} /> Restablecer contraseña
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11.5px] text-text-tertiary sm:grid-cols-3">
                <div>Correo: <span className="text-text-secondary">{account.email}</span></div>
                <div>Creada: <span className="text-text-secondary">{fmtDate(account.createdAt)}</span></div>
                <div>Último ingreso: <span className="text-text-secondary">{fmtDate(account.lastLogin)}</span></div>
              </div>
              {tempPw && <TempPasswordBox pw={tempPw} onClose={() => setTempPw(null)} />}
            </div>
          )}

          {/* Roles base */}
          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Roles</div>
            {editing ? (
              /* Desplegable multi-selección de roles (activa/retira sus permisos en el árbol) */
              <div ref={rolesRef} className="relative">
                <button
                  type="button"
                  onClick={() => setRolesMenuOpen((o) => !o)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-border-default bg-surface px-2.5 py-2 text-left hover:border-brand"
                >
                  <span className="flex min-w-0 flex-wrap gap-1">
                    {roleDraft.size ? (
                      [...roleDraft].map((k) => (
                        <span key={k} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">{roleNameByKey.get(k) ?? k}</span>
                      ))
                    ) : (
                      <span className="text-[12px] text-text-tertiary">Sin roles — elige uno o más…</span>
                    )}
                  </span>
                  <Icon name={rolesMenuOpen ? "chevron-down" : "chevron-right"} size={15} className="shrink-0 text-text-tertiary" />
                </button>
                {rolesMenuOpen && (
                  <div className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-border-subtle bg-surface p-2 shadow-lg">
                    {!roleCat ? (
                      <div className="py-4 text-center text-[12px] text-text-tertiary">Cargando roles…</div>
                    ) : (
                      rolesByArea.map(([area, roles]) => (
                        <div key={area} className="mb-1.5 last:mb-0">
                          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{area}</div>
                          {roles.map((r: any) => {
                            const on = roleDraft.has(r.key);
                            return (
                              <label key={r.key} className={`flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-2 ${on ? "bg-brand-soft/40" : ""}`}>
                                <input type="checkbox" checked={on} onChange={() => toggleRoleEdit(r.key)} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
                                <span className="min-w-0">
                                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
                                    {r.name}
                                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium text-text-tertiary">{r.permissionCount}</span>
                                  </span>
                                  {r.description && <span className="block text-[11px] leading-tight text-text-tertiary">{r.description}</span>}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                )}
                <p className="mt-1 text-[11px] text-text-tertiary">Al cambiar un rol se activan o retiran sus permisos en el árbol. Guarda para aplicar.</p>
              </div>
            ) : data.roles.length ? (
              <div className="flex flex-wrap gap-1.5">
                {data.roles.map((r) => <Badge key={r.key} label={r.name} tone="info" />)}
                {data.isSuperadmin && <Badge label="Superusuario" tone="brand" />}
              </div>
            ) : (
              <span className="text-[12px] text-text-tertiary">Sin roles asignados</span>
            )}
          </div>

          {editing ? (
            /* ── Modo edición: árbol de permisos + buscador ── */
            <div>
              <div className="mb-2 flex items-center gap-2">
                <div className="relative flex-1">
                  <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                  <Input className="pl-8" placeholder="Buscar permiso…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <Button variant="ghost" size="sm" onClick={toggleAllOpen} disabled={!!q}>
                  <Icon name="chevrons-up-down" size={14} />
                  {allOpen ? "Colapsar" : "Expandir"}
                </Button>
                <Button variant="ghost" size="sm" onClick={resetToRole} disabled={overrideCount === 0} title="Deja solo lo que dan los roles (quita los ajustes finos)">
                  <Icon name="key-round" size={14} />
                  Restablecer al rol{overrideCount > 0 ? ` (${overrideCount})` : ""}
                </Button>
              </div>

              <div className="rounded-lg border border-border-subtle p-1.5">
                {editTree.length ? (
                  editTree.map((n) => (
                    <PermTreeRow
                      key={n.kind === "leaf" ? n.key : n.id} node={n} depth={0} granted={draft} baseline={editBaseline} readOnly={false}
                      openIds={open} toggleOpen={toggleOpen} setLeaves={setLeaves} forceOpen={!!q}
                    />
                  ))
                ) : (
                  <div className="py-6 text-center text-[12px] text-text-tertiary">Ningún permiso coincide con “{query}”.</div>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-border-subtle pt-3">
                <span className="text-[11px] text-text-tertiary">
                  {draft.size} permisos activos{changedCount > 0 ? ` · ${changedCount} cambio${changedCount === 1 ? "" : "s"} sin guardar` : ""}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>Cancelar</Button>
                  <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
                    <Icon name="save" size={14} /> {saving ? "Guardando…" : changedCount > 0 ? `Guardar (${changedCount})` : "Guardar"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            /* ── Modo lectura: árbol colapsable con solo lo que el empleado tiene ── */
            <div>
              {viewTree.length > 0 && (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] text-text-tertiary">{effectiveKeys.size} permisos activos</span>
                  <Button variant="ghost" size="sm" onClick={toggleAllOpen}>
                    <Icon name="chevrons-up-down" size={14} />
                    {allOpen ? "Colapsar" : "Expandir"} todo
                  </Button>
                </div>
              )}
              <div className="rounded-lg border border-border-subtle p-1.5">
                {viewTree.length ? (
                  viewTree.map((n) => (
                    <PermTreeRow
                      key={n.kind === "leaf" ? n.key : n.id} node={n} depth={0} granted={effectiveKeys} baseline={readBaseline} readOnly
                      openIds={open} toggleOpen={toggleOpen} setLeaves={noop} forceOpen={false}
                    />
                  ))
                ) : (
                  <div className="py-6 text-center text-[12px] text-text-tertiary">Este empleado no tiene permisos efectivos.</div>
                )}
              </div>
            </div>
          )}

          {/* Bitácora de cambios de acceso */}
          {!editing && audit && audit.length > 0 && (
            <div className="mt-4 border-t border-border-subtle pt-3">
              <button type="button" onClick={() => setAuditOpen((o) => !o)} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary hover:text-text-secondary">
                <Icon name={auditOpen ? "chevron-down" : "chevron-right"} size={14} />
                Actividad de accesos ({audit.length})
              </button>
              {auditOpen && (
                <div className="mt-2 space-y-1.5">
                  {audit.map((a) => (
                    <div key={a.id} className="flex items-start gap-2 text-[12px]">
                      <Icon name="clock" size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
                      <div className="min-w-0">
                        <span className="text-text-primary">{a.action}</span>
                        <span className="text-text-tertiary"> · {a.actorName ?? "sistema"} · {fmtDateTime(a.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Edición de datos del empleado ───────────────────────────────────────────
// Refleja UpdateStaffDto del backend. Se envían todos los campos del formulario:
// los que el usuario deja vacíos viajan como "" y el backend los pasa a NULL.
const EDIT_FIELDS = [
  "name", "docNumber", "username", "email", "phone", "phoneAlt",
  "eps", "pension", "rh", "address", "city", "region",
] as const;

/** Fecha ISO del backend → `yyyy-mm-dd` que espera <input type="date">. */
const toDateInput = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

function EditarEmpleadoModal({
  emp, open, onClose, onSaved,
}: { emp: any; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { authFetch } = useAuth();
  const [areas, setAreas] = useState<any[]>([]);
  const [form, setForm] = useState<any>({});
  const [saving, setSaving] = useState(false);

  // Al abrir, precarga el formulario con los datos actuales del empleado.
  useEffect(() => {
    if (!open) return;
    const f: any = {};
    for (const k of EDIT_FIELDS) f[k] = emp[k] ?? "";
    f.role = emp.role != null ? String(emp.role) : "";
    f.areaId = emp.areaId ?? "";
    f.entryDate = toDateInput(emp.entryDate);
    setForm(f);
    void authFetch("/staff/areas").then((r) => r.json()).then(setAreas).catch(() => {});
  }, [open, emp, authFetch]);

  const setF = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = useCallback(async () => {
    if (!String(form.name ?? "").trim()) { toast("El nombre es obligatorio.", "alert-triangle"); return; }
    setSaving(true);
    try {
      const body: any = {};
      for (const k of EDIT_FIELDS) body[k] = String(form[k] ?? "").trim();
      // null explícito (no undefined): JSON.stringify descarta undefined y el
      // backend dejaría el campo intacto, volviendo el borrado un no-op mudo.
      body.role = form.role ? Number(form.role) : null;
      body.areaId = form.areaId ?? "";
      body.entryDate = form.entryDate || null;
      const res = await authFetch(`/staff/${emp.id}`, { method: "PATCH", body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Empleado actualizado.", "check");
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message || "No se pudo actualizar el empleado.", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [authFetch, emp.id, form, onSaved, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Editar empleado" maxWidth="max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Nombre" required>
            <Input value={form.name ?? ""} onChange={(e) => setF("name", e.target.value)} placeholder="Nombre completo" />
          </Field>
        </div>
        <Field label="Documento">
          <Input value={form.docNumber ?? ""} onChange={(e) => setF("docNumber", e.target.value)} />
        </Field>
        <Field label="Usuario">
          <Input value={form.username ?? ""} onChange={(e) => setF("username", e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Email" hint="Es el vínculo con la cuenta de acceso: si lo cambias, revisa la pestaña de permisos.">
            <Input type="email" value={form.email ?? ""} onChange={(e) => setF("email", e.target.value)} />
          </Field>
        </div>
        <Field label="Rol">
          <Select value={form.role ?? ""} onChange={(e) => setF("role", e.target.value)}>
            <option value="">Sin rol</option>
            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Área">
          <Select value={form.areaId ?? ""} onChange={(e) => setF("areaId", e.target.value)}>
            <option value="">Sin área</option>
            {areas.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Fecha de ingreso">
          <Input type="date" value={form.entryDate ?? ""} onChange={(e) => setF("entryDate", e.target.value)} />
        </Field>
        <Field label="RH">
          <Input value={form.rh ?? ""} onChange={(e) => setF("rh", e.target.value)} placeholder="O+" />
        </Field>
        <Field label="EPS">
          <Input value={form.eps ?? ""} onChange={(e) => setF("eps", e.target.value)} />
        </Field>
        <Field label="Pensión">
          <Input value={form.pension ?? ""} onChange={(e) => setF("pension", e.target.value)} />
        </Field>
        <Field label="Teléfono">
          <Input value={form.phone ?? ""} onChange={(e) => setF("phone", e.target.value)} />
        </Field>
        <Field label="Teléfono alterno">
          <Input value={form.phoneAlt ?? ""} onChange={(e) => setF("phoneAlt", e.target.value)} />
        </Field>
        <Field label="Ciudad">
          <Input value={form.city ?? ""} onChange={(e) => setF("city", e.target.value)} />
        </Field>
        <Field label="Región">
          <Input value={form.region ?? ""} onChange={(e) => setF("region", e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Dirección">
            <Input value={form.address ?? ""} onChange={(e) => setF("address", e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          <Icon name="x" size={15} />
          Cancelar
        </Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          <Icon name="check" size={15} />
          {saving ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </Modal>
  );
}

export default function EmpleadoDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("datos");
  const [openEdit, setOpenEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/staff/${id}`);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading) return;
    void load();
  }, [authLoading, load]);

  if (authLoading || (loading && !data)) return <PageSkeleton />;

  const emp: any = data ?? {};
  const activity: any = emp.activity ?? {};

  return (
    <>
      <Link href="/empleados" className="inline-flex items-center gap-1 text-[12px] font-semibold text-text-secondary hover:text-brand">
        <Icon name="arrow-left" size={14} />
        Empleados
      </Link>

      {/* Encabezado */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2">
          <Icon name="user" size={22} className="text-text-secondary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[17px] font-bold text-text-primary sm:text-[20px]">{emp.name ?? "Empleado"}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge label={emp.roleLabel ?? "—"} tone="info" />
            <Badge label={emp.banned ? "Inhabilitado" : "Activo"} tone={emp.banned ? "error" : "success"} />
          </div>
        </div>
        <div className="ml-auto">
          <Button variant="secondary" onClick={() => setOpenEdit(true)}>
            <Icon name="pencil" size={15} />
            Editar
          </Button>
        </div>
      </div>

      {/* Pestañas: datos personales / permisos */}
      <TabBar<TabKey>
        tabs={[
          { key: "datos", label: "Datos personales" },
          { key: "permisos", label: "Permisos y accesos" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "datos" ? (
        <>
          {/* Datos */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Datos personales" icon="user">
              <Row label="Documento" value={emp.docNumber} />
              <Row label="Usuario" value={emp.username} />
              <Row label="Email" value={emp.email} />
              <Row label="Área" value={emp.area} />
              <Row label="Fecha de ingreso" value={fmtDate(emp.entryDate ?? null)} />
              <Row label="Último acceso" value={fmtDate(emp.lastLogin ?? null)} />
            </Card>

            <Card title="Salud y contacto" icon="phone">
              <Row label="RH" value={emp.rh} />
              <Row label="EPS" value={emp.eps} />
              <Row label="Pensión" value={emp.pension} />
              <Row label="Teléfono" value={emp.phone} />
              <Row label="Teléfono alterno" value={emp.phoneAlt} />
              <Row label="Dirección" value={emp.address} />
              <Row label="Ciudad" value={emp.city} />
              <Row label="Región" value={emp.region} />
            </Card>
          </div>

          {/* Actividad */}
          <div>
            <div className="mb-2.5 flex items-center gap-2 text-[13px] font-bold text-text-primary">
              <Icon name="activity" size={15} className="text-brand" />
              Actividad
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ActivityCard label="Transacciones" value={Number(activity.transactions ?? 0).toLocaleString("es-CO")} icon="activity" />
              <ActivityCard label="Ingresos" value={cop(Number(activity.income ?? 0))} icon="dollar-sign" />
              <ActivityCard label="Facturas emitidas" value={Number(activity.invoices ?? 0).toLocaleString("es-CO")} icon="receipt" />
            </div>
          </div>
        </>
      ) : (
        /* Permisos y accesos */
        <PermisosCard staffId={id} />
      )}

      <EditarEmpleadoModal emp={emp} open={openEdit} onClose={() => setOpenEdit(false)} onSaved={load} />
    </>
  );
}
