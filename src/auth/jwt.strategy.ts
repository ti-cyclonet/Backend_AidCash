import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: true, // Ignorar expiración por ahora
      secretOrKey: 'wSddeEwq2e', // Mismo secret que Authoriza
    });
  }

  async validate(payload: any) {
    return {
      userId: payload.sub || payload.id,
      username: payload.username || payload.strUserName,
      email: payload.email,
      tenantId: payload.tenantId,
      rol: payload.rol
    };
  }
}