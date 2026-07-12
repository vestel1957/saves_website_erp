import { Module } from '@nestjs/common';
import { OmniController } from './omni.controller';
import { OmniService } from './omni.service';

@Module({ controllers: [OmniController], providers: [OmniService], exports: [OmniService] })
export class OmniModule {}
