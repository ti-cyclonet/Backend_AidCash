import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Invoice } from './invoice.entity';
import { Product } from '../../products/entities/product.entity';

@Entity('invoice_items', { schema: 'billing' })
export class InvoiceItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  invoiceId: number;

  @Column()
  productId: number;

  @Column()
  quantity: number;

  @Column('decimal', { precision: 10, scale: 2 })
  unitPrice: number;

  @Column('decimal', { precision: 10, scale: 2 })
  total: number;

  @ManyToOne(() => Invoice, invoice => invoice.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoiceId' })
  invoice: Invoice;

  @ManyToOne(() => Product, product => product.invoiceItems)
  @JoinColumn({ name: 'productId' })
  product: Product;
}