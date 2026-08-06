import { HttpException } from '../../core/http/errores';
import { Logger } from '../../core/logger';
import type { ToolContext, Toolset } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P, SUPERADMIN_PERMISSION } from '../../auth/permissions.catalog';

const logger = new Logger('ChatbotTool');

/**
 * Une varios toolsets en uno solo (un `AgentDefinition` acepta uno). Enruta cada
 * llamada al toolset que la DECLARA para el usuario actual: como `definitions` ya
 * filtra por permiso, una herramienta que este usuario no puede ver tampoco se
 * puede ejecutar aunque el modelo se invente su nombre. Es la segunda barrera; la
 * primera es el `ctx.can` dentro de cada herramienta.
 */
/**
 * ¿Es la "sonda" con la que el motor arma su enrutador?
 *
 * Al construirse, `wa-agent` llama una vez a `definitions()` con un usuario vacío
 * (`{id:'', name:'', permissions:[]}`, ver engine.ts → resolveDefinition) solo para
 * saber qué toolset atiende cada nombre de herramienta. No es una petición de un
 * funcionario: es el motor hablando consigo mismo.
 */
export function esSonda(ctx: ToolContext): boolean {
  return !ctx.user?.id;
}

export function combineToolsets(...sets: Toolset[]): Toolset {
  return {
    /**
     * Ante la sonda se declaran TODAS las herramientas; ante un usuario real, solo las
     * suyas.
     *
     * Sin esto el agente interno estaba roto de raíz: como sus herramientas se declaran
     * según el área del funcionario y la sonda no tiene permisos, el enrutador del motor
     * quedaba VACÍO y toda llamada moría con "herramienta desconocida". El modelo sí las
     * veía —esa lista se arma aparte, con el usuario real— así que las pedía una y otra
     * vez y acababa respondiendo "no tengo acceso a eso". Pasó desapercibido porque los
     * agentes de cliente y público declaran sus herramientas sin condiciones, y hasta hoy
     * no había ningún funcionario vinculado.
     *
     * No abre ninguna puerta: el permiso se sigue comprobando con el contexto REAL en
     * los dos sitios que importan —la lista que se le ofrece al modelo y el `execute` de
     * aquí abajo, que busca el dueño con ese mismo contexto—, así que una herramienta
     * fuera del área del funcionario sigue respondiendo "no disponible" aunque el modelo
     * se invente su nombre.
     */
    definitions: (ctx) => {
      const efectivo = esSonda(ctx) ? ({ ...ctx, can: () => true } as ToolContext) : ctx;
      return sets.flatMap((s) => s.definitions(efectivo));
    },
    async execute(name, input, ctx) {
      const owner = sets.find((s) => s.definitions(ctx).some((d) => d.name === name));
      if (!owner) return `Herramienta no disponible: ${name}`;
      return owner.execute(name, input, ctx);
    },
  };
}

/**
 * ¿Tiene ALGUNA de estas áreas/permisos? (las áreas del ERP son OR, como el AreaGuard).
 *
 * El superadministrador pasa siempre, igual que en el `AreaGuard` de la web. El rol
 * "Superadministrador" del catálogo ya incluye todas las áreas, así que en la práctica
 * pasaría de todos modos; esto cubre al superusuario configurado a mano, con
 * `system.admin` y poco más, que si no se quedaba sin NINGUNA herramienta interna por
 * WhatsApp mientras en el ERP lo ve todo.
 */
export function canAny(ctx: ToolContext, permissions: string[]): boolean {
  return permissions.some((p) => ctx.can(p)) || ctx.can(SUPERADMIN_PERMISSION);
}

/**
 * Declara herramientas solo si el usuario pasa el gate. Mantiene el prompt corto y
 * evita que el modelo ofrezca lo que luego va a rechazar.
 */
export function gated(ok: boolean, defs: Array<Record<string, unknown>>): any[] {
  return ok ? (defs as any[]) : [];
}

/**
 * Quién puede pedir DOCUMENTOS (PDF) por chat: administración y superusuarios.
 *
 * Va aparte del área de cada módulo y es deliberadamente más estrecho: un PDF no es
 * una respuesta que se lee y se olvida en el hilo — es un archivo que queda en el
 * celular, se reenvía y sale de la empresa, con la dirección del cliente, su documento
 * o el detalle de una caja impresos. Que un técnico pueda CONSULTAR un ticket no
 * implica que deba poder exportar su acta a un chat.
 *
 * El área es OR con el superadmin, igual que en el `AreaGuard`.
 */
export const DOCUMENTOS_PERMISOS = [P.AREA_ADMINISTRACION, SUPERADMIN_PERMISSION];

/**
 * Gate de documentos sobre el contexto de la herramienta. Se apoya en `ctx.can` (y no
 * en `ctx.user.permissions`) para que la sonda con la que el motor arma su enrutador
 * siga viendo estas herramientas: si no, no quedarían registradas y nadie —ni
 * administración— podría ejecutarlas. Ver `combineToolsets`.
 */
export function puedeDocumentos(ctx: ToolContext): boolean {
  return canAny(ctx, DOCUMENTOS_PERMISOS);
}

/** El mismo gate a partir de la lista de permisos, para redactar el prompt. */
export function tieneDocumentos(permissions?: string[]): boolean {
  return DOCUMENTOS_PERMISOS.some((p) => permissions?.includes(p));
}

/**
 * Quién puede pedir REPORTES (y su PDF): gerencia, igual que en la web.
 *
 * A diferencia de los documentos, el PDF de un reporte NO pide administración: un
 * reporte es agregado interno, no el papel de un cliente con su dirección impresa,
 * y quien ya puede leer las cifras en el chat puede copiarlas de todos modos. Pedir
 * un permiso extra solo para el archivo dejaría a un gerente sin el PDF de su
 * propio tablero. Ver `enviar_pdf_reporte`.
 */
export const REPORTES_PERMISOS = [P.AREA_GERENCIA];

/** El gate de reportes para redactar el prompt (el superadmin pasa, como en canAny). */
export function tieneReportes(permissions?: string[]): boolean {
  return [...REPORTES_PERMISOS, SUPERADMIN_PERMISSION].some((p) => permissions?.includes(p));
}

/**
 * Todas las herramientas que generan un PDF, en un solo sitio.
 *
 * Cada toolset la consulta al principio de su `execute`: no basta con no declarar la
 * herramienta (eso solo evita que el modelo la vea), porque el enrutador del motor la
 * encuentra igual si el modelo se inventa el nombre. Misma lógica que
 * `EXIGEN_ACCESO_PLENO` en el toolset de clientes.
 */
export const HERRAMIENTAS_DOCUMENTOS = new Set([
  'enviar_pdf_abonado',
  'enviar_pdf_factura',
  'enviar_orden_de_servicio',
  'enviar_pdf_orden_compra',
  'enviar_pdf_cierre_caja',
]);

export const DOCUMENTO_DENEGADO =
  'Los documentos en PDF por WhatsApp están reservados a administración y a los superusuarios. ' +
  'Dile que puedes darle el dato aquí mismo en el chat, y que el PDF lo descarga desde el ERP.';

/** Pesos colombianos sin decimales. */
export function cop(n: number | null | undefined): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}

/**
 * Fecha corta legible (es-CO), tolerante a null.
 *
 * Se formatea en UTC y NO en la zona del servidor, que no está en Colombia (hoy,
 * Europe/Berlin +02:00). Las fechas del ERP son casi todas valores de día guardados
 * a medianoche UTC, y los límites de periodo se construyen como `…T23:59:59.999Z`:
 * con la zona local, ese fin de día saltaba al siguiente y el bot contestaba "de
 * 1/1/2026 a 30/7/2026" cuando le habían pedido hasta el 29.
 */
export function fecha(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es-CO', { timeZone: 'UTC' });
}

/**
 * Convierte el error de un servicio del ERP en texto para el modelo. Los servicios
 * lanzan HttpException con mensajes ya redactados para humanos ("El cliente no tiene
 * usuario PPPoE"), que son exactamente lo que el agente debe explicar.
 */
export function toolError(e: unknown): string {
  const msg = (e as { response?: { message?: string }; message?: string })?.response?.message
    ?? (e as Error)?.message
    ?? 'Error desconocido';
  const texto = Array.isArray(msg) ? msg.join('; ') : String(msg);

  // Un fallo de Prisma NO es un mensaje para humanos: llega con la consulta, el
  // fragmento de código y la ruta del dist. Metérselo al modelo gasta cientos de
  // tokens, le enseña el esquema y lo pone a redactar disculpas técnicas. Se corta
  // aquí y se deja el detalle en el log del servidor, que es donde se diagnostica.
  if (/Invalid `.*` invocation|prisma|\n\s+at /i.test(texto)) {
    logger.warn(`Error técnico en una herramienta del chatbot: ${texto.slice(0, 500)}`);
    return 'No se pudo completar: la consulta no es válida. Revisa los datos (por ejemplo, que el estado o el filtro sean de los permitidos) e inténtalo de otra forma.';
  }

  return `No se pudo completar: ${texto}`;
}

/** Envuelve un handler para que un fallo del ERP no rompa la conversación. */
export async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return toolError(e);
  }
}
