import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PerformanceService } from './performance.service';
import { StaffReportsService } from './staff-reports.service';
import { MetricsService } from './metrics.service';
import { IspReportsService } from './isp-reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, PerformanceService, StaffReportsService, MetricsService, IspReportsService],
  exports: [ReportsService, PerformanceService, StaffReportsService, MetricsService, IspReportsService],
})
export class ReportsModule {}
