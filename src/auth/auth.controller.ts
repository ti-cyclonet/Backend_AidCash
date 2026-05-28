import { Controller, Get, UseGuards, Request, Query, Param, Logger, Post, Body } from '@nestjs/common';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    this.logger.log(`GET /api/auth/profile - Usuario: ${req.user?.username || 'N/A'}`);
    return req.user;
  }

  @UseGuards(JwtAuthGuard)
  @Get('validate')
  async validateToken(@Request() req) {
    this.logger.log(`GET /api/auth/validate - Token válido para usuario: ${req.user?.username || 'N/A'}`);
    return { valid: true, user: req.user };
  }

  @UseGuards(JwtAuthGuard)
  @Get('users')
  async getUsers(@Request() req, @Query('page') page = 1, @Query('limit') limit = 10) {
    this.logger.log(`GET /api/auth/users - Página: ${page}, Límite: ${limit}`);
    const token = req.headers.authorization?.replace('Bearer ', '');
    try {
      const result = await this.authService.getUsers(token, page, limit);
      this.logger.log(`GET /api/auth/users - Éxito: ${result?.length || 0} usuarios encontrados`);
      return result;
    } catch (error) {
      this.logger.error(`GET /api/auth/users - Error: ${error.message}`);
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('users/:id/access')
  async checkUserAccess(@Request() req, @Param('id') userId: string) {
    this.logger.log(`GET /api/auth/users/${userId}/access - Verificando acceso`);
    const token = req.headers.authorization?.replace('Bearer ', '');
    try {
      const result = await this.authService.checkUserAccess(token, userId);
      this.logger.log(`GET /api/auth/users/${userId}/access - Resultado: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(`GET /api/auth/users/${userId}/access - Error: ${error.message}`);
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('applications')
  async getApplications(@Request() req) {
    this.logger.log('GET /api/auth/applications - Consultando aplicaciones');
    const token = req.headers.authorization?.replace('Bearer ', '');
    try {
      const result = await this.authService.getApplications(token);
      this.logger.log(`GET /api/auth/applications - Éxito: ${result?.length || 0} aplicaciones encontradas`);
      return result;
    } catch (error) {
      this.logger.error(`GET /api/auth/applications - Error: ${error.message}`);
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Request() req, @Body() body: { userId: string, oldPassword: string, newPassword: string }) {
    this.logger.log(`POST /api/auth/change-password - Usuario: ${body.userId}`);
    const token = req.headers.authorization?.replace('Bearer ', '');
    try {
      const result = await this.authService.changePassword(token, body.userId, body.oldPassword, body.newPassword);
      this.logger.log(`POST /api/auth/change-password - Éxito`);
      return result;
    } catch (error) {
      this.logger.error(`POST /api/auth/change-password - Error: ${error.message}`);
      throw error;
    }
  }
}