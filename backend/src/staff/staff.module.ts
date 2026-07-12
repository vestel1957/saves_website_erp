import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [StaffController], providers: [StaffService], exports: [StaffService] })
export class StaffModule {}
