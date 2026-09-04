import type { AuthUser } from '../auth/current-user.decorator';
import { BOT_ACTOR } from '../chatbot/chatbot.identity';

/**
 * Quién generó una orden de servicio.
 *
 * Una orden es una instrucción de trabajo: alguien la manda y alguien la hace. Lo
 * segundo siempre estuvo (`assigned`/`assignedStaff`); lo primero no —vivía en `col`,
 * el texto libre del legacy— así que "¿quién pidió esta visita?" sólo se podía
 * responder preguntando por ahí. Estas dos funciones son el ÚNICO sitio donde se
 * decide, para que las cuatro puertas por las que nace una orden (el ERP, el chatbot,
 * los procesos automáticos y el legacy) la firmen igual.
 *
 * `col` se sigue escribiendo con el mismo valor de siempre: es la columna que viaja al
 * legacy y de la que cuelga el aviso proactivo del bot (ver `ticket-confirmacion`).
 */

/** De dónde salió la orden. Ver `Ticket.createdBySource`. */
export type OrigenOrden = 'USUARIO' | 'CHATBOT' | 'SISTEMA' | 'LEGACY';

export type AutorDeOrden = {
  col: string | null;
  createdByName: string;
  createdById: string | null;
  createdBySource: OrigenOrden;
};

/** Con qué se firma lo que abre un proceso automático, cuando nadie lo pidió. */
export const AUTOR_SISTEMA = 'Sistema';

/**
 * La firma de una persona (o del bot actuando por ella).
 *
 * El bot lleva `id: 'chatbot'`, que no es un `User` de verdad: se marca como CHATBOT y
 * no se guarda su id como si fuera una cuenta.
 */
export function autorDeOrden(user: AuthUser): AutorDeOrden {
  const esBot = user.id === BOT_ACTOR.id;
  const nombre = user.name?.trim() || user.email?.trim() || AUTOR_SISTEMA;
  return {
    col: nombre,
    createdByName: nombre,
    createdById: esBot ? null : user.id || null,
    createdBySource: esBot ? 'CHATBOT' : 'USUARIO',
  };
}

/**
 * La firma de un proceso automático: la reconexión al pagar, el fallo de un equipo,
 * la cascada de cierre. `autor` deja decir CUÁL proceso fue.
 */
export function autorSistema(autor?: string | null): AutorDeOrden {
  const nombre = autor?.trim() || AUTOR_SISTEMA;
  return { col: nombre, createdByName: nombre, createdById: null, createdBySource: 'SISTEMA' };
}

/**
 * Quién escribió un renglón del SEGUIMIENTO de la orden (lo que aquí se llama
 * "documentar"). Es el hermano de `autorDeOrden`: uno firma quién la mandó, éste
 * quién la va trabajando.
 *
 * `TicketThread` sólo traía `employeeId`, que es el `eid` del legacy y por tanto
 * únicamente lo tiene quien además de cuenta tiene ficha de empleado. Todo lo que se
 * documentaba desde el ERP entraba con 0 y la orden lo pintaba como "Sistema", que es
 * justo lo contrario de lo que hace falta en un acta: saber quién estuvo ahí.
 */
export type FirmaDeSeguimiento = { employeeId: number; authorName: string | null; authorId: string | null };

/** Lo escribió de verdad un proceso automático: sin nombre, la ficha dirá "Sistema". */
export const SEGUIMIENTO_DEL_SISTEMA: FirmaDeSeguimiento = { employeeId: 0, authorName: null, authorId: null };

/**
 * La firma de una persona (o del bot). `ficha` es su empleado, cuando se pudo
 * resolver: de ahí sale el `eid` con el que el legacy identifica a quien escribe.
 * Sin ficha se guarda igual el nombre — una cuenta sin empleado sigue siendo alguien.
 */
export function autorDeSeguimiento(
  user: AuthUser | null | undefined,
  ficha?: { legacyId: number | null } | null,
): FirmaDeSeguimiento {
  if (!user?.id) return SEGUIMIENTO_DEL_SISTEMA;
  const nombre = user.name?.trim() || user.email?.trim() || null;
  const esBot = user.id === BOT_ACTOR.id;
  return {
    employeeId: esBot ? 0 : ficha?.legacyId ?? 0,
    authorName: nombre,
    authorId: esBot ? null : user.id,
  };
}
