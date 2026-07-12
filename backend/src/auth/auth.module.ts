import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { LoginThrottleGuard } from './login-throttle.guard';

/**
 * Real authentication & authorization. Exports the guards so feature modules
 * (inventory) can protect their routes with @UseGuards(JwtAuthGuard, PermissionsGuard).
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, PermissionsGuard, LoginThrottleGuard],
  exports: [AuthService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
