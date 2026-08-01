import type { AgentUser } from '@s4gk/wa-agent';
import type { AuthUser } from '../auth/current-user.decorator';

/** Nombres de los agentes lógicos. Los devuelve el AgentResolver. */
export const AGENT_INTERNO = 'soporte-interno';
export const AGENT_CLIENTE = 'clientes';
export const AGENT_PUBLICO = 'publico';

/**
 * Nombre del transporte. Compone la clave de conversación: `kapso:573001112233`.
 *
 * Vive en este módulo —y no junto al transporte— porque lo necesitan tanto el
 * transporte como el gate, y el transporte ya depende del gate: tenerlo allí crearía
 * un ciclo de imports, y un `const` atrapado en un ciclo llega `undefined` en runtime
 * aunque `tsc` no diga nada. Este módulo no importa a nadie, así que es seguro.
 */
export const SAVES_TRANSPORT_NAME = 'kapso';

/** Clave de conversación del motor para un teléfono ya normalizado. */
export const convKeyOf = (phone: string) => `${SAVES_TRANSPORT_NAME}:${phone}`;

/**
 * Permiso sintético que porta un abonado identificado. No está en el catálogo RBAC
 * del ERP a propósito: ningún funcionario puede tenerlo y ningún abonado puede
 * tener un `area.*`. Así el toolset de clientes y el interno son disjuntos por
 * construcción, no por convención.
 */
export const CHAT_CLIENTE_PERMISSION = 'chat.cliente';

/**
 * El mismo truco para el número desconocido, y existe por una razón muy concreta: una
 * acción que pasa por confirmación guarda el permiso con el que se va a RE-VALIDAR al
 * ejecutarse (ver `PendingAction.permission` del motor), y el usuario público no tenía
 * ninguno — así que no podía confirmar nada. Con este puede registrar lo suyo (una
 * afiliación, una consulta de cobertura, una PQR) leyéndole antes los datos capturados
 * para que los apruebe.
 *
 * No abre ninguna puerta: ninguna herramienta de abonado ni interna lo acepta, y el
 * agente público sigue sin una sola herramienta que reciba el id de una cuenta.
 */
export const CHAT_PUBLICO_PERMISSION = 'chat.publico';

/**
 * Con qué firma el bot lo que crea en el ERP (una orden de servicio nace con la
 * columna de quién la abrió). No tiene permisos —`permissions: []`— a propósito: es
 * trazabilidad ("lo abrió el bot"), no una credencial. Quien autoriza de verdad es el
 * `ctx.can` de cada herramienta.
 */
export const BOT_ACTOR: AuthUser = {
  id: 'chatbot',
  email: 'bot@vestel.com.co',
  name: 'Bot WhatsApp',
  roles: [],
  permissions: [],
};

/**
 * Quién es el número que escribe. Es lo que decide qué agente atiende y con qué
 * herramientas, así que se resuelve una sola vez por mensaje y viaja en
 * `AgentUser.meta.identity` hasta los toolsets.
 */
export type ChatIdentity =
  | {
      /** Funcionario: hereda su RBAC real del ERP. */
      kind: 'interno';
      /** AuthUser con permisos efectivos, para llamar a los servicios del ERP. */
      authUser: AuthUser;
    }
  | {
      /** Abonado identificado por su teléfono. */
      kind: 'cliente';
      subscriberId: string;
      abonado: number | null;
      /**
       * Presente solo si quien escribe NO es el titular sino un familiar que él
       * autorizó (ver `SubscriberContact`). El agente lo usa para tratarlo por su
       * nombre y para no ofrecerle lo que solo le toca al titular.
       */
      autorizado?: { nombre: string | null; relacion: string | null; titular: string };
      /**
       * Cómo se identificó quien escribe, cuando NO es el titular ni un autorizado:
       *   'basico'   — acertó documento + nombre + teléfono (datos que están en la
       *                factura): solo diagnóstico, saldo total y reportar fallas.
       *   'completo' — además tecleó el código enviado al WhatsApp del titular.
       * Ausente = es el titular (o alguien a quien él autorizó): acceso normal.
       */
      acceso?: 'basico' | 'completo';
    }
  | {
      /** Número desconocido: ni funcionario ni abonado. */
      kind: 'publico';
      phone: string;
    };

/**
 * Nombre de pila para dirigirse a alguien por WhatsApp.
 *
 * Los nombres del ERP vienen del legacy en mayúscula sostenida y completos
 * ("BRAYAN MAURICIO LINARES CASTAÑEDA"): saludar así suena a carta de cobranza, no a
 * un compañero de trabajo. Se toma el primer token y se le arregla la caja.
 *
 * Devuelve cadena vacía si no hay nombre utilizable; quien llama decide el respaldo.
 */
export function nombreDePila(full?: string | null): string {
  const token = String(full ?? '').trim().split(/\s+/)[0] ?? '';
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Lee la identidad que el IdentityResolver dejó en el usuario del motor.
 *
 * Tolera que no haya ninguna: el motor construye su enrutador con un usuario "sonda"
 * vacío (`{id:'',name:'',permissions:[]}`, sin `meta`), y reventar ahí tumbaba el
 * arranque entero del backend. Sin identidad se devuelve la de MENOR privilegio, que
 * es la que hace fallar cerrado a quien la consulte.
 */
export function identityOf(user: AgentUser): ChatIdentity {
  return (user?.meta as { identity?: ChatIdentity } | undefined)?.identity
    ?? { kind: 'publico', phone: '' };
}

/**
 * AuthUser del funcionario, para llamar a los servicios del ERP. Lanza si se invoca
 * desde un agente que no es el interno: sería un error de programación (una
 * herramienta interna registrada en el toolset de clientes), no una entrada
 * inválida, y debe fallar ruidosamente en vez de escalar privilegios.
 */
export function authUserOf(user: AgentUser): AuthUser {
  const id = identityOf(user);
  if (id.kind !== 'interno') throw new Error('Herramienta interna invocada por un no-funcionario');
  return id.authUser;
}

/**
 * Teléfono de quien escribe, para las herramientas del agente público (que no tienen
 * un abonado del que colgarse). Solo la identidad `publico` lo lleva; para el resto
 * se saca de la clave de conversación (`kapso:573001112233`).
 */
export function phoneOf(user: AgentUser, convKey: string): string {
  const id = identityOf(user);
  if (id.kind === 'publico') return id.phone;
  return convKey.split(':')[1] ?? '';
}

/**
 * ¿Quien escribe puede ver lo que expone la cuenta (facturas en PDF con dirección,
 * pagos, cambios)? Solo NO puede quien entró con la validación básica por datos.
 */
export function tieneAccesoPleno(user: AgentUser): boolean {
  const id = identityOf(user);
  return id.kind === 'cliente' && id.acceso !== 'basico';
}

/** subscriberId del abonado que escribe. Lanza si quien escribe no es un abonado. */
export function subscriberIdOf(user: AgentUser): string {
  const id = identityOf(user);
  if (id.kind !== 'cliente') throw new Error('Herramienta de abonado invocada sin abonado resuelto');
  return id.subscriberId;
}
