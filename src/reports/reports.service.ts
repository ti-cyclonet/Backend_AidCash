import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { ReportFiltersDto } from './dto/report-filters.dto';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly authorizerUrl: string;
  private readonly EXCLUDED_TENANT_NAME = 'cyclonet';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.authorizerUrl = this.configService.get<string>('AUTH_SERVICE_URL', 'http://localhost:3000');
  }

  async getClientsReport(filters: ReportFiltersDto) {
    try {
      const invoices = await this.getInvoicesData(filters);
      const contracts = await this.getContractsData();

      const clientsMap = new Map();

      invoices.forEach(invoice => {
        const clientId = invoice.user?.id || invoice.userId;
        const clientName = invoice.user?.basicData?.legalEntityData?.businessName || 
                          invoice.user?.strUserName || 'N/A';

        if (!clientsMap.has(clientId)) {
          clientsMap.set(clientId, {
            id: clientId,
            name: clientName,
            totalInvoices: 0,
            totalAmount: 0,
            paidAmount: 0,
            pendingAmount: 0,
            overdueAmount: 0,
            activeContracts: 0
          });
        }

        const client = clientsMap.get(clientId);
        client.totalInvoices++;
        client.totalAmount += Number(invoice.value || 0);

        if (invoice.status === 'Paid') {
          client.paidAmount += Number(invoice.value || 0);
        } else if (invoice.status === 'In arrears' || invoice.status === 'Suspended') {
          client.overdueAmount += Number(invoice.value || 0);
        } else {
          client.pendingAmount += Number(invoice.value || 0);
        }
      });

      contracts.forEach(contract => {
        const clientId = contract.user?.id || contract.userId;
        if (clientsMap.has(clientId) && contract.status === 'ACTIVE') {
          clientsMap.get(clientId).activeContracts++;
        }
      });

      return {
        clients: Array.from(clientsMap.values()),
        summary: {
          totalClients: clientsMap.size,
          totalInvoiced: Array.from(clientsMap.values()).reduce((sum, c) => sum + c.totalAmount, 0),
          totalPaid: Array.from(clientsMap.values()).reduce((sum, c) => sum + c.paidAmount, 0),
          totalPending: Array.from(clientsMap.values()).reduce((sum, c) => sum + c.pendingAmount, 0),
          totalOverdue: Array.from(clientsMap.values()).reduce((sum, c) => sum + c.overdueAmount, 0)
        }
      };
    } catch (error) {
      this.logger.error('Error generating clients report:', error.message);
      throw error;
    }
  }

  async getContractsReport(filters: ReportFiltersDto) {
    try {
      const contracts = await this.getContractsData();
      
      let filteredContracts = contracts;
      
      if (filters.status) {
        filteredContracts = filteredContracts.filter(c => c.status === filters.status);
      }
      
      if (filters.customerId) {
        filteredContracts = filteredContracts.filter(c => c.user?.id === filters.customerId);
      }

      const contractsByStatus = filteredContracts.reduce((acc, contract) => {
        acc[contract.status] = (acc[contract.status] || 0) + 1;
        return acc;
      }, {});

      const contractsByMode = filteredContracts.reduce((acc, contract) => {
        acc[contract.mode] = (acc[contract.mode] || 0) + 1;
        return acc;
      }, {});

      return {
        contracts: filteredContracts.map(c => ({
          id: c.id,
          code: c.code,
          clientName: c.user?.basicData?.legalEntityData?.businessName || c.user?.strUserName || 'N/A',
          packageName: c.package?.name || 'N/A',
          value: Number(c.value),
          mode: c.mode,
          status: c.status,
          startDate: c.startDate,
          endDate: c.endDate
        })),
        summary: {
          totalContracts: filteredContracts.length,
          totalValue: filteredContracts.reduce((sum, c) => sum + Number(c.value), 0),
          byStatus: contractsByStatus,
          byMode: contractsByMode
        }
      };
    } catch (error) {
      this.logger.error('Error generating contracts report:', error.message);
      throw error;
    }
  }

  async getInvoicesReport(filters: ReportFiltersDto) {
    try {
      const invoices = await this.getInvoicesData(filters);

      const invoicesByStatus = invoices.reduce((acc, invoice) => {
        acc[invoice.status] = (acc[invoice.status] || 0) + 1;
        return acc;
      }, {});

      const invoicesByMonth = invoices.reduce((acc, invoice) => {
        const month = new Date(invoice.issueDate).toISOString().substring(0, 7);
        if (!acc[month]) {
          acc[month] = { count: 0, total: 0 };
        }
        acc[month].count++;
        acc[month].total += Number(invoice.value);
        return acc;
      }, {});

      return {
        invoices: invoices.map(inv => ({
          id: inv.id,
          code: inv.code,
          clientName: inv.user?.basicData?.legalEntityData?.businessName || inv.user?.strUserName || 'N/A',
          value: Number(inv.value),
          issueDate: inv.issueDate,
          expirationDate: inv.expirationDate,
          status: inv.status,
          globalParameters: inv.globalParameters || {}
        })),
        summary: {
          totalInvoices: invoices.length,
          totalAmount: invoices.reduce((sum, inv) => sum + Number(inv.value), 0),
          byStatus: invoicesByStatus,
          byMonth: invoicesByMonth
        }
      };
    } catch (error) {
      this.logger.error('Error generating invoices report:', error.message);
      throw error;
    }
  }

  async getProfitsReport(filters: ReportFiltersDto) {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.authorizerUrl}/api/invoices/profit-report`, {
          params: {
            startDate: filters.startDate,
            endDate: filters.endDate,
            contractId: filters.contractId
          }
        })
      );

      const profitData = response.data;
      
      const invoices = await this.getInvoicesData(filters);
      
      const profitsByMonth = invoices.reduce((acc, invoice) => {
        const month = new Date(invoice.issueDate).toISOString().substring(0, 7);
        if (!acc[month]) {
          acc[month] = { revenue: 0, profit: 0, margin: 0 };
        }
        acc[month].revenue += Number(invoice.value);
        acc[month].profit += Number(invoice.globalParameters?.profit_margin || 0);
        return acc;
      }, {});

      Object.keys(profitsByMonth).forEach(month => {
        const data = profitsByMonth[month];
        data.margin = data.revenue > 0 ? (data.profit / data.revenue) * 100 : 0;
      });

      return {
        summary: {
          totalRevenue: profitData.totalInvoiced || 0,
          totalProfit: profitData.totalProfit || 0,
          profitMargin: profitData.totalInvoiced > 0 
            ? (profitData.totalProfit / profitData.totalInvoiced) * 100 
            : 0,
          invoiceCount: profitData.invoiceCount || 0
        },
        byMonth: profitsByMonth,
        details: profitData.details || []
      };
    } catch (error) {
      this.logger.error('Error generating profits report:', error.message);
      throw error;
    }
  }

  async getTaxesReport(filters: ReportFiltersDto) {
    try {
      const invoices = await this.getInvoicesData(filters);

      const taxesByType = {};
      let totalTaxes = 0;

      invoices.forEach(invoice => {
        if (invoice.globalParameters) {
          Object.keys(invoice.globalParameters).forEach(key => {
            if (key.toLowerCase().includes('tax') || key.toLowerCase().includes('iva') || 
                key.toLowerCase().includes('ica') || key.toLowerCase().includes('retencion')) {
              if (!taxesByType[key]) {
                taxesByType[key] = {
                  name: key,
                  total: 0,
                  count: 0,
                  percentage: invoice.percentages?.[key] || 0
                };
              }
              taxesByType[key].total += Number(invoice.globalParameters[key]);
              taxesByType[key].count++;
              totalTaxes += Number(invoice.globalParameters[key]);
            }
          });
        }
      });

      const taxesByMonth = invoices.reduce((acc, invoice) => {
        const month = new Date(invoice.issueDate).toISOString().substring(0, 7);
        if (!acc[month]) {
          acc[month] = { total: 0, byType: {} };
        }
        
        if (invoice.globalParameters) {
          Object.keys(invoice.globalParameters).forEach(key => {
            if (key.toLowerCase().includes('tax') || key.toLowerCase().includes('iva') || 
                key.toLowerCase().includes('ica') || key.toLowerCase().includes('retencion')) {
              acc[month].total += Number(invoice.globalParameters[key]);
              acc[month].byType[key] = (acc[month].byType[key] || 0) + Number(invoice.globalParameters[key]);
            }
          });
        }
        return acc;
      }, {});

      return {
        summary: {
          totalTaxes,
          taxTypes: Object.keys(taxesByType).length,
          totalInvoices: invoices.length
        },
        byType: Object.values(taxesByType),
        byMonth: taxesByMonth
      };
    } catch (error) {
      this.logger.error('Error generating taxes report:', error.message);
      throw error;
    }
  }

  async getGlobalParametersReport(filters: ReportFiltersDto) {
    try {
      const invoices = await this.getInvoicesData(filters);

      const parametersSummary = {};

      invoices.forEach(invoice => {
        if (invoice.globalParameters) {
          Object.keys(invoice.globalParameters).forEach(key => {
            if (!parametersSummary[key]) {
              parametersSummary[key] = {
                name: key,
                total: 0,
                count: 0,
                average: 0,
                percentage: invoice.percentages?.[key] || 0,
                operationType: invoice.operationTypes?.[key] || 'add'
              };
            }
            parametersSummary[key].total += Number(invoice.globalParameters[key]);
            parametersSummary[key].count++;
          });
        }
      });

      Object.values(parametersSummary).forEach((param: any) => {
        param.average = param.count > 0 ? param.total / param.count : 0;
      });

      return {
        parameters: Object.values(parametersSummary),
        totalInvoices: invoices.length,
        totalParametersApplied: Object.keys(parametersSummary).length
      };
    } catch (error) {
      this.logger.error('Error generating global parameters report:', error.message);
      throw error;
    }
  }

  async getManagementIndicators(filters: ReportFiltersDto) {
    try {
      const [invoices, contracts] = await Promise.all([
        this.getInvoicesData(filters),
        this.getContractsData()
      ]);

      const totalRevenue = invoices.reduce((sum, inv) => sum + Number(inv.value), 0);
      const paidInvoices = invoices.filter(inv => inv.status === 'Paid');
      const paidRevenue = paidInvoices.reduce((sum, inv) => sum + Number(inv.value), 0);
      const overdueInvoices = invoices.filter(inv => 
        inv.status === 'In arrears' || inv.status === 'Suspended'
      );
      const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + Number(inv.value), 0);

      const totalProfit = invoices.reduce((sum, inv) => 
        sum + Number(inv.globalParameters?.profit_margin || 0), 0
      );

      const activeContracts = contracts.filter(c => c.status === 'ACTIVE');
      const averageContractValue = activeContracts.length > 0
        ? activeContracts.reduce((sum, c) => sum + Number(c.value), 0) / activeContracts.length
        : 0;

      const collectionRate = totalRevenue > 0 ? (paidRevenue / totalRevenue) * 100 : 0;
      const overdueRate = totalRevenue > 0 ? (overdueAmount / totalRevenue) * 100 : 0;
      const profitMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

      const currentMonth = new Date().getMonth();
      const currentYear = new Date().getFullYear();
      const monthlyInvoices = invoices.filter(inv => {
        const invDate = new Date(inv.issueDate);
        return invDate.getMonth() === currentMonth && invDate.getFullYear() === currentYear;
      });
      const monthlyRevenue = monthlyInvoices.reduce((sum, inv) => sum + Number(inv.value), 0);

      return {
        financial: {
          totalRevenue,
          paidRevenue,
          pendingRevenue: totalRevenue - paidRevenue - overdueAmount,
          overdueAmount,
          totalProfit,
          profitMargin,
          monthlyRevenue,
          averageInvoiceValue: invoices.length > 0 ? totalRevenue / invoices.length : 0
        },
        operational: {
          totalInvoices: invoices.length,
          paidInvoices: paidInvoices.length,
          pendingInvoices: invoices.filter(inv => 
            inv.status === 'Issued' || inv.status === 'Unconfirmed'
          ).length,
          overdueInvoices: overdueInvoices.length,
          collectionRate,
          overdueRate
        },
        contracts: {
          totalContracts: contracts.length,
          activeContracts: activeContracts.length,
          inactiveContracts: contracts.filter(c => c.status !== 'ACTIVE').length,
          averageContractValue,
          totalContractValue: activeContracts.reduce((sum, c) => sum + Number(c.value), 0)
        },
        trends: {
          monthlyInvoices: monthlyInvoices.length,
          monthlyRevenue,
          growthRate: 0 // Se puede calcular comparando con mes anterior
        }
      };
    } catch (error) {
      this.logger.error('Error generating management indicators:', error.message);
      throw error;
    }
  }

  private async getInvoicesData(filters?: ReportFiltersDto) {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.authorizerUrl}/api/invoices`)
      );

      let invoices = response.data;

      if (filters?.startDate) {
        invoices = invoices.filter(inv => 
          new Date(inv.issueDate) >= new Date(filters.startDate)
        );
      }

      if (filters?.endDate) {
        invoices = invoices.filter(inv => 
          new Date(inv.issueDate) <= new Date(filters.endDate)
        );
      }

      if (filters?.contractId) {
        invoices = invoices.filter(inv => inv.contractId === filters.contractId);
      }

      if (filters?.customerId) {
        invoices = invoices.filter(inv => inv.userId === filters.customerId);
      }

      if (filters?.status) {
        invoices = invoices.filter(inv => inv.status === filters.status);
      }

      return invoices.filter((inv: any) => !this.isCyclonetTenant(inv));
    } catch (error) {
      this.logger.error('Error fetching invoices:', error.message);
      return [];
    }
  }

  private isCyclonetTenant(record: any): boolean {
    const businessName = (record.user?.basicData?.legalEntityData?.businessName || '').toLowerCase();
    const userName = (record.user?.strUserName || '').toLowerCase();
    return businessName.includes(this.EXCLUDED_TENANT_NAME) || userName.includes(this.EXCLUDED_TENANT_NAME);
  }

  private async getContractsData() {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.authorizerUrl}/api/contract`)
      );
      return (response.data || []).filter((c: any) => !this.isCyclonetTenant(c));
    } catch (error) {
      this.logger.error('Error fetching contracts:', error.message);
      return [];
    }
  }
}
