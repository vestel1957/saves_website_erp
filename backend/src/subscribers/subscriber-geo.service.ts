import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Catálogos de dirección (selects en cascada del wizard de alta de cliente).
 * Extraído de SubscribersService: es lectura pura sin acoplamiento.
 */
@Injectable()
export class SubscriberGeoService {
  constructor(private readonly prisma: PrismaService) {}

  geoDepartments() {
    return this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      select: { legacyId: true, name: true },
    });
  }

  geoCities(departmentLegacy?: number) {
    return this.prisma.city.findMany({
      where: departmentLegacy ? { departmentLegacy } : {},
      orderBy: { name: 'asc' },
      select: { legacyId: true, name: true },
    });
  }

  geoLocalities(cityLegacy?: number) {
    return this.prisma.locality.findMany({
      where: cityLegacy ? { cityLegacy } : {},
      orderBy: { name: 'asc' },
      select: { legacyId: true, name: true },
    });
  }

  geoNeighborhoods(localityLegacy?: number) {
    return this.prisma.neighborhood.findMany({
      where: localityLegacy ? { localityLegacy } : {},
      orderBy: { name: 'asc' },
      select: { legacyId: true, name: true },
    });
  }
}
