import { Module } from '@nestjs/common';
import { PeriodsController } from './periods.controller';
import { PeriodsService } from './periods.service';
import { GlobalParametersPeriodsController } from '../global-parameters-periods/global-parameters-periods.controller';
import { GlobalParametersForInvoicesController } from '../global-parameters-for-invoices/global-parameters-for-invoices.controller';

@Module({
  controllers: [PeriodsController, GlobalParametersPeriodsController, GlobalParametersForInvoicesController],
  providers: [PeriodsService],
  exports: [PeriodsService],
})
export class PeriodsModule {}