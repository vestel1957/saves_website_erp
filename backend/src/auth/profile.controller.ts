import { BadRequestException, NotFoundException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MIMES_IMAGEN, mimeAceptado, nombreEnDisco } from '../common/uploads';
import { AuthUser } from './current-user.decorator';
import { ProfileService, FOTOS_ROOT } from './profile.service';
import { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto';

/** 5 MB: una foto de perfil no necesita más y frena las subidas de 40 MP. */
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;

/**
 * "Mi perfil" — todo lo que un usuario ve y cambia de SÍ MISMO.
 *
 * Sin `PermissionsGuard` ni `AreaGuard` a propósito: cualquiera con sesión tiene
 * derecho a su propio perfil. La seguridad está en que ninguna ruta recibe un id:
 * el sujeto es siempre `@CurrentUser()`, resuelto del token.
 */
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  get(user: AuthUser) {
    return this.profile.get(user);
  }

  logins(user: AuthUser) {
    return this.profile.logins(user);
  }

  update(user: AuthUser, dto: UpdateProfileDto) {
    return this.profile.update(user, dto);
  }

  /** ¿Cambiar mi contraseña pide código, y a qué WhatsApp saldría? */
  passwordPolicy(user: AuthUser) {
    return this.profile.passwordPolicy(user);
  }

  /** Manda el código de 6 dígitos a mi WhatsApp. */
  requestPasswordCode(user: AuthUser) {
    return this.profile.requestPasswordCode(user);
  }

  changePassword(user: AuthUser, dto: ChangePasswordDto) {
    return this.profile.changePassword(user, dto.currentPassword, dto.newPassword, dto.code);
  }

  async photo(user: AuthUser, res: Response) {
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

  uploadPhoto(user: AuthUser, file?: { filename: string; path: string }) {
    if (!file) throw new BadRequestException('No se recibió ninguna imagen');
    return this.profile.setPhoto(user, file);
  }

  deletePhoto(user: AuthUser) {
    return this.profile.deletePhoto(user);
  }
}
