import { Controller, Get, Post, Body } from '@nestjs/common';
import { PeriodsService } from '../periods/periods.service';

@Controller('global-parameters-for-invoices')
export class GlobalParametersForInvoicesController {
  constructor(private readonly periodsService: PeriodsService) {}

  @Get()
  findAll() {
    return this.periodsService.getParametrosFacturas();
  }

  @Post('bulk')
  createBulk(@Body() parametros: any[]) {
    return this.periodsService.guardarParametrosFacturas(parametros);
  }
}