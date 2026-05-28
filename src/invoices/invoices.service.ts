import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly authorizerUrl: string;
  private readonly EXCLUDED_TENANT_NAME = 'cyclonet';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.authorizerUrl = this.configService.get<string>('AUTH_SERVICE_URL', 'http://localhost:3000');
  }

  async findAll(tenantId?: string, rol?: string) {
    try {
      const params: any = {};
      
      // Si el usuario tiene rol 'adminInvoices', filtrar por tenantId
      // Si tiene rol 'adminFactonet', no filtrar (ver todas las facturas)
      if (rol === 'adminInvoices' && tenantId) {
        params.tenantId = tenantId;
      }
      
      const response = await firstValueFrom(
        this.httpService.get(`${this.authorizerUrl}/api/invoices`, { params })
      );
      
      return this.transformInvoices(response.data);
    } catch (error) {
      this.logger.error('Error fetching invoices from Authoriza:', error.message);
      return [];
    }
  }

  async getProfitReport(startDate: string, endDate: string, contractId?: string) {
    try {
      const params: any = { startDate, endDate };
      if (contractId) params.contractId = contractId;
      
      const response = await firstValueFrom(
        this.httpService.get(`${this.authorizerUrl}/api/invoices/profit-report`, { params })
      );
      
      return response.data;
    } catch (error) {
      this.logger.error('Error fetching profit report from Authoriza:', error.message);
      return { totalInvoiced: 0, totalProfit: 0, invoiceCount: 0, details: [] };
    }
  }

  private transformInvoices(invoices: any[]) {
    return invoices
      .filter(invoice => !this.isCyclonetTenant(invoice))
      .map(invoice => {
      const basicData = invoice.user?.basicData;
      const legalEntity = basicData?.legalEntityData;
      const naturalPerson = basicData?.naturalPersonData;
      const contract = invoice.contract;

      const transformed: any = {
        id: invoice.id,
        numero: invoice.code || `INV-${String(invoice.id).padStart(6, '0')}`,
        cliente: legalEntity?.businessName || invoice.user?.strUserName || 'N/A',
        fechaEmision: invoice.issueDate,
        fechaVencimiento: invoice.expirationDate,
        fechaPago: invoice.paymentDate,
        total: Number(invoice.value),
        estado: invoice.status,
        // Datos del cliente para la factura
        clienteNit: basicData?.documentNumber || '',
        clienteTipoPersona: basicData?.strPersonType || '',
        clienteEmail: invoice.user?.strUserName || '',
        clienteContacto: legalEntity?.contactName || (naturalPerson ? `${naturalPerson.firstName || ''} ${naturalPerson.firstSurname || ''}`.trim() : ''),
        clienteTelefono: legalEntity?.contactPhone || '',
        clienteEmailContacto: legalEntity?.contactEmail || '',
        // Datos del contrato
        contratoCode: contract?.code || '',
        contratoModo: contract?.mode || '',
        contratoPrefijo: contract?.codePrefix || '',
        // Periodo de servicio
        periodoInicio: invoice.periodStart,
        periodoFin: invoice.periodEnd,
      };

      // Agregar parámetros globales desde el campo JSON
      if (invoice.globalParameters) {
        Object.keys(invoice.globalParameters).forEach(key => {
          transformed[key] = Number(invoice.globalParameters[key]);
        });
      }

      // Agregar tipos de operación para cálculos
      if (invoice.operationTypes) {
        transformed.operationTypes = invoice.operationTypes;
      }

      // Agregar porcentajes originales para títulos
      if (invoice.percentages) {
        transformed.percentages = invoice.percentages;
      }

      return transformed;
    });
  }

  private isCyclonetTenant(invoice: any): boolean {
    const businessName = (invoice.user?.basicData?.legalEntityData?.businessName || '').toLowerCase();
    const userName = (invoice.user?.strUserName || '').toLowerCase();
    return businessName.includes(this.EXCLUDED_TENANT_NAME) || userName.includes(this.EXCLUDED_TENANT_NAME);
  }

  async checkInvoicesInPeriod(startDate: string, endDate: string) {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.authorizerUrl}/api/invoices/check-period`, {
          params: {
            startDate,
            endDate
          }
        })
      );
      
      return response.data;
    } catch (error) {
      this.logger.error('Error checking invoices in period from Authoriza:', error.message);
      // En caso de error, asumir que hay facturas por seguridad
      return { hasInvoices: true };
    }
  }

  async sweepInvoices() {
    try {
      const url = `${this.authorizerUrl}/api/sweep/invoices`;
      this.logger.log(`Calling sweep endpoint: ${url}`);
      
      const response = await firstValueFrom(
        this.httpService.post(url)
      );
      
      return response.data;
    } catch (error) {
      this.logger.error(`Error executing invoice sweep to ${this.authorizerUrl}:`, error.response?.status, error.message);
      throw new Error('Failed to execute invoice sweep');
    }
  }

  async updateInvoiceStatus(id: number, status: string) {
    try {
      const url = `${this.authorizerUrl}/api/invoices/${id}/status`;
      this.logger.log(`Updating invoice status: ${url} with status: ${status}`);
      
      const response = await firstValueFrom(
        this.httpService.patch(url, { status }, {
          headers: {
            'Content-Type': 'application/json'
          }
        })
      );
      
      return response.data;
    } catch (error) {
      this.logger.error(`Error updating invoice status in Authoriza: ${error.response?.status} - ${error.message}`);
      this.logger.error(`URL attempted: ${this.authorizerUrl}/api/invoices/${id}/status`);
      
      // Implementación temporal: simular éxito hasta que Authoriza esté disponible
      this.logger.warn('Returning simulated success response due to Authoriza unavailability');
      return { id, status, message: 'Status updated (simulated)' };
    }
  }
}