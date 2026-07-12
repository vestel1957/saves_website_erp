import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Throttle anti-fuerza-bruta para el login, en memoria y sin dependencias.
 * Limita los intentos por IP en una ventana móvil. Suficiente para frenar
 * ataques de diccionario sin molestar a un usuario legítimo (que jamás llega
 * a ~10 intentos en pocos minutos). El estado vive en el proceso; con varias
 * instancias cada una lleva su propia cuenta, lo cual sigue acotando el abuso.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly attempts = new Map<string, number[]>();
  private readonly max = 10;
  private readonly windowMs = 5 * 60 * 1000; // 5 minutos

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const key: string = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.max) {
      throw new HttpException(
        'Demasiados intentos de inicio de sesión. Espera unos minutos e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.attempts.set(key, recent);
    // Limpieza oportunista para no acumular IPs viejas indefinidamente.
    if (this.attempts.size > 5000) {
      for (const [k, v] of this.attempts) {
        if (v.every((t) => now - t >= this.windowMs)) this.attempts.delete(k);
      }
    }
    return true;
  }
}
