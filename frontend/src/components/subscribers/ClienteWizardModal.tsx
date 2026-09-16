"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { fullCurrency } from "@/lib/format";
import { type Bundle, type Plan, type ServiceKind, SERVICE_KIND_LABEL } from "@/lib/plans";
// Las casillas de la dirección (y sus catálogos encadenados) viven aparte: las
// comparte con la orden de traslado, que captura a dónde se muda el cliente.
import { DireccionFields, NOM_KEYS, direccionArmada } from "@/components/subscribers/DireccionFields";
import { CUSTOMER_TYPES, DOC_TYPES, SUSCRIPCIONES, ESTRATOS, INSTALL_TECHS } from "@/lib/subscribers";

type Branch = { id: string; name: string };

/**
 * Una afiliación del catálogo (`GET /subscribers/afiliaciones`).
 *
 * La afiliación es lo que se le cobra al cliente el día que entra —y lo ÚNICO que se le
 * cobra: la mensualidad arranca el 1º del mes siguiente, por la corrida—. Son productos
 * de contabilidad con precios distintos (Combo 70.000, Villavo 50.000, Dedicado 300.000),
 * así que se eligen del catálogo, no se escriben a mano.
 */
type Afiliacion = { id: string; name: string; price: number; taxRate: number };

/**
 * Espejo de `backend/src/subscribers/conexion-alta.ts`.
 *
 * El alta ya NO pregunta por los datos de conexión: el servidor los deriva del
 * propio cliente (nombre completo pegado en mayúsculas como usuario, número de
 * documento como clave), que es la convención de siempre y la que traen los
 * abonados importados del legacy. Se repite el cálculo aquí SÓLO para enseñar en
 * pantalla lo que se va a crear; el valor bueno lo pone el backend, que además
 * numera la variante (`JUANPEREZ2`) si el nombre ya está tomado.
 */
const soloLetrasYNumeros = (v: string) =>
  v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Usuario PPPoE: los cuatro trozos del nombre pegados (o la razón social). */
function usuarioPppDe(p: Record<string, any>): string {
  const persona = [p.firstName, p.secondName, p.lastName1, p.lastName2]
    .map((s) => soloLetrasYNumeros(String(s ?? "").trim()))
    .join("");
  return persona || soloLetrasYNumeros(String(p.companyName ?? "").trim());
}

/** Clave PPPoE: el documento sin puntos ni espacios. */
const clavePppDe = (doc: any) => String(doc ?? "").replace(/[^A-Za-z0-9]/g, "");

/** Etiqueta comercial de la única tecnología que se vende hoy (backend: GPON). */
const ETIQUETA_FTTH = "FTTH (fibra óptica)";

/** Orden en que se ofrecen los servicios del catálogo (igual que CambiarPlanModal). */
const KIND_ORDER: ServiceKind[] = ["INTERNET", "TV", "PUNTOS", "STREAMING"];

const EMPTY: Record<string, any> = {
  abonado: "", firstName: "", secondName: "", lastName1: "", lastName2: "", companyName: "",
  customerType: "", docType: "CC", docNumber: "", email: "", phone1: "", phone2: "",
  birthDate: "", estrato: "", suscripcion: "", contractDate: "",
  departmentRef: "", cityRef: "", localityRef: "", neighborhood: "", addressLine: "",
  clausula: "", gpsLat: "", gpsLng: "", branchId: "",
  pppUsername: "", pppPassword: "", pppProfile: "", ipRemote: "", installTech: "",
  ipLocal: "", macEquipo: "", macOnt: "", netComment: "", vlan: "", vlanCargada: "",
  // Alta completa: qué se hace además de guardar la ficha. Por defecto TODO,
  // que es lo que se espera de un alta (y lo que no pasaba antes).
  provision: true, firstInvoice: true, installOrder: true, installCharge: "",
  // "" = la que propone el sistema según el plan; el precio vacío = el del catálogo.
  affiliationId: "", affiliationPrice: "",
  ...Object.fromEntries(NOM_KEYS.map((k) => [k, ""])),
};

const dateInput = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const str = (v: any) => (v == null ? "" : String(v));

const STEPS = ["Datos personales", "Ubicación / dirección", "Plan y conexión", "Revisión"];

/** Resultado de un paso del alta que devuelve el backend (ver AltaClienteService). */
type PasoAlta = { hecho: boolean; motivo?: string; resultado?: any };
type ResultadoAlta = {
  id: string; abonado: number;
  planes: PasoAlta; router: PasoAlta; factura: PasoAlta; orden: PasoAlta;
};

/** Resultado del chequeo de duplicados del backend. */
type DupCheck = {
  document?: { count: number; message: string | null } | null;
  address?: { count: number; message: string | null } | null;
  pppUsername?: { taken: boolean; router: string; message: string } | null;
};

export function ClienteWizardModal({
  mode, subscriberId, open, onClose, onDone,
}: {
  mode: "create" | "edit";
  subscriberId?: string;
  open: boolean;
  onClose: () => void;
  onDone: (id?: string) => void;
}) {
  const { authFetch } = useAuth();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Record<string, any>>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [clausulas, setClausulas] = useState<{ legacyId: number | null; nombre: string; meses: number }[]>([]);
  const [dup, setDup] = useState<DupCheck>({});
  const [checkingPpp, setCheckingPpp] = useState(false);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  /** Plan elegido por tipo de servicio: kind → planId ("" = ninguno). */
  const [planSel, setPlanSel] = useState<Record<string, string>>({});
  /** Combos que se pueden vender hoy (vacío = no hay ninguno armado). */
  const [bundles, setBundles] = useState<Bundle[]>([]);
  /** Se contrata plan a plan o un combo cerrado. Arranca en "sueltos". */
  const [modoVenta, setModoVenta] = useState<"sueltos" | "combo">("sueltos");
  const [comboSel, setComboSel] = useState("");
  /** Catálogo de afiliaciones (lo que se cobra al entrar). */
  const [afiliaciones, setAfiliaciones] = useState<Afiliacion[]>([]);
  /** Lo que hizo el alta, para contarlo en vez de cerrar y dejarlo a la fe. */
  const [alta, setAlta] = useState<ResultadoAlta | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  /**
   * Chequeo de duplicados contra el servidor. Documento y dirección sólo AVISAN (igual que
   * el legacy: el mismo titular puede tener varias cuentas y la facturación electrónica las
   * mapea a sucursales de Siigo). El usuario PPP sí bloquea el guardado.
   */
  const checkDup = useCallback(
    async (payload: Record<string, any>) => {
      try {
        const res = await authFetch("/subscribers/check-duplicates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return;
        const d = await res.json();
        setDup((prev) => ({ ...prev, ...d }));
      } catch { /* el chequeo es informativo; nunca debe frenar el wizard */ }
    },
    [authFetch],
  );

  const geo = useCallback(
    (path: string) => authFetch(path).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    [authFetch],
  );

  // Cargar catálogos base + precargar (edición) al abrir.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAlta(null);
    setPlanSel({});
    setModoVenta("sueltos");
    setComboSel("");
    // Las afiliaciones no cuelgan de /billing/catalog a propósito: el alta también la
    // hacen administración y técnicos, que no tienen el área de facturación.
    void geo("/subscribers/afiliaciones").then((d: { items?: Afiliacion[] } | Afiliacion[]) =>
      setAfiliaciones(Array.isArray(d) ? d : (d?.items ?? [])),
    );
    // El catálogo de planes es de donde sale el perfil/velocidad del router Y el
    // precio que se factura: por eso el alta elige plan y no escribe un perfil a mano.
    void geo("/plans?activeOnly=true").then(setPlans);
    void geo("/plan-bundles?activeOnly=true").then((bs: Bundle[]) => setBundles(Array.isArray(bs) ? bs : []));
    // El catálogo llega acotado a las sedes del usuario. Si sólo tiene una (la
    // cajera), se elige sola: no hay decisión que tomar y dejarla en "—" sólo
    // conseguiría que el alta fallara con un 403 por no indicar sede.
    void geo("/subscribers/branches").then((bs: Branch[]) => {
      setBranches(bs);
      if (bs.length === 1) setF((p) => (p.branchId ? p : { ...p, branchId: bs[0].id }));
    });
    // Solo las activas: el catálogo puede tener cláusulas retiradas que siguen
    // imprimiéndose en contratos viejos pero ya no se ofrecen en un alta.
    void geo("/clausulas?soloActivas=1").then(setClausulas);

    if (mode === "edit" && subscriberId) {
      void authFetch(`/subscribers/${subscriberId}/form`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          const nom = (d.nomenclature ?? {}) as Record<string, any>;
          setF({
            ...EMPTY,
            abonado: str(d.abonado), firstName: str(d.firstName), secondName: str(d.secondName),
            lastName1: str(d.lastName1), lastName2: str(d.lastName2), companyName: str(d.companyName),
            customerType: str(d.customerType), docType: str(d.docType) || "CC", docNumber: str(d.docNumber),
            email: str(d.email), phone1: str(d.phone1), phone2: str(d.phone2),
            birthDate: dateInput(d.birthDate), estrato: str(d.estrato), suscripcion: str(d.suscripcion),
            contractDate: dateInput(d.contractDate), departmentRef: str(d.departmentRef), cityRef: str(d.cityRef),
            localityRef: str(d.localityRef), neighborhood: str(d.neighborhood), addressLine: str(d.addressLine),
            clausula: str(d.clausula), gpsLat: str(d.gpsLat), gpsLng: str(d.gpsLng), branchId: str(d.branchId),
            pppUsername: str(d.pppUsername), pppPassword: str(d.pppPassword), pppProfile: str(d.pppProfile),
            ipRemote: str(d.ipRemote), installTech: str(d.installTech),
            ipLocal: str(d.ipLocal), macEquipo: str(d.macEquipo), macOnt: str(d.macOnt),
            // `vlanCargada` guarda la VLAN tal como vino para saber si se TOCÓ. Sin eso
            // habría que mandarla en cada guardado, y reescribir el comentario a ciegas
            // estropea los que no siguen la receta ("VILLA LUCIA 3362 VLAN -- FTTH"
            // perdería el "VLAN --" sin que nadie lo hubiera pedido).
            netComment: str(d.netComment), vlan: str(d.vlan), vlanCargada: str(d.vlan),
            ...Object.fromEntries(NOM_KEYS.map((k) => [k, str(nom[k])])),
          });
        })
        .catch(() => toast("No se pudo cargar el cliente", "alert-circle"));
    } else {
      setF(EMPTY);
    }
  }, [open, mode, subscriberId, authFetch, geo]);

  // Validación de campos obligatorios (paso 1) — igual que los `required` del legacy.
  // La razón social solo aplica a empresas/entidades (o si ya trae valor guardado).
  const showCompany = ["Juridico", "Gubernamental", "Militar"].includes(f.customerType) || !!f.companyName?.trim();

  // Planes agrupados por tipo de servicio, en el orden en que se ofrecen.
  const byKind = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of plans ?? []) {
      if (!map.has(p.kind)) map.set(p.kind, []);
      map.get(p.kind)!.push(p);
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => ({ kind: k, plans: map.get(k)! }));
  }, [plans]);

  const planIds = useMemo(() => Object.values(planSel).filter(Boolean), [planSel]);
  const comboElegido = useMemo(() => bundles.find((b) => b.id === comboSel) ?? null, [bundles, comboSel]);
  const usaCombo = modoVenta === "combo" && comboElegido !== null;
  /**
   * Los planes que se van a contratar, vengan de los desplegables o de dentro
   * de un combo. De aquí sale el perfil que se le escribe al router, que es el
   * mismo mande quien mande.
   */
  const planesElegidos = useMemo(() => {
    const ids = usaCombo ? comboElegido!.items.map((it) => it.planId) : planIds;
    return ids.map((id) => (plans ?? []).find((p) => p.id === id)).filter(Boolean) as Plan[];
  }, [usaCombo, comboElegido, planIds, plans]);
  // En un combo la mensualidad NO es la suma de los planes de lista: es lo que
  // cobra el paquete.
  const mensualidad = usaCombo ? comboElegido!.total : planesElegidos.reduce((s, p) => s + p.price, 0);
  const cargoInstalacion = Number(f.installCharge || 0);

  /**
   * Afiliación que se propone según lo contratado — espejo de `nombreSugerido()` en
   * `backend/src/subscribers/afiliacion.ts`. Los tres casos cubren casi todas las altas;
   * el resto (Villavo, Dedicado, Streaming) se elige a mano del desplegable.
   */
  const afiliacionSugerida = useMemo(() => {
    const kinds = new Set(planesElegidos.map((p) => p.kind));
    const nombre = kinds.has("INTERNET") && kinds.has("TV") ? "Afiliación Combo"
      : kinds.has("INTERNET") ? "Afiliación Internet solo"
      : kinds.has("TV") ? "Afiliación Television"
      : null;
    if (!nombre) return null;
    const sinTildes = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return afiliaciones.find((a) => sinTildes(a.name) === sinTildes(nombre)) ?? null;
  }, [planesElegidos, afiliaciones]);

  /** La que se va a cobrar: la elegida a mano, o la propuesta. */
  const afiliacion = useMemo(
    () => afiliaciones.find((a) => a.id === f.affiliationId) ?? afiliacionSugerida,
    [afiliaciones, f.affiliationId, afiliacionSugerida],
  );
  /** Precio a cobrar: el que se escribió encima, o el del catálogo. */
  const precioAfiliacion = f.affiliationPrice === "" ? (afiliacion?.price ?? 0) : Number(f.affiliationPrice || 0);
  /** Lo que va a decir la factura de afiliación. */
  const totalAfiliacion = precioAfiliacion + cargoInstalacion;

  /**
   * El perfil del router lo pone el plan de internet, no la mano: es lo que
   * `provision` escribe en el `/ppp/secret`. Se refleja en el formulario para que
   * se vea qué se va a mandar (el backend lo vuelve a fijar desde el plan igual).
   */
  const perfilDelPlan = planesElegidos.find((p) => p.kind === "INTERNET")?.pppProfile ?? "";

  /**
   * Conexión del alta, deducida del cliente. No es un campo del formulario: se
   * calcula para poder enseñarla antes de crear (el backend la vuelve a derivar
   * igual, ver `credencialesPpp`).
   */
  const pppAuto = {
    usuario: usuarioPppDe(f),
    clave: clavePppDe(f.docNumber),
  };
  /** Usuario PPP que va a tener el cliente: derivado al crear, el suyo al editar. */
  const usuarioPpp = mode === "create" ? pppAuto.usuario : f.pppUsername;
  useEffect(() => {
    if (perfilDelPlan) setF((p) => (p.pppProfile === perfilDelPlan ? p : { ...p, pppProfile: perfilDelPlan }));
  }, [perfilDelPlan]);

  const missing: string[] = [];
  if (!f.firstName.trim()) missing.push("1er nombre");
  if (!f.lastName1.trim()) missing.push("1er apellido");
  if (!f.phone1.trim()) missing.push("celular");
  if (!f.email.trim()) missing.push("correo");
  if (!f.birthDate) missing.push("nacimiento");

  function buildPayload() {
    const nomenclature = Object.fromEntries(NOM_KEYS.map((k) => [k, f[k] || null]));
    return {
      firstName: f.firstName, secondName: f.secondName, lastName1: f.lastName1, lastName2: f.lastName2,
      companyName: f.companyName, customerType: f.customerType || undefined, docType: f.docType,
      docNumber: f.docNumber, email: f.email, phone1: f.phone1, phone2: f.phone2, birthDate: f.birthDate,
      estrato: f.estrato, suscripcion: f.suscripcion || undefined, contractDate: f.contractDate || undefined,
      // "" = sin permanencia, y eso hay que poder GUARDARLO: mandar undefined
      // dejaría puesta la cláusula anterior al quitarla en una edición.
      clausula: f.clausula === "" ? null : Number(f.clausula),
      departmentRef: f.departmentRef, cityRef: f.cityRef, localityRef: f.localityRef, neighborhood: f.neighborhood,
      addressLine: f.addressLine, branchId: f.branchId || undefined, nomenclature,
      // Conectividad (legacy `create.php`: name_s, contra, perfil, Ipremota, tegnologia).
      // Al CREAR no se manda ninguno: el backend deriva usuario/clave del cliente,
      // pone la tecnología (FTTH) y deja que `provision` reparta la IP libre. Al
      // EDITAR sí viajan, que es donde se corrigen a mano los abonados viejos.
      ...(mode === "edit"
        ? {
            pppUsername: f.pppUsername || undefined, pppPassword: f.pppPassword || undefined,
            pppProfile: f.pppProfile || undefined, ipRemote: f.ipRemote || undefined,
            installTech: f.installTech || undefined,
            // Éstos SÍ viajan vacíos: son datos que el legacy trajo mal capturados
            // (una MAC de otro equipo, un comentario con la VLAN de otro barrio) y
            // borrarlos es una corrección tan válida como cambiarlos. En el backend
            // "" se guarda como null (ver PROFILE_STR_FIELDS).
            ipLocal: f.ipLocal, macEquipo: f.macEquipo, macOnt: f.macOnt,
            netComment: f.netComment,
            // La VLAN sólo si se tocó: va dentro del comentario, y reescribirlo
            // cuando nadie lo pidió cambia texto que no es nuestro.
            ...(String(f.vlan) !== String(f.vlanCargada)
              ? { vlan: f.vlan === "" ? null : Number(f.vlan) }
              : {}),
          }
        : { pppProfile: f.pppProfile || undefined }),
      // Alta completa (sólo al crear: en una edición estos pasos ya pasaron o se
      // hacen desde la ficha, y repetirlos duplicaría factura y orden).
      ...(mode === "create"
        ? {
            // El combo manda: el backend saca sus planes y sus precios de ahí.
            ...(usaCombo ? { bundleId: comboSel } : { planIds: planIds.length ? planIds : undefined }),
            provision: !!f.provision,
            firstInvoice: !!f.firstInvoice,
            // La afiliación es lo que se cobra al entrar (la mensualidad la cobra la
            // corrida del mes siguiente). Sin elección explícita la deduce el backend
            // del plan contratado, igual que `afiliacionSugerida` aquí.
            affiliationId: f.affiliationId || undefined,
            affiliationPrice: f.affiliationPrice === "" ? undefined : precioAfiliacion,
            installCharge: cargoInstalacion > 0 ? cargoInstalacion : undefined,
            installOrder: !!f.installOrder,
          }
        : {}),
    };
  }

  async function submit() {
    if (missing.length) { setStep(0); toast(`Faltan campos: ${missing.join(", ")}`, "alert-circle"); return; }
    setSaving(true);
    try {
      const payload = buildPayload();
      const url = mode === "edit" ? `/subscribers/${subscriberId}` : `/subscribers`;
      const res = await authFetch(url, { method: mode === "edit" ? "PATCH" : "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(Array.isArray(m?.message) ? m.message[0] : m?.message ?? "No se pudo guardar");
      }
      const out = await res.json().catch(() => ({}));
      // Al editar, el servidor lleva los datos de conexión al Mikrotik (comentario,
      // IP remota, perfil, usuario/clave; las MAC no van al router). Si eso falló hay
      // que decirlo: la ficha quedó guardada pero el abonado sigue como estaba en la red.
      const router = out.router as { ok: boolean; dryRun: boolean; message?: string } | undefined;
      if (router && !router.ok) {
        toast(router.message ?? "Los datos se guardaron, pero no llegaron al router", "alert-circle");
      } else {
        toast(
          mode === "edit"
            ? router
              ? `Cliente actualizado · ${router.dryRun ? "router en simulación" : "sincronizado con el Mikrotik"}`
              : "Cliente actualizado"
            : `Cliente creado (abonado ${out.abonado ?? ""})`,
        );
      }
      onDone(out.id ?? subscriberId);
      // En el alta NO se cierra: el alta son cuatro pasos (plan, router, factura,
      // orden) y alguno puede haber fallado —el router típicamente—. Cerrar de
      // golpe es como se llegaba a clientes creados "bien" que no existían en el
      // Mikrotik. Se muestra el parte y el usuario cierra.
      if (mode === "create") setAlta(out as ResultadoAlta);
      else onClose();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al guardar", "alert-circle");
    } finally {
      setSaving(false);
    }
  }

  // Parte del alta: qué quedó hecho y qué no. Sustituye al wizard una vez creado.
  if (alta) {
    return (
      <Modal open={open} onClose={onClose} title={`Cliente creado — abonado ${alta.abonado}`} maxWidth="max-w-3xl">
        <div className="flex flex-col gap-2">
          <PasoResultado
            icono="package"
            titulo="Plan contratado"
            paso={alta.planes}
            ok={(r: any[]) => `${r.map((p) => p.name).join(" + ")} · lo factura la corrida mensual desde el mes que viene.`}
          />
          <PasoResultado
            icono="router"
            titulo="Alta en el Mikrotik"
            paso={alta.router}
            ok={(r: any) => {
              const ip = (r?.steps ?? []).find((s: string) => s.startsWith("IP asignada"));
              const base = r?.dryRun ? `SIMULADO (dry-run): ${r.message}` : r?.message ?? "Secret creado.";
              return ip ? `${base} · ${ip}` : base;
            }}
            tono={alta.router.resultado?.dryRun ? "warning" : undefined}
          />
          <PasoResultado
            icono="file-text"
            titulo="Factura de afiliación"
            paso={alta.factura}
            ok={(r: any) => `Factura #${r.tid} · ${r.afiliacion ?? "afiliación"} por ${fullCurrency(r.total)}. Al pagarla se abre sola la orden de instalación.`}
          />
          <PasoResultado
            icono="clipboard-list"
            titulo="Orden de instalación"
            paso={alta.orden}
            ok={(r: any) =>
              r?.esperandoPago
                ? "Queda a la espera del pago de la factura de afiliación: en cuanto entre el pago, la orden se abre sola y le llega al encargado de soporte."
                : `Orden #${r?.code} abierta.`
            }
            tono={alta.orden.resultado?.esperandoPago ? "warning" : undefined}
            etiqueta={alta.orden.resultado?.esperandoPago ? "AL PAGAR" : undefined}
          />
          <p className="text-[12px] text-text-tertiary">
            Lo que no haya quedado se puede rehacer desde la ficha del cliente (Cambiar plan,
            o Mikrotik → Dar de alta) sin volver a crearlo.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cerrar</Button>
            <Button onClick={() => { onDone(alta.id); onClose(); }}>Ver el cliente</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === "edit" ? "Editar cliente" : "Nuevo cliente"} maxWidth="max-w-3xl">
      {/* Barra de pasos */}
      <div className="mb-1 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(i)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors ${
              i === step ? "bg-brand text-on-brand" : "bg-surface-2 text-text-secondary hover:brightness-95"
            }`}
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i === step ? "bg-white/25" : "bg-border-subtle"}`}>{i + 1}</span>
            <span className="hidden sm:inline">{s}</span>
          </button>
        ))}
      </div>

      {/* Paso 1 — human-first: nombre → documento → contacto → clasificación */}
      {step === 0 && (
        <div className="flex flex-col gap-4">
          <Section title="Nombre">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="1er nombre *"><Input value={f.firstName} onChange={set("firstName")} autoFocus /></Field>
              <Field label="2º nombre"><Input value={f.secondName} onChange={set("secondName")} /></Field>
              <Field label="1er apellido *"><Input value={f.lastName1} onChange={set("lastName1")} /></Field>
              <Field label="2º apellido"><Input value={f.lastName2} onChange={set("lastName2")} /></Field>
            </div>
          </Section>

          <Section title="Documento e identificación">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Tipo cliente"><Select value={f.customerType} onChange={set("customerType")}><option value="">—</option>{CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="Tipo doc."><Select value={f.docType} onChange={set("docType")}>{DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="N° documento"><Input value={f.docNumber} onChange={set("docNumber")} /></Field>
              {showCompany && <Field label="Empresa / razón social"><Input value={f.companyName} onChange={set("companyName")} /></Field>}
            </div>
          </Section>

          <Section title="Contacto">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Celular *"><Input value={f.phone1} onChange={set("phone1")} inputMode="tel" /></Field>
              <Field label="Celular (adi)"><Input value={f.phone2} onChange={set("phone2")} inputMode="tel" /></Field>
              <div className="col-span-2"><Field label="Correo *"><Input value={f.email} onChange={set("email")} type="email" /></Field></div>
            </div>
          </Section>

          <Section title="Clasificación y contrato">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Nacimiento *"><Input value={f.birthDate} onChange={set("birthDate")} type="date" /></Field>
              <Field label="Estrato"><Select value={f.estrato} onChange={set("estrato")}><option value="">—</option>{ESTRATOS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="Suscripción"><Select value={f.suscripcion} onChange={set("suscripcion")}><option value="">—</option>{SUSCRIPCIONES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="Fecha contrato"><Input value={f.contractDate} onChange={set("contractDate")} type="date" /></Field>
              <div className="col-span-2">
                <Field label="Cláusula de permanencia" hint="Lo que paga el cliente si se retira antes de tiempo. Sin cláusula puede irse cuando quiera.">
                  <Select value={f.clausula} onChange={set("clausula")}>
                    <option value="">Sin permanencia</option>
                    {clausulas.map((c) => (
                      <option key={c.legacyId ?? c.nombre} value={String(c.legacyId ?? "")}>
                        {c.nombre} · {c.meses} meses
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          </Section>
        </div>
      )}

      {/* Paso 2 — Sede/zona → dirección → adicionales */}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <Section title="Sede">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Sede"><Select value={f.branchId} onChange={set("branchId")}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            </div>
          </Section>

          <Section title="Zona y dirección">
            <DireccionFields
              value={f as Record<string, string>}
              onChange={(patch) => setF((p) => ({ ...p, ...patch }))}
              hintComercial="Las coordenadas GPS las registra el técnico en la instalación."
            />
          </Section>
        </div>
      )}

      {/* Paso 3 — plan contratado + conectividad (PPP / Mikrotik) */}
      {step === 2 && (
        <div className="flex flex-col gap-2">
          {mode === "create" && (
            <Section title="Plan contratado">
              <p className="mb-2 text-[12px] text-text-tertiary">
                El plan decide tres cosas a la vez: la <b>velocidad</b> (es el perfil que se
                escribe en el Mikrotik), el <b>precio</b> que se le factura cada mes y lo que
                lleva la primera factura. Sin plan el cliente nace sin servicio y la corrida
                mensual no lo factura.
              </p>
              {!plans && <p className="text-[12px] text-text-tertiary">Cargando planes…</p>}
              {plans && byKind.length === 0 && (
                <p className="text-[12px] text-text-tertiary">
                  No hay planes en el catálogo. Créalos en Configuración → Planes.
                </p>
              )}

              {bundles.length > 0 && (
                <Segmented
                  className="mb-2"
                  ariaLabel="Forma de contratación"
                  value={modoVenta}
                  onChange={setModoVenta}
                  options={[
                    { value: "sueltos", label: "Planes sueltos" },
                    { value: "combo", label: `Combos (${bundles.length})` },
                  ]}
                />
              )}

              {modoVenta === "combo" && (
                <div className="mb-2 flex flex-col gap-2">
                  <Select value={comboSel} onChange={(e) => setComboSel(e.target.value)}>
                    <option value="">— Elige un combo —</option>
                    {bundles.map((b) => (
                      <option key={b.id} value={b.id}>{b.name} — {fullCurrency(b.total)}/mes</option>
                    ))}
                  </Select>
                  {comboElegido && (
                    <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
                      {comboElegido.description && (
                        <p className="mb-1.5 text-[12px] text-text-tertiary">{comboElegido.description}</p>
                      )}
                      {comboElegido.items.map((it) => (
                        <div key={it.planId} className="flex items-baseline justify-between gap-2 text-[12.5px]">
                          <span className="truncate text-text-secondary">
                            <span className="text-text-tertiary">{SERVICE_KIND_LABEL[it.kind]}:</span> {it.planName}
                          </span>
                          <span className="shrink-0 font-mono text-text-primary">{fullCurrency(it.price)}</span>
                        </div>
                      ))}
                      {comboElegido.savings > 0 && (
                        <p className="mt-1.5 border-t border-border-subtle pt-1.5 text-right text-[11.5px] font-semibold text-success-text">
                          Ahorra {fullCurrency(comboElegido.savings)}/mes contra {fullCurrency(comboElegido.listTotal)} por separado
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${modoVenta === "combo" ? "hidden" : ""}`}>
                {byKind.map(({ kind, plans: kindPlans }) => {
                  const elegido = kindPlans.find((p) => p.id === planSel[kind]) ?? null;
                  return (
                    <Field key={kind} label={SERVICE_KIND_LABEL[kind]}>
                      <Select
                        value={planSel[kind] ?? ""}
                        onChange={(e) => setPlanSel((s) => ({ ...s, [kind]: e.target.value }))}
                      >
                        <option value="">— Sin {SERVICE_KIND_LABEL[kind].toLowerCase()} —</option>
                        {kindPlans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {fullCurrency(p.price)}/mes{p.pppProfile ? ` · ${p.pppProfile}` : ""}
                          </option>
                        ))}
                      </Select>
                      {elegido && !elegido.pppProfile && (
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          Este plan no trae perfil de router: sólo fija la mensualidad.
                        </p>
                      )}
                    </Field>
                  );
                })}
              </div>
              {planesElegidos.length > 0 && (
                <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
                  Mensualidad: <b className="text-text-primary">{fullCurrency(mensualidad)}</b>
                  {perfilDelPlan ? <> · perfil al router: <b className="text-text-primary">{perfilDelPlan}</b></> : null}
                </p>
              )}
            </Section>
          )}
          {/* La conexión al router no se pregunta al crear: el backend la deriva del
              cliente (usuario = nombre en mayúsculas, clave = documento, IP automática).
              Al EDITAR sí se puede escribir a mano, por los abonados viejos del legacy. */}
          {mode === "edit" && (
            <Section title="Conexión PPP">
              <p className="mb-2 text-[12px] text-text-tertiary">
                Sin usuario PPP el cliente no se puede aprovisionar en el Mikrotik. El nombre de
                usuario debe ser único: se valida contra la base de datos y contra el router de la sede.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Field label="Usuario PPP">
                  <Input
                    value={f.pppUsername}
                    onChange={set("pppUsername")}
                    onBlur={() => {
                      if (!f.pppUsername?.trim()) { setDup((p) => ({ ...p, pppUsername: null })); return; }
                      setCheckingPpp(true);
                      void checkDup({ pppUsername: f.pppUsername, branchId: f.branchId || undefined, installTech: f.installTech || undefined })
                        .finally(() => setCheckingPpp(false));
                    }}
                  />
                </Field>
                <Field label="Clave PPP"><Input value={f.pppPassword} onChange={set("pppPassword")} /></Field>
                <Field
                  label="Perfil / velocidad"
                  hint={perfilDelPlan ? "Lo pone el plan contratado." : "Sin plan de internet elegido; se puede escribir a mano."}
                >
                  <Input value={f.pppProfile} onChange={set("pppProfile")} readOnly={!!perfilDelPlan} />
                </Field>
                <Field label="IP remota" hint="Déjala vacía: se asigna sola al dar de alta en el router.">
                  <Input value={f.ipRemote} onChange={set("ipRemote")} placeholder="automática" />
                </Field>
                <Field label="Tecnología">
                  <Select value={f.installTech} onChange={set("installTech")}>
                    <option value="">— Seleccionar —</option>
                    {INSTALL_TECHS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </Field>
                <Field label="IP local" hint="La del concentrador; en blanco si el router la pone.">
                  <Input value={f.ipLocal} onChange={set("ipLocal")} placeholder="—" />
                </Field>
                {/* Las dos MAC de la ficha. La del CPE la escribe sola la asignación de
                    equipo, pero en los abonados viejos del legacy vino a mano y a veces
                    es la de otro equipo; la de la ONT casi nunca llegó. */}
                <Field label="MAC equipo" hint="La pone la asignación de equipo; aquí se corrige.">
                  <Input value={f.macEquipo} onChange={set("macEquipo")} placeholder="AA:BB:CC:DD:EE:FF" />
                </Field>
                <Field label="MAC ONT">
                  <Input value={f.macOnt} onChange={set("macOnt")} placeholder="AA:BB:CC:DD:EE:FF" />
                </Field>
                <Field label="VLAN" hint="1 a 4094. Se guarda dentro del comentario.">
                  <Input
                    type="number"
                    min={1}
                    max={4094}
                    value={f.vlan}
                    onChange={set("vlan")}
                    placeholder="sin VLAN"
                  />
                </Field>
              </div>
              {/* El comentario del secret, tal como lo escribe el legacy: barrio, número
                  de abonado, VLAN y tecnología ("MIRADOR 54519 VLAN 200 FTTH"). Se deja
                  editar entero porque lo escribió una persona y a veces dice más que la
                  receta; la casilla VLAN de arriba sólo cambia el número dentro. */}
              <Field label="Comentario de red" hint="Barrio, nº de abonado, VLAN y tecnología.">
                <Textarea
                  rows={2}
                  value={f.netComment}
                  onChange={set("netComment")}
                  placeholder="MIRADOR 54519 VLAN 200 FTTH"
                />
              </Field>
              {/* Que quede dicho: esto corrige el DATO, no la red. La VLAN por la que
                  navega de verdad la fija el service-port de la OLT. */}
              <p className="mt-1 text-[12px] text-text-tertiary">
                Cambiar la VLAN aquí corrige la ficha (y el legacy), no la configuración de
                la OLT: para mover la VLAN de verdad hay que tocar el service-port.
              </p>
              {checkingPpp && <p className="mt-2 text-[12px] text-text-tertiary">Verificando disponibilidad…</p>}
              {!checkingPpp && dup.pppUsername && (
                <div className={`mt-2 rounded-lg px-3 py-2 text-[12px] ${
                  dup.pppUsername.taken
                    ? "bg-error-soft text-error-text"
                    : dup.pppUsername.router === "unreachable"
                      ? "border border-warning-border bg-warning-soft text-text-secondary"
                      : "bg-success-soft text-success-text"
                }`}>
                  {dup.pppUsername.message}
                </div>
              )}
            </Section>
          )}
        </div>
      )}

      {/* Paso 4 — revisión */}
      {step === 3 && (
        <div className="flex flex-col gap-2 text-[13px]">
          {missing.length > 0 && (
            <div className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">Faltan campos obligatorios: {missing.join(", ")}.</div>
          )}
          {/* Avisos NO bloqueantes (paridad legacy: el mismo titular puede tener varias cuentas). */}
          {dup.document?.message && (
            <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-text-secondary">{dup.document.message}</div>
          )}
          {dup.address?.message && (
            <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-text-secondary">{dup.address.message}</div>
          )}
          {dup.pppUsername?.taken && (
            <div className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">{dup.pppUsername.message}</div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <Rev k="Nombre" v={[f.firstName, f.secondName, f.lastName1, f.lastName2].filter(Boolean).join(" ")} />
            <Rev k="Documento" v={`${f.docType} ${f.docNumber}`} />
            <Rev k="Celular" v={f.phone1} />
            <Rev k="Correo" v={f.email} />
            <Rev k="Nacimiento" v={f.birthDate} />
            <Rev k="Tipo cliente" v={f.customerType} />
            <Rev k="Suscripción" v={f.suscripcion} />
            <Rev k="Permanencia" v={clausulas.find((c) => String(c.legacyId) === String(f.clausula))?.nombre ?? "Sin permanencia"} />
            <Rev k="Estrato" v={f.estrato} />
            <Rev k="Dirección" v={direccionArmada(f as Record<string, string>)} />
            <Rev k="Barrio (id)" v={f.neighborhood} />
            <Rev k="Sede" v={branches.find((b) => b.id === f.branchId)?.name} />
            <Rev k="Usuario PPP" v={usuarioPpp} />
            <Rev k="Clave PPP" v={mode === "create" ? pppAuto.clave : f.pppPassword} />
            <Rev k="Tecnología" v={mode === "create" ? ETIQUETA_FTTH : f.installTech} />
            <Rev k="Perfil" v={perfilDelPlan || f.pppProfile} />
            <Rev k="IP remota" v={mode === "create" ? "automática" : f.ipRemote} />
            {mode === "edit" && (
              <>
                <Rev k="MAC equipo" v={f.macEquipo} />
                <Rev k="MAC ONT" v={f.macOnt} />
                <Rev k="VLAN" v={f.vlan} />
                <Rev k="Comentario de red" v={f.netComment} />
              </>
            )}
            {mode === "create" && (
              <>
                <Rev k="Plan(es)" v={planesElegidos.map((p) => p.name).join(" + ")} />
                <Rev k="Mensualidad" v={mensualidad > 0 ? `${fullCurrency(mensualidad)}/mes (desde el mes que viene)` : undefined} />
                <Rev k="Afiliación" v={f.firstInvoice && afiliacion ? `${afiliacion.name} · ${fullCurrency(precioAfiliacion)}` : undefined} />
              </>
            )}
          </div>

          {/* Qué se hace ADEMÁS de guardar la ficha. Se enseña y se puede quitar:
              un alta no es sólo la fila del cliente, y quien la hace tiene que ver
              lo que va a pasar antes de pulsar. */}
          {mode === "create" && (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Al crear el cliente</div>

              <Accion
                checked={!!f.provision}
                onChange={(v) => setF((p) => ({ ...p, provision: v }))}
                titulo="Darlo de alta en el Mikrotik"
                detalle={
                  pppAuto.usuario
                    ? `Crea el secret PPPoE "${pppAuto.usuario}"${perfilDelPlan ? ` con perfil ${perfilDelPlan}` : ""} en el router de la sede y le asigna una IP libre automáticamente.`
                    : "Necesita el nombre del cliente (paso 1): de ahí sale el usuario PPPoE."
                }
                disabled={!pppAuto.usuario}
              />

              <Accion
                checked={!!f.firstInvoice}
                onChange={(v) => setF((p) => ({ ...p, firstInvoice: v }))}
                titulo="Emitir la factura de afiliación"
                detalle={
                  afiliaciones.length === 0
                    ? "No se pudo cargar el catálogo de afiliaciones."
                    : totalAfiliacion > 0
                      ? `Por ${fullCurrency(totalAfiliacion)}${cargoInstalacion > 0 ? ` (afiliación + instalación ${fullCurrency(cargoInstalacion)})` : ""}. La mensualidad NO se cobra ahora: el mes en curso va incluido y la primera factura de ${fullCurrency(mensualidad)} sale el 1º del mes que viene.`
                      : "Sin cobro: no se emite factura y la orden de instalación se abre de una vez."
                }
                disabled={afiliaciones.length === 0}
              >
                {/* Lo que se cobra al entrar NO es la mensualidad: es la afiliación, un
                    producto del catálogo de contabilidad. Se propone la que toca según
                    el plan y se puede cambiar (Villavo, Dedicado, promociones…). */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Afiliación que se cobra">
                    <Select
                      value={f.affiliationId || afiliacion?.id || ""}
                      onChange={(e) => setF((p) => ({ ...p, affiliationId: e.target.value, affiliationPrice: "" }))}
                    >
                      {!afiliacion && <option value="">— elige una —</option>}
                      {afiliaciones.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} · {fullCurrency(a.price)}{a.id === afiliacionSugerida?.id ? " (la del plan)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={`Valor (catálogo: ${fullCurrency(afiliacion?.price ?? 0)})`}>
                    <Input
                      value={f.affiliationPrice}
                      onChange={set("affiliationPrice")}
                      inputMode="numeric"
                      placeholder={String(afiliacion?.price ?? 0)}
                    />
                  </Field>
                  <Field label="Cobro de instalación (opcional)">
                    <Input
                      value={f.installCharge}
                      onChange={set("installCharge")}
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </Field>
                </div>
              </Accion>

              <Accion
                checked={!!f.installOrder}
                onChange={(v) => setF((p) => ({ ...p, installOrder: v }))}
                titulo="Abrir la orden de instalación al pagar"
                detalle="La orden NO se abre ahora: nace sola en cuanto se pague la factura de afiliación, y de ahí le llega al encargado de soporte para que la reparta. Al cerrarla el cliente queda ACTIVO. (Sin factura que cobrar, se abre de una vez.)"
              />
            </div>
          )}
        </div>
      )}

      {/* Navegación */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={saving}><Icon name="arrow-left" size={15} /> Atrás</Button>}
          {step < STEPS.length - 1 ? (
            <Button
              onClick={() => {
                const next = step + 1;
                // Al entrar a la revisión, consultar duplicados de documento y dirección
                // (avisan, no bloquean).
                if (next === STEPS.length - 1) {
                  void checkDup({
                    docNumber: f.docNumber || undefined,
                    addressLine: f.addressLine || undefined,
                    departmentRef: f.departmentRef || undefined,
                    cityRef: f.cityRef || undefined,
                    localityRef: f.localityRef || undefined,
                    neighborhood: f.neighborhood || undefined,
                  });
                }
                setStep(next);
              }}
            >
              Siguiente <Icon name="arrow-right" size={15} /></Button>
          ) : (
            <Button onClick={submit} disabled={saving}>
              <Icon name={saving ? "loader" : "check"} size={15} className={saving ? "animate-spin" : ""} />
              {saving ? "Guardando…" : mode === "edit" ? "Guardar cambios" : "Crear cliente"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Sub-sección con título, separada por una línea guía y espacio (menos la primera). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border-subtle pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        <span className="h-1.5 w-1.5 rounded-full bg-brand" />
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * Una de las cosas que hace el alta además de guardar la ficha, con su
 * interruptor. Va marcada por defecto: el alta completa es lo normal y apagarla
 * es la excepción (por eso se ve, en vez de esconderse en un "avanzado").
 */
function Accion({
  checked, onChange, titulo, detalle, disabled, children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  titulo: string;
  detalle: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-border-subtle bg-surface-2 p-2.5 ${disabled ? "opacity-60" : ""}`}>
      <label className={`flex items-start gap-2.5 ${disabled ? "" : "cursor-pointer"}`}>
        <input
          type="checkbox"
          className="mt-0.5 accent-brand"
          checked={checked && !disabled}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-text-primary">{titulo}</span>
          <span className="block text-[11.5px] text-text-tertiary">{detalle}</span>
        </span>
      </label>
      {children && !disabled && <div className="mt-2 pl-6">{children}</div>}
    </div>
  );
}

/** Resultado de un paso del alta: hecho (verde) o pendiente con su motivo. */
function PasoResultado({
  icono, titulo, paso, ok, tono, etiqueta,
}: {
  icono: string;
  titulo: string;
  paso: PasoAlta;
  ok: (resultado: any) => string;
  tono?: "warning";
  /** Sustituye el rótulo del paso hecho ("HECHO"/"SIMULADO") cuando ninguno describe lo que pasó. */
  etiqueta?: string;
}) {
  const bien = paso.hecho;
  const color = !bien ? "border-warning-border bg-warning-soft" : tono === "warning" ? "border-warning-border bg-warning-soft" : "border-border-subtle bg-surface-2";
  return (
    <div className={`rounded-lg border p-2.5 ${color}`}>
      <div className="flex items-center gap-2">
        <Icon name={icono} size={14} />
        <span className="text-[13px] font-semibold text-text-primary">{titulo}</span>
        <Badge tone={bien ? (tono === "warning" ? "warning" : "success") : "warning"} label={bien ? (etiqueta ?? (tono === "warning" ? "SIMULADO" : "HECHO")) : "PENDIENTE"} />
      </div>
      <p className="mt-1 text-[11.5px] text-text-secondary">
        {bien ? ok(paso.resultado) : (paso.motivo ?? "No se hizo.")}
      </p>
    </div>
  );
}

function Rev({ k, v }: { k: string; v?: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1">
      <span className="text-text-tertiary">{k}</span>
      <span className="text-right font-medium text-text-primary">{v || "—"}</span>
    </div>
  );
}
