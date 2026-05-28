import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportFiltersDto } from './dto/report-filters.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('clients')
  getClientsReport(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getClientsReport(filters);
  }

  @Get('contracts')
  getContractsReport(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getContractsReport(filters);
  }

  @Get('invoices')
  getInvoicesReport(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getInvoicesReport(filters);
  }

  @Get('profits')
  getProfitsReport(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getProfitsReport(filters);
  }

  @Get('taxes')
  getTaxesReport(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getTaxesReport(filters);
  }

  @Get('global-parameters')
  getGlobalParametersReport(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getGlobalParametersReport(filters);
  }

  @Get('management-indicators')
  getManagementIndicators(@Query() filters: ReportFiltersDto) {
    return this.reportsService.getManagementIndicators(filters);
  }
}
