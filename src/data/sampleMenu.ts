import type { DishInput } from '../db/menuRepo';

const d = (name: string, category: string, rupees: number, isVeg: boolean): DishInput => ({
  name,
  category,
  pricePaise: rupees * 100,
  isVeg,
  active: true,
});

/** Optional starter menu offered on first run. */
export const SAMPLE_MENU: DishInput[] = [
  d('Paneer Tikka', 'Starters', 249, true),
  d('Veg Spring Roll', 'Starters', 179, true),
  d('Chicken 65', 'Starters', 229, false),
  d('Chilli Chicken', 'Starters', 249, false),
  d('Dal Makhani', 'Main Course', 219, true),
  d('Paneer Butter Masala', 'Main Course', 259, true),
  d('Butter Chicken', 'Main Course', 299, false),
  d('Mutton Rogan Josh', 'Main Course', 349, false),
  d('Veg Biryani', 'Rice', 199, true),
  d('Chicken Biryani', 'Rice', 269, false),
  d('Jeera Rice', 'Rice', 129, true),
  d('Butter Naan', 'Breads', 45, true),
  d('Garlic Naan', 'Breads', 59, true),
  d('Tandoori Roti', 'Breads', 25, true),
  d('Masala Chai', 'Drinks', 30, true),
  d('Sweet Lassi', 'Drinks', 60, true),
  d('Fresh Lime Soda', 'Drinks', 70, true),
  d('Gulab Jamun (2 pc)', 'Desserts', 80, true),
  d('Rasmalai', 'Desserts', 99, true),
  d('Kulfi', 'Desserts', 75, true),
];
