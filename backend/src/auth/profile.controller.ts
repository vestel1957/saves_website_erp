import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MIMES_IMAGEN, mimeAceptado, nombreEnDisco } from '../common/uploads';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, AuthUser } from './current-user.decorator';
import { ProfileService, FOTOS_ROOT } from './profile.service';
import { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto';

/** 5 MB: una foto de perfil no necesita más y frena las subidas de 40 MP. */
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

/**
 * "Mi perfil" — todo lo que un usuario ve y cambia de SÍ MISMO.
 *
 * Sin `PermissionsGuard` ni `AreaGuard` a propósito: cualquiera con sesión tiene
 * derecho a su propio perfil. La seguridad está en que ninguna ruta recibe un id:
 * el sujeto es siempre `@CurrentUser()`, resuelto del token.
 */
@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.profile.get(user);
  }

  @Get('logins')
  logins(@CurrentUser() user: AuthUser) {
    return this.profile.logins(user);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.profile.update(user, dto);
  }

  /** ¿Cambiar mi contraseña pide código, y a qué WhatsApp saldría? */
  @Get('password/policy')
  passwordPolicy(@CurrentUser() user: AuthUser) {
    return this.profile.passwordPolicy(user);
  }

  /** Manda el código de 6 dígitos a mi WhatsApp. */
  @Post('password/code')
  requestPasswordCode(@CurrentUser() user: AuthUser) {
    return this.profile.requestPasswordCode(user);
  }

  @Post('password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.profile.changePassword(user, dto.currentPassword, dto.newPassword, dto.code);
  }

  @Get('photo')
  async photo(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const abs = await this.profile.rutaFoto(user);
    if (!abs) throw new NotFoundException('Sin foto de perfil');
    // Aquí NO se usa `enviarAdjuntoSeguro`: ése manda `Content-Disposition:
    // attachment`, que en un <img> vía blob da igual pero convierte "abrir la
    // foto" en una descarga. La protección que sí importa (nosniff + no-store)
    // se conserva, y el tipo se sirve fijo como imagen.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(abs);
  }

  @Post('photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(FOTOS_ROOT, { recursive: true });
          cb(null, FOTOS_ROOT);
        },
        // La extensión sale del MIME ya validado, nunca del `originalname`.
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: MAX_FOTO_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = mimeAceptado(file.mimetype, MIMES_IMAGEN);
        cb(ok ? null : new BadRequestException('La foto debe ser una imagen (JPG, PNG, WEBP…)'), ok);
      },
    }),
  )
  uploadPhoto(@CurrentUser() user: AuthUser, @UploadedFile() file?: { filename: string; path: string }) {
    if (!file) throw new BadRequestException('No se recibió ninguna imagen');
    return this.profile.setPhoto(user, file);
  }

  @Delete('photo')
  deletePhoto(@CurrentUser() user: AuthUser) {
    return this.profile.deletePhoto(user);
  }
}
