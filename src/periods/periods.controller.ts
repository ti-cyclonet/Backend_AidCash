import { Controller, Get, Post, Body, UseGuards, Param, Delete, Patch, Query } from '@nestjs/common';
import { PeriodsService } from './periods.service';
import { CreatePeriodDto } from './dto/create-period.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('periods')
// @UseGuards(JwtAuthGuard) // Temporalmente deshabilitado para pruebas
export class PeriodsController {
  constructor(private readonly periodsService: PeriodsService) {}

  @Get('test-connection')
  async testConnection() {
    return this.periodsService.testConnection();
  }

  @Post('subperiods')
  createSubperiod(@Body() createSubperiodDto: any) {
    return this.periodsService.createSubperiod(createSubperiodDto);
  }

  @Post()
  create(@Body() createPeriodDto: CreatePeriodDto) {
    return this.periodsService.create(createPeriodDto);
  }

  @Get()
  findAll() {
    return this.periodsService.findAll();
  }

  @Get('global-parameters')
  getGlobalParameters() {
    return this.periodsService.getGlobalParameters();
  }

  @Get('global-parameters/validate-name')
  validateParameterName(@Query('name') name: string) {
    return this.periodsService.validateParameterName(name);
  }

  @Post('global-parameters')
  createGlobalParameter(@Body() createParameterDto: any) {
    return this.periodsService.createGlobalParameter(createParameterDto);
  }

  @Post(':id/parameters')
  addParametersToPeriod(@Param('id') periodId: string, @Body() body: any) {
    return this.periodsService.addParametersToPeriod(periodId, body.parametros);
  }

  @Get(':id/parameters')
  getParametersByPeriod(@Param('id') periodId: string) {
    return this.periodsService.getParametersByPeriod(periodId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.periodsService.remove(id);
  }

  @Delete(':id/force')
  forceRemove(@Param('id') id: string) {
    return this.periodsService.forceRemove(id);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.periodsService.deactivate(id);
  }

  @Patch(':id/activate')
  activate(@Param('id') id: string) {
    return this.periodsService.activate(id);
  }

  @Get('active/current')
  getActivePeriod() {
    return this.periodsService.getActivePeriod();
  }

  @Get('validation/check-active')
  validateActivePeriod() {
    return this.periodsService.validateActivePeriod();
  }

  @Post('validation/validate-expiry')
  validatePeriodExpiry() {
    return this.periodsService.validatePeriodExpiry();
  }
}