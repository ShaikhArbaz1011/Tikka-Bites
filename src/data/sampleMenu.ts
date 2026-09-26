import type { DishInput } from '../db/menuRepo';

/**
 * The Tikka Bites menu (from the shop's menu card). Categories keep the menu's
 * own section names. Items with Half/Full or piece-count prices are separate
 * dishes, since each has its own price.
 */
type Row = [name: string, rupees: number, isVeg?: boolean];

const section = (category: string, rows: Row[]): DishInput[] =>
  rows.map(([name, rupees, isVeg = false]) => ({ name, category, pricePaise: rupees * 100, isVeg, active: true }));

export const TIKKA_BITES_MENU: DishInput[] = [
  ...section('Grill Gali', [
    ['Full Chicken', 450],
    ['Half Chicken', 250],
    ['Leg Piece (Bones)', 150],
    ['Breast Piece (Boneless)', 150],
    ['Chicken Tikka (5 Pcs)', 100],
    ['Chicken Tikka with Cheese', 120],
  ]),
  ...section('Lapete Mein', [
    ['Chicken Tikka Wrap', 150],
    ['Chicken Tikka Wrap with Cheese', 170],
  ]),
  ...section('Burger Adda', [
    ['Chicken Burger', 90],
    ['Chicken Tandoori Burger', 100],
    ['Chicken Burger with Cheese', 100],
    ['Chicken Tandoori Burger with Cheese', 110],
  ]),
  ...section('Toast Ka Dosh', [
    ['Chicken Tikka Grill Sandwich', 150],
    ['Chicken Tikka Grill Sandwich with Cheese', 160],
  ]),
  ...section('Murga Bole Kukdoo Koo', [
    ['Chicken Nuggets (6 Pcs)', 120],
    ['Chicken Nuggets (12 Pcs)', 200],
    ['Chicken Popcorn (6 Pcs)', 90],
    ['Chicken Popcorn (12 Pcs)', 120],
    ['Chicken Popcorn (24 Pcs)', 200],
    ['Chicken Strips (3 Pcs)', 120],
    ['Chicken Strips (6 Pcs)', 200],
  ]),
  ...section('Aloo Ke Laloo', [
    ['Finger Chips Salted – Half', 40, true],
    ['Finger Chips Salted – Full', 70, true],
    ['Finger Chips Spiced – Half', 45, true],
    ['Finger Chips Spiced – Full', 80, true],
    ['Gourmet Fries – Half', 50, true],
    ['Gourmet Fries – Full', 90, true],
    ['Chili Cheese Fries – Half', 60, true],
    ['Chili Cheese Fries – Full', 100, true],
  ]),
  ...section('Mitthu Miya (Seasonal)', [
    ['Sitafal Jal Crème – Half', 100, true],
    ['Sitafal Jal Crème – Full', 200, true],
    ['Meri Strawberry Crème – Half', 100, true],
    ['Meri Strawberry Crème – Full', 200, true],
    ['Mango Ki Maang Crème – Half', 100, true],
    ['Mango Ki Maang Crème – Full', 200, true],
  ]),
  ...section('Thanda Matter', [
    ['Smoothie (Seasonal Fruits)', 100, true],
    ['Fresh Juice (Seasonal Fruits)', 60, true],
    ['Soft Drink (250 ml)', 20, true],
    ['Water Bottle (500 ml)', 10, true],
    ['Water Bottle (1 L)', 20, true],
  ]),
];

/** Kept for older imports/tests. */
export const SAMPLE_MENU = TIKKA_BITES_MENU;
