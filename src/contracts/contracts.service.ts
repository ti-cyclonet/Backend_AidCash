import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);
  private readonly authorizerUrl: string;
  private readonly EXCLUDED_TENANT_NAME = 'cyclonet';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.authorizerUrl = this.configService.get<string>('AUTH_SERVICE_URL', 'http://localhost:3000');
  }

  async findAll(tenantId?: string, rol?: string, authToken?: string) {
    try {
      let url = `${this.authorizerUrl}/api/contracts`;
      
      // Si el usuario tiene rol 'adminInvoices', usar el endpoint específico por tenant
      // Si tiene rol 'adminFactonet', usar el endpoint general
      if (rol === 'adminInvoices' && tenantId) {
        url = `${this.authorizerUrl}/api/contracts/tenant/${tenantId}`;
      } else {
        url = `${this.authorizerUrl}/api/contracts?limit=100&offset=0`;
      }
      
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            'Authorization': authToken || `Bearer ${process.env.JWT_SECRET}`,
            'Content-Type': 'application/json'
          }
        })
      );
      
      const contracts = response.data?.data || response.data || [];
      return contracts.filter((contract: any) => !this.isCyclonetTenant(contract));
    } catch (error) {
      this.logger.error('Error fetching contracts from Authoriza:', error.message);
      return [];
    }
  }

  private isCyclonetTenant(contract: any): boolean {
    const businessName = (contract.user?.basicData?.legalEntityData?.businessName || '').toLowerCase();
    return businessName.includes(this.EXCLUDED_TENANT_NAME);
  }

  async updateStatus(contractId: string, status: string, authToken?: string) {
    try {
      const response = await fetch(`http://localhost:3000/api/contracts/${contractId}/status`, {
        method: 'PATCH',
        headers: {
          'Authorization': authToken || `Bearer ${process.env.JWT_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        const error = new Error(errorData.message || 'Failed to update contract status');
        (error as any).status = response.status;
        (error as any).response = { data: errorData };
        throw error;
      }
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  async uploadContractPDF(contractId: string, pdfBuffer: Buffer, authToken?: string): Promise<string> {
    try {
      const base64PDF = pdfBuffer.toString('base64');
      
      const response = await fetch(`http://localhost:3000/api/contracts/${contractId}/pdf`, {
        method: 'POST',
        headers: {
          'Authorization': authToken || `Bearer ${process.env.JWT_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ pdfBuffer: base64PDF })
      });
      
      if (!response.ok) {
        throw new Error('Failed to upload PDF');
      }
      
      const result = await response.json();
      return result.pdfUrl;
    } catch (error) {
      console.error('Error uploading PDF:', error);
      throw new Error('Failed to upload PDF to server');
    }
  }
}