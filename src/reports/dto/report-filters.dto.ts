import { IsOptional, IsDateString, IsString, IsEnum } from 'class-validator';

export enum ReportType {
  CLIENTS = 'clients',
  CONTRACTS = 'contracts',
  INVOICES = 'invoices',
  PROFITS = 'profits',
  TAXES = 'taxes',
  GLOBAL_PARAMETERS = 'global_parameters',
  MANAGEMENT_INDICATORS = 'management_indicators'
}

export class ReportFiltersDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  contractId?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsEnum(ReportType)
  reportType?: ReportType;
}
