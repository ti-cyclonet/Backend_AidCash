import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { Customer } from '../../customers/entities/customer.entity';
import { InvoiceItem } from './invoice-item.entity';

@Entity('invoices', { schema: 'billing' })
export class Invoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 50, unique: true })
  invoiceNumber: string;

  @Column()
  customerId: number;

  @Column('decimal', { precision: 10, scale: 2 })
  subtotal: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  tax: number;

  @Column('decimal', { precision: 10, scale: 2 })
  total: number;

  @Column({ type: 'date' })
  issueDate: Date;

  @Column({ type: 'date', nullable: true })
  dueDate: Date;

  @Column({ length: 20, default: 'pending' })
  status: string; // pending, paid, cancelled

  @Column({ length: 500, nullable: true })
  notes: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Customer, customer => customer.invoices)
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  @OneToMany(() => InvoiceItem, invoiceItem => invoiceItem.invoice, { cascade: true })
  items: InvoiceItem[];
}