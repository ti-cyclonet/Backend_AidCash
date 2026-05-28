import { Injectable } from '@nestjs/common';

@Injectable()
export class DashboardService {
  getMetrics() {
    return {
      pendingInvoices: 5,
      paidInvoices: 12,
      totalContracts: 3,
      activeContracts: 2,
      totalRevenue: 15750.00,
      monthlyRevenue: 4200.00
    };
  }
}