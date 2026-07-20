"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/accounting/PageHeading";
import { DataTable } from "@/components/inventory/DataTable";
import { PermissionGate } from "@/components/PermissionGate";
import { useAuth } from "@/context/AuthProvider";
import { initials } from "@/lib/auth";
import { toast } from "@/components/ui/Toast";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { SedesAccedeField } from "@/components/usuarios/SedesAccedeField";
import { Modal } from "@/components/Modal";

type RoleRef = { role: { key: string; name: string } };
type User = {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  sedesAccede: number[];
  roles: RoleRef[];
};
type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  area: string;
  system: boolean;
  permissions: { permission: { key: string; label: string } }[];
  _count: { users: number };
};

const ROLE_AREA_ORDER = ["Áreas Vestel", "Administración", "Inventario", "Recursos Humanos", "Contabilidad", "SST", "Personalizados", "Otros"];

/** Agrupa roles por área en el orden de presentación. */
function groupRolesByArea(roles: Role[]) {
  const byArea = new Map<string, Role[]>();
  for (const r of roles) {
    const arr = byArea.get(r.area) ?? [];
    arr.push(r);
    byArea.set(r.area, arr);
  }
  return [...byArea.entries()]
    .map(([area, items]) => ({ area, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => {
      const ia = ROLE_AREA_ORDER.indexOf(a.area);
      const ib = ROLE_AREA_ORDER.indexOf(b.area);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}

/** Estado del constructor de roles: crear desde cero, o editar/clonar uno existente. */
type RoleEditorState = { mode: "create" | "edit"; role: Role | null } | null;

function UsersAdmin() {
  const { authFetch, user: me, isSuperadmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [editingProfile, setEditingProfile] = useState<User | null>(null);
  const [roleEditor, setRoleEditor] = useState<RoleEditorState>(null);
  const [search, setSearch] = useState("");

  async function deleteRole(role: Role) {
    if (!confirm(`¿Eliminar el rol "${role.name}"? Esta acción no se puede deshacer.`)) return;
    const res = await authFetch(`/auth/roles/${role.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => null);
    if (res.ok) { setRoles(body); toast("Rol eliminado", "check"); }
    else toast(body?.message ?? "No se pudo eliminar el rol", "alert-circle");
  }

  const filtered = users.filter((u) => {
    const q = search.trim().toLowerCase();
    return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [uRes, rRes] = await Promise.all([
        authFetch("/auth/users"),
        authFetch("/auth/roles"),
      ]);
      if (uRes.ok) setUsers(await uRes.json());
      if (rRes.ok) setRoles(await rRes.json());
    } catch {
      toast("No se pudo cargar la información", "alert-circle");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(u: User) {
    if (u.isActive && !confirm(`¿Desactivar a ${u.name}? No podrá iniciar sesión hasta que lo reactives.`)) return;
    const res = await authFetch(`/auth/users/${u.id}/active`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !u.isActive }),
    });
    if (res.ok) {
      setUsers(await res.json());
      toast(u.isActive ? "Usuario desactivado" : "Usuario activado", "check");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.message ?? "No se pudo actualizar", "alert-circle");
    }
  }

  return (
    <>
      {/* encabezado */}
      <div className="flex items-center justify-between">
        <PageHeading icon="user-cog" title="Usuarios y roles" />
        <Button onClick={() => setCreating(true)}>
          <Icon name="user-plus" size={15} /> Nuevo usuario
        </Button>
      </div>

      {/* tarjetas de resumen */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon="users" label="Usuarios" value={users.length} />
        <StatCard
          icon="check"
          label="Activos"
          value={users.filter((u) => u.isActive).length}
        />
        <StatCard icon="shield-check" label="Roles definidos" value={roles.length} />
      </div>

      {/* usuarios */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Icon name="users" size={15} className="text-text-secondary" />
          <h2 className="text-[14px] font-bold text-text-primary">Usuarios</h2>
        </div>
        <div className="relative sm:w-64">
          <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder="Buscar por nombre o correo…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-tertiary">
          <Icon name="loader" size={18} className="animate-spin" />
        </div>
      ) : (
        <DataTable
          rows={filtered}
          empty={search ? "Ningún usuario coincide con la búsqueda." : "No hay usuarios todavía."}
          columns={[
            {
              key: "user",
              header: "Usuario",
              render: (u) => (
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">
                    {initials(u.name)}
                  </span>
                  <div className="flex flex-col leading-tight">
                    <span className="font-semibold text-text-primary">
                      {u.name}
                      {me?.id === u.id && <span className="ml-1.5 text-[11px] font-normal text-text-tertiary">(tú)</span>}
                    </span>
                    <span className="text-[12px] text-text-tertiary">{u.email}</span>
                  </div>
                </div>
              ),
            },
            {
              key: "roles",
              header: "Roles",
              render: (u) => (
                <div className="flex flex-wrap gap-1">
                  {u.roles.length === 0 ? (
                    <span className="text-[12px] text-text-tertiary">Sin rol</span>
                  ) : (
                    u.roles.map((r) => (
                      <Badge key={r.role.key} label={r.role.name} tone="brand" />
                    ))
                  )}
                </div>
              ),
            },
            {
              key: "status",
              header: "Estado",
              render: (u) =>
                u.isActive ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success-text">
                    <span className="h-1.5 w-1.5 rounded-full bg-success-text" /> Activo
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-text-tertiary">
                    <span className="h-1.5 w-1.5 rounded-full bg-text-tertiary" /> Inactivo
                  </span>
                ),
            },
            {
              key: "actions",
              header: "Acciones",
              align: "right",
              render: (u) => (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditingProfile(u)}>
                    <Icon name="pencil" size={14} /> Editar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                    <Icon name="user-cog" size={14} /> Roles
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void toggleActive(u)}
                    disabled={me?.id === u.id}
                    title={me?.id === u.id ? "No puedes desactivar tu propia cuenta" : ""}
                  >
                    {u.isActive ? "Desactivar" : "Activar"}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {/* roles agrupados por área */}
      <section className="rounded-xl border border-border-subtle bg-surface">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <Icon name="shield-check" size={15} className="text-text-secondary" />
          <h2 className="text-[14px] font-bold text-text-primary">Roles y permisos</h2>
          <span className="ml-auto text-[12px] text-text-tertiary">{roles.length} roles</span>
          {isSuperadmin && (
            <Button size="sm" onClick={() => setRoleEditor({ mode: "create", role: null })}>
              <Icon name="plus" size={14} /> Nuevo rol
            </Button>
          )}
        </div>
        {isSuperadmin && (
          <p className="border-b border-border-subtle bg-surface-2/50 px-4 py-2 text-[11px] text-text-tertiary">
            Los roles del sistema <Icon name="lock" size={10} className="inline" /> son plantillas de solo lectura. Para
            personalizarlos, usa <b>Clonar</b> y edita la copia.
          </p>
        )}
        <div className="flex flex-col gap-2 p-4">
          {groupRolesByArea(roles).map(({ area, items }) => (
            <Collapsible key={area} title={area} badge={`${items.length}`} defaultOpen>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((r) => (
                  <RoleCard
                    key={r.id}
                    role={r}
                    canManage={isSuperadmin}
                    onClone={() => setRoleEditor({ mode: "create", role: r })}
                    onEdit={() => setRoleEditor({ mode: "edit", role: r })}
                    onDelete={() => void deleteRole(r)}
                  />
                ))}
              </div>
            </Collapsible>
          ))}
        </div>
      </section>

      {creating && (
        <CreateUserModal
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
            toast("Usuario creado", "check");
          }}
        />
      )}
      {editing && (
        <EditRolesModal
          user={editing}
          roles={roles}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            toast("Roles actualizados", "check");
          }}
        />
      )}
      {roleEditor && (
        <RoleBuilderModal
          mode={roleEditor.mode}
          source={roleEditor.role}
          onClose={() => setRoleEditor(null)}
          onSaved={async (updated) => {
            setRoleEditor(null);
            setRoles(updated);
            toast(roleEditor.mode === "edit" ? "Rol actualizado" : "Rol creado", "check");
          }}
        />
      )}
      {editingProfile && (
        <EditUserModal
          user={editingProfile}
          onClose={() => setEditingProfile(null)}
          onSaved={async () => {
            setEditingProfile(null);
            await load();
          }}
        />
      )}
    </>
  );
}

/** Sección desplegable (acordeón) con título de área y conteo. */
function Collapsible({
  title,
  badge,
  highlight = false,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: string;
  highlight?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 bg-surface-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/70"
      >
        <span className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          <Icon
            name="chevron-right"
            size={14}
            className={`text-text-tertiary transition-transform duration-300 ease-out ${open ? "rotate-90" : ""}`}
          />
          {title}
        </span>
        {badge && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${highlight ? "bg-brand-soft text-brand" : "bg-surface text-text-tertiary"}`}>
            {badge}
          </span>
        )}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-2 p-3.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Tarjeta de rol con sus permisos desplegables (para saber qué concede cada uno). */
function RoleCard({
  role,
  canManage = false,
  onClone,
  onEdit,
  onDelete,
}: {
  role: Role;
  canManage?: boolean;
  onClone?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-surface-2 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
          {role.name}
          {role.system && <Icon name="lock" size={11} className="text-text-tertiary" aria-label="Rol del sistema (solo lectura)" />}
        </span>
        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-text-tertiary">
          {role._count.users} usuario{role._count.users === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-text-tertiary">{role.description}</p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-brand transition-colors hover:text-brand/80"
      >
        <Icon name="key-round" size={12} />
        {role.permissions.length} permisos
        <Icon name="chevron-right" size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1">
          {role.permissions.length === 0 ? (
            <span className="text-[11px] text-text-tertiary">Sin permisos asignados.</span>
          ) : (
            role.permissions.map((p) => (
              <span
                key={p.permission.key}
                className="rounded-md bg-surface px-1.5 py-0.5 text-[10px] text-text-secondary"
                title={p.permission.key}
              >
                {p.permission.label ?? p.permission.key}
              </span>
            ))
          )}
        </div>
      )}
      {canManage && (
        <div className="mt-2.5 flex items-center gap-1 border-t border-border-subtle pt-2.5">
          <Button variant="ghost" size="sm" onClick={onClone}><Icon name="copy" size={13} /> Clonar</Button>
          {!role.system && (
            <>
              <Button variant="ghost" size="sm" onClick={onEdit}><Icon name="pencil" size={13} /> Editar</Button>
              <Button variant="ghost" size="sm" onClick={onDelete} disabled={role._count.users > 0}
                title={role._count.users > 0 ? "Reasigna sus usuarios antes de eliminar" : "Eliminar rol"}>
                <Icon name="trash" size={13} className="text-error-text" />
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft">
        <Icon name={icon} size={18} className="text-brand" />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[22px] font-bold text-text-primary">{value}</span>
        <span className="text-[12px] text-text-tertiary">{label}</span>
      </div>
    </div>
  );
}

/** Campo de contraseña con botón ver/ocultar. */
function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        required
        type={show ? "text" : "password"}
        minLength={8}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-9"
        autoComplete="new-password"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <Icon name={show ? "eye-off" : "eye"} size={15} />
      </button>
    </div>
  );
}

function CreateUserModal({
  roles,
  onClose,
  onCreated,
}: {
  roles: Role[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { authFetch } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [sedesAccede, setSedesAccede] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleRole(key: string) {
    setRoleKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await authFetch("/auth/users", {
      method: "POST",
      body: JSON.stringify({ name, email, password, roleKeys, sedesAccede }),
    });
    if (res.ok) {
      onCreated();
    } else {
      const body = await res.json().catch(() => null);
      setError(Array.isArray(body?.message) ? body.message.join(", ") : body?.message ?? "Error");
      setSaving(false);
    }
  }

  return (
    <Modal open title="Nuevo usuario" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Nombre completo">
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej. María Pérez"
          />
        </Field>
        <Field label="Correo">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="maria@empresa.com"
          />
        </Field>
        <Field label="Contraseña temporal" hint="Mínimo 8 caracteres. El usuario podrá cambiarla luego.">
          <PasswordInput value={password} onChange={setPassword} placeholder="Mínimo 8 caracteres" />
        </Field>
        <div>
          <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Roles</span>
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {groupRolesByArea(roles).map(({ area, items }) => {
              const selected = items.filter((r) => roleKeys.includes(r.key)).length;
              return (
                <Collapsible
                  key={area}
                  title={area}
                  badge={selected > 0 ? `${selected} de ${items.length}` : `${items.length}`}
                  highlight={selected > 0}
                  defaultOpen={selected > 0}
                >
                  {items.map((r) => (
                    <label
                      key={r.key}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2"
                    >
                      <input
                        type="checkbox"
                        checked={roleKeys.includes(r.key)}
                        onChange={() => toggleRole(r.key)}
                        className="accent-brand"
                      />
                      <span className="font-medium text-text-primary">{r.name}</span>
                    </label>
                  ))}
                </Collapsible>
              );
            })}
          </div>
        </div>
        <SedesAccedeField value={sedesAccede} onChange={setSedesAccede} />
        {error && <p className="text-[12px] text-error-text">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creando…" : "Crear usuario"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type ScreenNode = { key: string; label: string; href: string };
type ScreenModule = { module: string; screens: ScreenNode[] };

function EditRolesModal({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: User;
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [roleKeys, setRoleKeys] = useState<string[]>(user.roles.map((r) => r.role.key));
  const [saving, setSaving] = useState(false);
  // Árbol de pantallas + acceso del empleado.
  const [tree, setTree] = useState<ScreenModule[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [roleScreens, setRoleScreens] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [t, a] = await Promise.all([
        authFetch("/auth/screens").then((r) => r.json()),
        authFetch(`/auth/users/${user.id}/access`).then((r) => r.json()),
      ]);
      if (!alive) return;
      setTree(t);
      setChecked(new Set<string>(a.effective));
      setRoleScreens(new Set<string>(a.roleScreens));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [authFetch, user.id]);

  function toggleRole(key: string) {
    setRoleKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }
  function toggleScreen(key: string) {
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }
  function toggleModule(mod: ScreenModule, on: boolean) {
    setChecked((prev) => {
      const n = new Set(prev);
      for (const s of mod.screens) (on ? n.add(s.key) : n.delete(s.key));
      return n;
    });
  }

  async function save() {
    setSaving(true);
    // 1) Rol base primero (mueve el baseline). 2) Pantallas (calcula overrides vs. el nuevo rol).
    const r1 = await authFetch(`/auth/users/${user.id}/roles`, { method: "PATCH", body: JSON.stringify({ roleKeys }) });
    const r2 = await authFetch(`/auth/users/${user.id}/screens`, { method: "PATCH", body: JSON.stringify({ screens: [...checked] }) });
    if (r1.ok && r2.ok) onSaved();
    else setSaving(false);
  }

  const overrideCount = tree
    .flatMap((m) => m.screens)
    .filter((s) => checked.has(s.key) !== roleScreens.has(s.key)).length;

  return (
    <Modal open title={`Accesos de ${user.name}`} onClose={onClose}>
      <div className="flex max-h-[26rem] flex-col gap-3 overflow-y-auto pr-1">
        {/* Rol base */}
        <div>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-text-tertiary">Rol base (plantilla)</div>
          {groupRolesByArea(roles).map(({ area, items }) => {
            const selected = items.filter((r) => roleKeys.includes(r.key)).length;
            return (
              <Collapsible key={area} title={area} badge={selected > 0 ? `${selected} de ${items.length}` : `${items.length}`} highlight={selected > 0} defaultOpen={selected > 0}>
                {items.map((r) => (
                  <label key={r.key} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-2">
                    <input type="checkbox" checked={roleKeys.includes(r.key)} onChange={() => toggleRole(r.key)} className="mt-0.5 accent-brand" />
                    <span className="flex flex-col leading-tight">
                      <span className="text-[13px] font-semibold text-text-primary">{r.name}</span>
                      <span className="text-[12px] text-text-tertiary">{r.description}</span>
                    </span>
                  </label>
                ))}
              </Collapsible>
            );
          })}
        </div>

        {/* Acceso por módulo / submódulo */}
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
            Acceso a módulos y pantallas
            {overrideCount > 0 && <Badge label={`${overrideCount} excepción${overrideCount === 1 ? "" : "es"}`} tone="warning" />}
          </div>
          <p className="mb-1.5 text-[12px] text-text-tertiary">
            Parte del rol base. Marca o desmarca pantallas para ajustar el acceso de este empleado; los cambios se guardan como excepciones suyas.
          </p>
          {loading ? (
            <p className="px-2 py-3 text-[12px] text-text-tertiary">Cargando pantallas…</p>
          ) : (
            tree.map((mod) => {
              const on = mod.screens.filter((s) => checked.has(s.key)).length;
              const all = on === mod.screens.length;
              return (
                <Collapsible key={mod.module} title={mod.module} badge={on > 0 ? `${on} de ${mod.screens.length}` : `${mod.screens.length}`} highlight={on > 0} defaultOpen={false}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={all}
                      ref={(el) => { if (el) el.indeterminate = on > 0 && !all; }}
                      onChange={() => toggleModule(mod, !all)}
                      className="accent-brand"
                    />
                    <span className="text-[12px] font-semibold text-text-secondary">Todo el módulo</span>
                  </label>
                  {mod.screens.map((s) => {
                    const isChecked = checked.has(s.key);
                    const fromRole = roleScreens.has(s.key);
                    const diff = isChecked !== fromRole;
                    return (
                      <label key={s.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 pl-6 hover:bg-surface-2">
                        <input type="checkbox" checked={isChecked} onChange={() => toggleScreen(s.key)} className="accent-brand" />
                        <span className={`text-[13px] ${isChecked ? "text-text-primary" : "text-text-tertiary"}`}>{s.label}</span>
                        {diff && <span className={`ml-auto text-[10px] font-semibold ${isChecked ? "text-success-text" : "text-warning-text"}`}>{isChecked ? "+ extra" : "revocado"}</span>}
                      </label>
                    );
                  })}
                </Collapsible>
              );
            })
          )}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving || loading}>{saving ? "Guardando…" : "Guardar cambios"}</Button>
      </div>
    </Modal>
  );
}

/** Editar datos básicos (nombre/correo) y restablecer la contraseña de un usuario. */
function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [sedesAccede, setSedesAccede] = useState<number[]>(user.sedesAccede ?? []);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await authFetch(`/auth/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, email, sedesAccede }),
    });
    setSaving(false);
    if (res.ok) {
      toast("Datos actualizados", "check");
      onSaved();
    } else {
      const body = await res.json().catch(() => null);
      setError(Array.isArray(body?.message) ? body.message.join(", ") : body?.message ?? "No se pudo guardar");
    }
  }

  async function resetPassword() {
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    setSaving(true);
    setError("");
    const res = await authFetch(`/auth/users/${user.id}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setSaving(false);
    if (res.ok) {
      setPassword("");
      toast("Contraseña restablecida", "check");
    } else {
      const body = await res.json().catch(() => null);
      setError(Array.isArray(body?.message) ? body.message.join(", ") : body?.message ?? "No se pudo restablecer");
    }
  }

  return (
    <Modal open title={`Editar ${user.name}`} onClose={onClose}>
      <form onSubmit={saveProfile} className="flex flex-col gap-3">
        <Field label="Nombre completo">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Correo">
          <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <SedesAccedeField value={sedesAccede} onChange={setSedesAccede} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Guardando…" : "Guardar datos"}
          </Button>
        </div>
      </form>

      <div className="my-4 border-t border-border-subtle" />

      <div className="flex flex-col gap-3">
        <Field
          label="Restablecer contraseña"
          hint="Define una contraseña nueva (mínimo 8). Compártela con el usuario por un canal seguro."
        >
          <PasswordInput value={password} onChange={setPassword} placeholder="Nueva contraseña" />
        </Field>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" size="sm" onClick={() => void resetPassword()} disabled={saving || !password}>
            <Icon name="key-round" size={14} /> Restablecer contraseña
          </Button>
        </div>
      </div>

      {error && <p className="mt-3 text-[12px] text-error-text">{error}</p>}
      <div className="mt-4 flex justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      </div>
    </Modal>
  );
}

type CatalogPerm = { key: string; label: string; group: string };
const ROLE_AREA_OPTIONS = ["Personalizados", "Áreas Vestel", "Administración", "Inventario", "Recursos Humanos", "Contabilidad", "SST"];

/**
 * Constructor de roles: crea un rol personalizado (o edita/clona uno) marcando
 * qué permisos concede. El rol pasa a ser una plantilla reutilizable al crear
 * usuarios. Solo se monta para el superusuario.
 */
function RoleBuilderModal({
  mode,
  source,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  source: Role | null; // edit → rol a editar; create+source → clonar; create sin source → en blanco
  onClose: () => void;
  onSaved: (roles: Role[]) => void;
}) {
  const { authFetch } = useAuth();
  const cloning = mode === "create" && !!source;
  const [name, setName] = useState(source ? (cloning ? `${source.name} (copia)` : source.name) : "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [area, setArea] = useState(mode === "edit" ? source?.area ?? "Personalizados" : "Personalizados");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(source?.permissions.map((p) => p.permission.key) ?? []));
  const [catalog, setCatalog] = useState<CatalogPerm[]>([]);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authFetch("/auth/permissions").then((r) => r.json()).then(setCatalog).catch(() => setError("No se pudo cargar el catálogo de permisos."));
  }, [authFetch]);

  // Agrupa el catálogo por `group`, conservando el orden de aparición.
  const groups: { group: string; perms: CatalogPerm[] }[] = [];
  const ql = q.trim().toLowerCase();
  for (const p of catalog) {
    if (ql && !p.label.toLowerCase().includes(ql) && !p.key.toLowerCase().includes(ql)) continue;
    let g = groups.find((x) => x.group === p.group);
    if (!g) { g = { group: p.group, perms: [] }; groups.push(g); }
    g.perms.push(p);
  }

  function toggle(key: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleGroup(perms: CatalogPerm[], on: boolean) {
    setSelected((prev) => { const n = new Set(prev); for (const p of perms) on ? n.add(p.key) : n.delete(p.key); return n; });
  }

  async function submit() {
    setError(null);
    if (!name.trim()) { setError("Escribe un nombre para el rol."); return; }
    if (selected.size === 0) { setError("Marca al menos un permiso."); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({ name: name.trim(), description: description.trim() || undefined, area, permissions: [...selected] });
      const res = mode === "edit" && source
        ? await authFetch(`/auth/roles/${source.id}`, { method: "PATCH", body })
        : await authFetch("/auth/roles", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar el rol");
      onSaved(data);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }

  const title = mode === "edit" ? `Editar rol · ${source?.name}` : cloning ? `Clonar rol · ${source?.name}` : "Nuevo rol";

  return (
    <Modal open title={title} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Nombre del rol" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Técnico junior" autoFocus />
          </Field>
          <Field label="Grupo">
            <select value={area} onChange={(e) => setArea(e.target.value)}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[13px] text-text-primary">
              {ROLE_AREA_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Descripción">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve este rol" />
        </Field>

        {/* Selector de permisos */}
        <div className="rounded-lg border border-border-subtle">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <Icon name="key-round" size={13} className="text-text-tertiary" />
            <span className="text-[12px] font-semibold text-text-secondary">Permisos ({selected.size} seleccionados)</span>
            <div className="relative ml-auto">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar…" className="h-7 w-40 py-1 text-[12px]" />
            </div>
          </div>
          <div className="max-h-[45vh] overflow-y-auto p-2">
            {groups.length === 0 ? (
              <p className="px-2 py-4 text-center text-[12px] text-text-tertiary">Sin permisos que coincidan.</p>
            ) : groups.map(({ group, perms }) => {
              const allOn = perms.every((p) => selected.has(p.key));
              const someOn = !allOn && perms.some((p) => selected.has(p.key));
              return (
                <div key={group} className="mb-1.5">
                  <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                    <button type="button" onClick={() => toggleGroup(perms, !allOn)}
                      className={`flex h-4 w-4 items-center justify-center rounded border ${allOn ? "border-brand bg-brand text-on-brand" : someOn ? "border-brand bg-brand-soft" : "border-border-subtle bg-surface"}`}
                      aria-label={`Marcar todo ${group}`}>
                      {allOn && <Icon name="check" size={11} />}
                      {someOn && <span className="h-0.5 w-2 rounded bg-brand" />}
                    </button>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{group}</span>
                    <span className="ml-auto text-[10px] text-text-tertiary">{perms.filter((p) => selected.has(p.key)).length}/{perms.length}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                    {perms.map((p) => (
                      <label key={p.key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2">
                        <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} className="accent-brand" />
                        <span className="text-[12px] text-text-primary" title={p.key}>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {error && <p className="text-[12px] text-error-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={saving || !name.trim() || selected.size === 0}>
            {saving ? "Guardando…" : mode === "edit" ? "Guardar cambios" : "Crear rol"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function UsuariosPage() {
  return (
    <PermissionGate required="system.users.manage">
      <UsersAdmin />
    </PermissionGate>
  );
}
