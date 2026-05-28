import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ActivePeriodInterceptor } from '../common/interceptors/active-period.interceptor';
import { PeriodsModule } from '../periods/periods.module';

@Module({
  imports: [HttpModule, PeriodsModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, ActivePeriodInterceptor],
  exports: [InvoicesService]
})
export class InvoicesModule {}