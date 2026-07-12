import { OltDriver } from './olt-ssh.client';
import { OltHuawei } from './olt-huawei.driver';

/**
 * Olt_factory - Devuelve el driver correcto según la marca de la OLT.
 * Portado de application/libraries/Olt/Olt_factory.php.
 *
 * Para agregar una marca: crear olt-<marca>.driver.ts extendiendo OltDriver
 * y agregar el case aquí. El resto del sistema no cambia.
 */
export function createOltDriver(brand: string, host: string, port: string | number, user: string, pass: string): OltDriver {
  const b = String(brand || '').trim().toLowerCase();
  switch (b) {
    case 'huawei':
      return new OltHuawei(host, port, user, pass);
    // case 'zte':       return new OltZte(host, port, user, pass);
    // case 'fiberhome': return new OltFiberhome(host, port, user, pass);
    default:
      // Genérico: usa el shell Huawei-like como base; sus métodos de gestión
      // devuelven "no implementado" hasta calibrar la marca real.
      return new (class extends OltDriver {
        getMarca() { return brand || 'Genérica'; }
      })(host, port, user, pass);
  }
}

/** Marcas disponibles para poblar el <select> del modal. */
export const OLT_BRANDS = ['Huawei', 'ZTE', 'Fiberhome', 'V-SOL', 'BDCOM', 'Otra'];
