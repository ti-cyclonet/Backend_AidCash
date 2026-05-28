import { PartialType } from '@nestjs/mapped-types';
import { CreateInvoiceDto } from './create-invoice.dto';
import { IsString, IsOptional } from 'class-validator';

export class UpdateInvoiceDto extends PartialType(CreateInvoiceDto) {
  @IsString()
  @IsOptional()
  status?: string;
}