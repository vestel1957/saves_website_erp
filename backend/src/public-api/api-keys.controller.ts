import { ALL_SCOPES, ApiKeysService, CreateApiKeyDto } from './api-keys.service';
import { AuthUser } from '../auth/current-user.decorator';

/**
 * Gestión de claves de la API pública. Exige `system.admin` (superusuario), NO sólo
 * el área `sistemas`: una clave concede lectura de TODO el padrón con PII y facturación
 * a un tercero fuera de la red, con `ignoreLimits`/`rateLimit:0` incluidos. Un técnico
 * de sistemas —que no tiene permiso sobre clientes ni facturación— no debe poder
 * acuñarse ese acceso. Sólo el superadmin.
 */
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  scopes() { return { scopes: ALL_SCOPES }; }
  list() { return this.keys.list(); }

  create(dto: CreateApiKeyDto, u?: AuthUser) {
    return this.keys.create(dto, u?.name ?? u?.email);
  }

  toggle(id: string, body: { active?: boolean }) {
    return this.keys.setActive(id, !!body?.active);
  }

  revoke(id: string) { return this.keys.revoke(id); }
}
