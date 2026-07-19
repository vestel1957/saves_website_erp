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
    }
  | {
      /** Número desconocido: ni funcionario ni abonado. */
      kind: 'publico';
      phone: string;
    };

/** Lee la identidad que el IdentityResolver dejó en el usuario del motor. */
export function identityOf(user: AgentUser): ChatIdentity {
  return (user.meta as { identity: ChatIdentity }).identity;
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

/** subscriberId del abonado que escribe. Lanza si quien escribe no es un abonado. */
export function subscriberIdOf(user: AgentUser): string {
  const id = identityOf(user);
  if (id.kind !== 'cliente') throw new Error('Herramienta de abonado invocada sin abonado resuelto');
  return id.subscriberId;
}
