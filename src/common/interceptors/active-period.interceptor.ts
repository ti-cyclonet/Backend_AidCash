import { Injectable, NestInterceptor, ExecutionContext, CallHandler, BadRequestException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PeriodsService } from '../../periods/periods.service';

@Injectable()
export class ActivePeriodInterceptor implements NestInterceptor {
  constructor(private readonly periodsService: PeriodsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    try {
      // Validar que existe un periodo activo válido
      const validation = await this.periodsService.validateActivePeriod();
      
      if (!validation.hasValidActivePeriod) {
        throw new BadRequestException(
          'No active period exists. The application requires an active period to perform this operation.'
        );
      }

      return next.handle();
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      // Si hay error de conexión, permitir la operación pero registrar el error
      console.warn('No se pudo validar el periodo activo:', error.message);
      return next.handle();
    }
  }
}