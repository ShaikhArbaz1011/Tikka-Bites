import type { Paise } from '../core/money';
import type { Discount } from '../core/totals';
import type { BagState } from '../core/shuffleBag';

export type OrderType = 'dine-in' | 'takeaway' | 'delivery';
export type PaymentMode = 'cash' | 'upi' | 'card';
export type ReceiptWidth = '58' | '80' | 'A4';

export const ORDER_TYPES: readonly OrderType[] = ['dine-in', 'takeaway', 'delivery'];
export const PAYMENT_MODES: readonly PaymentMode[] = ['cash', 'upi', 'card'];
export const RECEIPT_WIDTHS: readonly ReceiptWidth[] = ['58', '80', 'A4'];

export interface Dish {
  id: number;
  name: string;
  nameLower: string;
  category: string;
  pricePaise: Paise;
  isVeg: boolean;
  active: boolean;
  deleted: boolean;
  usedInBills: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BillItem {
  menuId: number;
  name: string;
  category: string;
  isVeg: boolean;
  unitPaise: Paise;
  qty: number;
  linePaise: Paise;
}

export interface Bill {
  billNo: string;
  createdAt: number;
  monthKey: string;
  hour: number;
  weekday: number;
  items: BillItem[];
  orderType: OrderType;
  tableNo?: string;
  customerName?: string;
  paymentMode: PaymentMode;
  discount: Discount;
  subtotalPaise: Paise;
  discountPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
  itemCount: number;
  categories: string[];
  hasVeg: boolean;
  hasNonVeg: boolean;
  cheesyLine: string;
  status: 'paid' | 'void';
  voidReason?: string;
  voidedAt?: number;
}

export interface Settings {
  name: string;
  address: string;
  phone: string;
  logoDataUrl?: string;
  currencySymbol: string;
  receiptWidth: ReceiptWidth;
  roundOff: boolean;
  lastBackupAt?: number;
}

export interface CheesyLine {
  id: number;
  text: string;
  builtIn: boolean;
  active: boolean;
}

export interface CountPaise {
  count: number;
  paise: Paise;
}
export interface QtyPaise {
  qty: number;
  paise: Paise;
}

/** Pre-aggregated totals for one month (or any filtered set of bills in Reports). */
export interface Stats {
  billCount: number;
  voidCount: number;
  revenuePaise: Paise;
  discountPaise: Paise;
  itemsSold: number;
  byPayment: Record<string, CountPaise>;
  byOrderType: Record<string, CountPaise>;
  byCategory: Record<string, QtyPaise>;
  byDish: Record<string, QtyPaise & { name: string }>;
  byHour: CountPaise[]; // 24
  byWeekday: CountPaise[]; // 7, Sun = 0
  byDay: Record<string, Paise>; // day of month → revenue
}

export interface MonthlyStats extends Stats {
  monthKey: string;
}

export interface Counter {
  monthKey: string;
  last: number;
}

export interface MetaMap {
  shuffleBag: BagState;
  cartDraft: unknown;
  sampleMenuOffered: boolean;
}
