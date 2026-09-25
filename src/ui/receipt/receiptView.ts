import type { Bill } from '../../db/types';
import { toast } from '../components/toast';

/** Placeholder until the receipt phase: confirms the save. */
export function showReceipt(bill: Bill, _opts: { autoPrint?: boolean } = {}): void {
  toast(`${bill.billNo} saved`, 'success');
}
