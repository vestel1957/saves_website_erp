import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { StaffDocumentsService } from './staff-documents.service';
import { AuthModule } from '../auth/auth.module';
import { ReportsModule } from '../reports/reports.module';

@Module({
  // ReportsModule por `PerformanceService`: el rendimiento del funcionario se
  // calcula una sola vez, en un solo sitio. No importa StaffModule de vuelta,
  // así que no hay ciclo.
  imports: [AuthModule, ReportsModule],
  controllers: [StaffController],
  providers: [StaffService, StaffDocumentsService],
  exports: [StaffService, StaffDocumentsService],
})
export class StaffModule {}
