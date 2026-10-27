import type { Paise } from '../core/money';
import type { Discount } from '../core/totals';
import type { BagState } from '../core/shuffleBag';

export type OrderType = 'dine-in' | 'takeaway' | 'delivery';
/** Payment modes offered for new bills. */
export type PaymentMode = 'cash' | 'upi';
/** Stored bills may also carry 'card' from before Card was removed; they stay readable. */
export type StoredPaymentMode = PaymentMode | 'card';
export type ReceiptWidth = '58' | '80' | 'A4';

export const ORDER_TYPES: readonly OrderType[] = ['dine-in', 'takeaway', 'delivery'];
export const PAYMENT_MODES: readonly PaymentMode[] = ['cash', 'upi'];
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
  paymentMode: StoredPaymentMode;
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
  /** Shared database: the temporary number printed while this bill was made offline (e.g. OFF-K7Q-0003). */
  printedAs?: string;
  /** Shared database, this phone only: the bill is waiting to be uploaded (its number is temporary). */
  sync?: { clientRef: string; error?: string };
  status: 'paid' | 'void';
  voidReason?: string;
  voidedAt?: number;
  /** Added later for an earlier date of the same month (owner request, 24 Oct 2026): when it was typed in. createdAt is the bill's own date. */
  enteredAt?: number;
  /**
   * The number this bill was first issued (printed) with, when it has since moved: receipt numbers
   * follow date order, so a bill entered later for an earlier date moves the later ones up by one
   * (owner request, 27 Oct 2026). Searching the old number still finds the bill.
   */
  oldNo?: string;
}

export interface Settings {
  name: string;
  /** Short line printed just below the logo, e.g. "Taste the Flame" (optional). */
  tagline?: string;
  address: string;
  phone: string;
  logoDataUrl?: string;
  currencySymbol: string;
  receiptWidth: ReceiptWidth;
  roundOff: boolean;
  /** Print the logo at the top of receipts (default true). */
  printLogo?: boolean;
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

/** Last receipt number used. Keyed by year (YYYY) since 24 Oct 2026; old month keys (YYYYMM) belong to the old monthly numbers. */
export interface Counter {
  monthKey: string;
  last: number;
}

export interface MetaMap {
  shuffleBag: BagState;
  cartDraft: unknown;
  sampleMenuOffered: boolean;
  // ---- Shared database (Supabase or Google Sheets) ----
  /** Which shared database this phone last used: "<backend> <url>" (src/cloud/boot.ts). */
  cloudBackend: string;
  /** Signed-in account on this phone. */
  session: CloudSession;
  /** Last change number received from the shared database. */
  cloudRev: number;
  /** Which shared database this phone's copy belongs to (changes if it was re-created). */
  cloudDbId: string;
  /** The server's renumberRev this copy has: a higher one means copy everything again. */
  renumberSeen: number;
  /** Short random code for this phone, used in temporary offline numbers (OFF-K7Q-0001). */
  deviceTag: string;
  /** Last temporary offline number used on this phone. */
  offSeq: number;
  /** Bills made offline, oldest first, waiting to be uploaded. */
  outbox: string[];
  /** When this phone last finished syncing (epoch ms). */
  lastSyncAt: number;
  /** Fingerprint unlock on this phone (WebAuthn platform credential). */
  biometric: { credentialId: string; username: string };
}

export interface CloudSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  userId: string;
  email: string;
  /** User ID typed at sign-in (or the email if they signed in with it). */
  username: string;
}
