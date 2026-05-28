import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreatePeriodDto } from './dto/create-period.dto';

@Injectable()
export class PeriodsService {
  private readonly authorizaUrl: string;

  constructor(private configService: ConfigService) {
    this.authorizaUrl = this.configService.get<string>('AUTH_SERVICE_URL') || 'http://localhost:3000';
  }

  async testConnection() {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods`);
      return {
        status: response.status,
        ok: response.ok,
        url: `${this.authorizaUrl}/api/periods`,
        message: response.ok ? 'Connection successful' : 'Connection failed'
      };
    } catch (error) {
      return {
        error: error.message,
        url: `${this.authorizaUrl}/api/periods`,
        message: 'Connection failed'
      };
    }
  }

  async createSubperiod(createSubperiodDto: any) {
    try {
      const payload = {
        name: createSubperiodDto.nombre,
        startDate: createSubperiodDto.fechaInicio,
        endDate: createSubperiodDto.fechaFin,
        parentPeriodId: createSubperiodDto.parentPeriodId
      };
      
      const response = await fetch(`${this.authorizaUrl}/api/periods/subperiods`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException(`Error creating subperiod: ${errorText}`, HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException(`Failed to connect to Authoriza service: ${error.message}`, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async create(createPeriodDto: CreatePeriodDto) {
    try {
      console.log('Creating period with data:', createPeriodDto);
      
      const payload = {
        name: createPeriodDto.nombre,
        startDate: createPeriodDto.fechaInicio + 'T00:00:00Z',
        endDate: createPeriodDto.fechaFin + 'T23:59:59Z',
      };
      
      console.log('Sending payload to Authoriza:', payload);
      
      const response = await fetch(`${this.authorizaUrl}/api/periods`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      
      console.log('Response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error from Authoriza:', errorText);
        throw new HttpException(`Error creating period: ${errorText}`, HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      console.log('Success result:', result);
      return result;
    } catch (error) {
      console.error('Service error:', error);
      throw new HttpException(`Failed to connect to Authoriza service: ${error.message}`, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async validateParameterName(name: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters/validate-name?name=${encodeURIComponent(name)}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException(`Error validating parameter name: ${errorText}`, HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException(`Failed to connect to Authoriza service: ${error.message}`, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async createGlobalParameter(createParameterDto: any) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createParameterDto),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException(`Error creating global parameter: ${errorText}`, HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException(`Failed to connect to Authoriza service: ${error.message}`, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async getActiveGlobalParameters() {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-periods/active`);
      
      if (!response.ok) {
        throw new HttpException('Error fetching active global parameters from Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async getGlobalParameters() {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters`);
      
      if (!response.ok) {
        throw new HttpException('Error fetching global parameters from Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async addParametersToPeriod(periodId: string, parametros: any[]) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/${periodId}/parameters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ parametros }),
      });
      
      if (!response.ok) {
        throw new HttpException('Error adding parameters to period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async getParametersByPeriod(periodId: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/${periodId}/parameters`);
      
      if (!response.ok) {
        throw new HttpException('Error fetching parameters from Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async findAll() {
    try {
      // Para FactoNet, solo obtener periodos globales (tenantId null)
      const response = await fetch(`${this.authorizaUrl}/api/periods`);
      
      if (!response.ok) {
        throw new HttpException('Error fetching periods from Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const allPeriods = await response.json();
      return allPeriods;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async updateParameterStatus(parameterId: string, status: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-periods/${parameterId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error updating parameter status in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async updateParameterValue(parameterId: string, value: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-periods/${parameterId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error updating parameter value in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async updateParameter(parameterId: string, data: any) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-periods/${parameterId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error updating parameter in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async deleteParameter(parameterId: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-periods/${parameterId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error deleting parameter in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async remove(periodId: string) {
    try {
      console.log('Removing period with ID:', periodId);
      
      const response = await fetch(`${this.authorizaUrl}/api/periods/${periodId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      console.log('Delete response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error deleting period:', errorText);
        throw new HttpException('Error deleting period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      console.log('Delete success result:', result);
      return result;
    } catch (error) {
      console.error('Delete service error:', error);
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async deactivate(periodId: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/${periodId}/deactivate`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error deactivating period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async getParametrosFacturas() {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-for-invoices`);
      
      if (!response.ok) {
        throw new HttpException('Error fetching invoice parameters from Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async guardarParametrosFacturas(parametros: any[]) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-for-invoices/bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parametros),
      });
      
      if (!response.ok) {
        throw new HttpException('Error saving invoice parameters in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async removeParameterFromPeriod(parameterId: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/global-parameters-periods/${parameterId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error deleting parameter from period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async forceRemove(periodId: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/${periodId}/force`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error force deleting period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async activate(periodId: string) {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/${periodId}/activate`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException('Error activating period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async getActivePeriod() {
    try {
      // Para FactoNet, obtener periodo activo global (tenantId null)
      const response = await fetch(`${this.authorizaUrl}/api/periods/active/tenant/null`);
      
      if (!response.ok) {
        throw new HttpException('Error fetching active period from Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async validateActivePeriod() {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/validation/check-active`);
      
      if (!response.ok) {
        throw new HttpException('Error validating active period in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async validatePeriodExpiry() {
    try {
      const response = await fetch(`${this.authorizaUrl}/api/periods/validation/validate-expiry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        throw new HttpException('Error validating period expiry in Authoriza', HttpStatus.BAD_GATEWAY);
      }

      return await response.json();
    } catch (error) {
      throw new HttpException('Failed to connect to Authoriza service', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}