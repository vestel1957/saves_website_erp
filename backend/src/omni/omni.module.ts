import { Module } from '@nestjs/common';
import { OmniController } from './omni.controller';
import { OmniService } from './omni.service';
import { AccountingModule } from '../accounting/accounting.module';

@Module({ imports: [AccountingModule], controllers: [OmniController], providers: [OmniService], exports: [OmniService] })
export class OmniModule {}
