import type { DishInput } from '../db/menuRepo';

/**
 * The Tikka Bites menu (from the shop's menu card). Categories keep the menu's
 * own section names. Items with Half/Full or piece-count prices are separate
 * dishes, since each has its own price. Photos live in /public/dishes.
 */
type Row = [name: string, rupees: number, image: string, isVeg?: boolean];

const section = (category: string, rows: Row[]): DishInput[] =>
  rows.map(([name, rupees, image, isVeg = false]) => ({
    name,
    category,
    pricePaise: rupees * 100,
    isVeg,
    active: true,
    image: `/dishes/${image}.webp`,
  }));

export const TIKKA_BITES_MENU: DishInput[] = [
  ...section('Grill Gali', [
    ['Full Chicken', 450, 'grilled-chicken'],
    ['Half Chicken', 250, 'grilled-chicken'],
    ['Leg Piece (Bones)', 150, 'grilled-chicken'],
    ['Breast Piece (Boneless)', 150, 'grilled-chicken'],
    ['Chicken Tikka (5 Pcs)', 100, 'chicken-tikka'],
    ['Chicken Tikka with Cheese', 120, 'chicken-tikka'],
  ]),
  ...section('Lapete Mein', [
    ['Chicken Tikka Wrap', 150, 'tikka-wrap'],
    ['Chicken Tikka Wrap with Cheese', 170, 'tikka-wrap'],
  ]),
  ...section('Burger Adda', [
    ['Chicken Burger', 90, 'tandoori-burger'],
    ['Chicken Tandoori Burger', 100, 'tandoori-burger'],
    ['Chicken Burger with Cheese', 100, 'tandoori-burger'],
    ['Chicken Tandoori Burger with Cheese', 110, 'tandoori-burger'],
  ]),
  ...section('Toast Ka Dosh', [
    ['Chicken Tikka Grill Sandwich', 150, 'tikka-sandwich'],
    ['Chicken Tikka Grill Sandwich with Cheese', 160, 'tikka-sandwich'],
  ]),
  ...section('Murga Bole Kukdoo Koo', [
    ['Chicken Nuggets (6 Pcs)', 120, 'nuggets-popcorn'],
    ['Chicken Nuggets (12 Pcs)', 200, 'nuggets-popcorn'],
    ['Chicken Popcorn (6 Pcs)', 90, 'nuggets-popcorn'],
    ['Chicken Popcorn (12 Pcs)', 120, 'nuggets-popcorn'],
    ['Chicken Popcorn (24 Pcs)', 200, 'nuggets-popcorn'],
    ['Chicken Strips (3 Pcs)', 120, 'nuggets-popcorn'],
    ['Chicken Strips (6 Pcs)', 200, 'nuggets-popcorn'],
  ]),
  ...section('Aloo Ke Laloo', [
    ['Finger Chips Salted – Half', 40, 'finger-chips', true],
    ['Finger Chips Salted – Full', 70, 'finger-chips', true],
    ['Finger Chips Spiced – Half', 45, 'finger-chips', true],
    ['Finger Chips Spiced – Full', 80, 'finger-chips', true],
    ['Gourmet Fries – Half', 50, 'chilli-cheese-fries', true],
    ['Gourmet Fries – Full', 90, 'chilli-cheese-fries', true],
    ['Chili Cheese Fries – Half', 60, 'chilli-cheese-fries', true],
    ['Chili Cheese Fries – Full', 100, 'chilli-cheese-fries', true],
  ]),
  ...section('Mitthu Miya (Seasonal)', [
    ['Sitafal Jal Crème – Half', 100, 'creme', true],
    ['Sitafal Jal Crème – Full', 200, 'creme', true],
    ['Meri Strawberry Crème – Half', 100, 'creme', true],
    ['Meri Strawberry Crème – Full', 200, 'creme', true],
    ['Mango Ki Maang Crème – Half', 100, 'creme', true],
    ['Mango Ki Maang Crème – Full', 200, 'creme', true],
  ]),
  ...section('Thanda Matter', [
    ['Smoothie (Seasonal Fruits)', 100, 'drinks', true],
    ['Fresh Juice (Seasonal Fruits)', 60, 'drinks', true],
    ['Soft Drink (250 ml)', 20, 'drinks', true],
    ['Water Bottle (500 ml)', 10, 'drinks', true],
    ['Water Bottle (1 L)', 20, 'drinks', true],
  ]),
];

/** Kept for older imports/tests. */
export const SAMPLE_MENU = TIKKA_BITES_MENU;
