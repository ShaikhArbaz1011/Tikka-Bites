// Generate a realistic RestoBill backup with N bills for load testing.
// Usage: node scripts/gen-backup.mjs [count=50000] [out=screenshots/seed-50k.json]
// Restore it from Settings → Backup & restore. The app's strict validator
// re-checks every bill's arithmetic, so this doubles as a validator stress test.
import { writeFileSync } from 'node:fs';

const N = Number(process.argv[2] ?? 50_000);
const OUT = process.argv[3] ?? 'screenshots/seed-50k.json';

let s = 42;
const rnd = () => {
  s |= 0; s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const r = (n) => Math.floor(rnd() * n);

const dishSpec = [
  ['Paneer Tikka', 'Starters', 249, true], ['Veg Spring Roll', 'Starters', 179, true], ['Chicken 65', 'Starters', 229, false],
  ['Chilli Chicken', 'Starters', 249, false], ['Dal Makhani', 'Main Course', 219, true], ['Paneer Butter Masala', 'Main Course', 259, true],
  ['Butter Chicken', 'Main Course', 299, false], ['Mutton Rogan Josh', 'Main Course', 349, false], ['Veg Biryani', 'Rice', 199, true],
  ['Chicken Biryani', 'Rice', 269, false], ['Jeera Rice', 'Rice', 129, true], ['Butter Naan', 'Breads', 45, true],
  ['Garlic Naan', 'Breads', 59, true], ['Tandoori Roti', 'Breads', 25, true], ['Masala Chai', 'Drinks', 30, true],
  ['Sweet Lassi', 'Drinks', 60, true], ['Fresh Lime Soda', 'Drinks', 70, true], ['Gulab Jamun (2 pc)', 'Desserts', 80, true],
  ['Rasmalai', 'Desserts', 99, true], ['Kulfi', 'Desserts', 75, true],
];
const t0 = +new Date(2025, 3, 1);
const menu = dishSpec.map(([name, category, rupees, isVeg], i) => ({
  id: i + 1, name, nameLower: name.toLowerCase(), category, pricePaise: rupees * 100, isVeg,
  active: true, deleted: false, usedInBills: true, createdAt: t0, updatedAt: t0,
}));
const popularity = menu.map((_, i) => 1 / (1 + i * 0.35)); // a few dishes sell much more
const popTotal = popularity.reduce((a, b) => a + b, 0);
const pickDish = () => {
  let x = rnd() * popTotal;
  for (let i = 0; i < menu.length; i++) if ((x -= popularity[i]) <= 0) return menu[i];
  return menu[0];
};

const start = +new Date(2025, 3, 1);
const end = +new Date(2026, 8, 25, 22);
const HOURS = [11, 12, 12, 13, 13, 13, 14, 15, 17, 19, 19, 20, 20, 20, 21, 21, 22];
const counters = new Map();
const bills = [];
const times = Array.from({ length: N }, () => start + r(end - start)).sort((a, b) => a - b);
for (const tRaw of times) {
  const d = new Date(tRaw);
  d.setHours(HOURS[r(HOURS.length)], r(60), r(60), 0);
  const createdAt = +d;
  const monthKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const seq = (counters.get(monthKey) ?? 0) + 1;
  counters.set(monthKey, seq);
  const byId = new Map();
  for (let k = 1 + r(5); k > 0; k--) {
    const dish = pickDish();
    byId.set(dish.id, (byId.get(dish.id) ?? 0) + 1 + r(2));
  }
  const items = [...byId].map(([id, qty]) => {
    const m = menu[id - 1];
    return { menuId: id, name: m.name, category: m.category, isVeg: m.isVeg, unitPaise: m.pricePaise, qty, linePaise: m.pricePaise * qty };
  });
  const subtotal = items.reduce((a, i) => a + i.linePaise, 0);
  const discount = r(8) === 0 ? { kind: 'pct', bp: 1000 } : { kind: 'flat', paise: 0 };
  const discountPaise = discount.kind === 'pct' ? Math.floor((2 * subtotal * discount.bp + 10000) / 20000) : 0;
  const raw = subtotal - discountPaise;
  const total = Math.floor((raw + 50) / 100) * 100;
  const orderType = ['dine-in', 'dine-in', 'takeaway', 'delivery'][r(4)];
  const bill = {
    billNo: `INV-${monthKey}-${String(seq).padStart(4, '0')}`,
    createdAt, monthKey, hour: d.getHours(), weekday: d.getDay(), items, orderType,
    ...(orderType === 'dine-in' ? { tableNo: String(1 + r(15)) } : {}),
    paymentMode: ['cash', 'upi', 'upi', 'upi', 'card'][r(5)],
    discount, subtotalPaise: subtotal, discountPaise, roundOffPaise: total - raw, totalPaise: total,
    itemCount: items.reduce((a, i) => a + i.qty, 0),
    categories: [...new Set(items.map((i) => i.category))],
    hasVeg: items.some((i) => i.isVeg), hasNonVeg: items.some((i) => !i.isVeg),
    cheesyLine: 'Our food is like our bill — totally worth it 😋', status: 'paid',
  };
  if (r(100) === 0) Object.assign(bill, { status: 'void', voidReason: 'Customer cancelled', voidedAt: createdAt + 60_000 });
  bills.push(bill);
}

const backup = {
  app: 'restobill', schemaVersion: 1, exportedAt: Date.now(),
  settings: { name: 'Spice Garden', address: '14, MG Road, Pune', phone: '+91 98765 43210', currencySymbol: '₹', receiptWidth: '80', roundOff: true, lastBackupAt: Date.now() },
  menu,
  bills,
  cheesyLines: [{ id: 1, text: 'Our food is like our bill — totally worth it 😋', builtIn: true, active: true }],
  meta: {},
};
writeFileSync(OUT, JSON.stringify(backup));
console.log(`wrote ${bills.length} bills to ${OUT}`);
