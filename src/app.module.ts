import { Module } from '@nestjs/common';
import { configModule } from './config.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { ContractsModule } from './contracts/contracts.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PeriodsModule } from './periods/periods.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    configModule,
    AuthModule,
    CommonModule,
    ContractsModule,
    DashboardModule,
    InvoicesModule,
    PeriodsModule,
    ReportsModule,
  ],
})
export class AppModule {}