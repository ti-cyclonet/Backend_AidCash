import { Controller, Get, Post, Patch, Param, Body, Headers, Logger, BadRequestException, UseGuards, Request } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class ContractsController {
  private readonly logger = new Logger(ContractsController.name);

  constructor(private readonly contractsService: ContractsService) {}

  @Get()
  async findAll(@Request() req, @Headers('authorization') authHeader?: string) {
    this.logger.log('GET /api/contracts - Iniciando consulta de contratos');
    try {
      const tenantId = req.user?.tenantId;
      const rol = req.user?.rol;
      const result = await this.contractsService.findAll(tenantId, rol, authHeader);
      this.logger.log(`GET /api/contracts - Éxito: ${result?.length || 0} contratos encontrados`);
      return result;
    } catch (error) {
      this.logger.error(`GET /api/contracts - Error: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') contractId: string,
    @Body() body: { status: string },
    @Headers('authorization') authHeader?: string
  ) {
    this.logger.log(`PATCH /api/contracts/${contractId}/status - Actualizando estado a ${body.status}`);
    try {
      const result = await this.contractsService.updateStatus(contractId, body.status, authHeader);
      this.logger.log(`PATCH /api/contracts/${contractId}/status - Éxito`);
      return result;
    } catch (error) {
      this.logger.error(`PATCH /api/contracts/${contractId}/status - Error: ${error.message}`, error.stack);
      
      // Preservar el status code original
      if (error.status === 400) {
        throw new BadRequestException(error.message);
      }
      
      throw error;
    }
  }

  @Post(':id/pdf')
  async uploadPDF(
    @Param('id') contractId: string,
    @Body() body: { pdfBuffer: string },
    @Headers('authorization') authHeader?: string
  ) {
    this.logger.log(`POST /api/contracts/${contractId}/pdf - Subiendo PDF`);
    try {
      const pdfBuffer = Buffer.from(body.pdfBuffer, 'base64');
      const pdfUrl = await this.contractsService.uploadContractPDF(contractId, pdfBuffer, authHeader);
      this.logger.log(`POST /api/contracts/${contractId}/pdf - Éxito: PDF subido`);
      return { pdfUrl };
    } catch (error) {
      this.logger.error(`POST /api/contracts/${contractId}/pdf - Error: ${error.message}`, error.stack);
      throw error;
    }
  }
}