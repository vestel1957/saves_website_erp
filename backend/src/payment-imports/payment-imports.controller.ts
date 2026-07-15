import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PaymentImportsService } from './payment-imports.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Cargue masivo de pagos externos (Efecty) — migrado de saves-vestel `Transactions::cargue_xlxs`. */
@Controller('payment-imports')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'caja')
export class PaymentImportsController {
  constructor(private readonly imports: PaymentImportsService) {}

  @Get() list() { return this.imports.list(); }
  @Get(':id') detail(@Param('id') id: string) { return this.imports.detail(id); }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: any, @Body('date') date: string | undefined, @CurrentUser() user: AuthUser) {
    if (!file?.buffer) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    return this.imports.upload(file.buffer, file.originalname ?? 'cargue.xlsx', date, user);
  }

  @Post(':id/process') process(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.imports.process(id, user); }
  @Delete(':id') remove(@Param('id') id: string) { return this.imports.remove(id); }
}
