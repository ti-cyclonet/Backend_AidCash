import { Controller, Get, Logger } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(private readonly dashboardService: DashboardService) {}

  @Get('metrics')
  async getMetrics() {
    this.logger.log('GET /api/dashboard/metrics - Consultando métricas del dashboard');
    try {
      const result = await this.dashboardService.getMetrics();
      this.logger.log('GET /api/dashboard/metrics - Métricas obtenidas exitosamente');
      return result;
    } catch (error) {
      this.logger.error(`GET /api/dashboard/metrics - Error: ${error.message}`);
      throw error;
    }
  }
}