import { Controller, Get, Delete, Param, Patch, Body } from '@nestjs/common';
import { PeriodsService } from '../periods/periods.service';

@Controller('global-parameters-periods')
export class GlobalParametersPeriodsController {
  constructor(private readonly periodsService: PeriodsService) {}

  @Get('active')
  getActiveGlobalParameters() {
    return this.periodsService.getActiveGlobalParameters();
  }

  @Delete(':id')
  removeParameterFromPeriod(@Param('id') id: string) {
    return this.periodsService.removeParameterFromPeriod(id);
  }

  @Patch(':id')
  updateParameter(@Param('id') id: string, @Body() body: any) {
    return this.periodsService.updateParameter(id, body);
  }
}