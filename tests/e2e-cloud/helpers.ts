import { expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Shared-database e2e helpers (scripts/fake-supabase.mjs + the real schema in PostgreSQL). */
export const SUPABASE = 'http://localhost:54321';
export const KEY = 'anon-key-for-local-e2e-0000000000';

export const psql = (sql: string) => {
  const bin = process.env['PG_BIN'] ? join(process.env['PG_BIN'], 'psql') : 'psql';
  const r = spawnSync(bin, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', 'tb_e2e', '-c', sql], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** Network errors are expected here (offline phones, refused requests); anything else fails the test. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

export async function signIn(page: Page, user: string, pass: string) {
  const screen = page.locator('.auth-screen'); // the page behind it may have fields with the same names
  await screen.getByLabel('User ID').fill(user);
  await screen.getByLabel('Password', { exact: true }).fill(pass);
  await screen.getByRole('button', { name: 'Sign in' }).click();
}

/** A PC with Windows Hello reports a fingerprint sensor: then the offer shows; decline it. */
export async function declineFingerprint(page: Page) {
  const notNow = page.getByRole('button', { name: 'Not now' });
  await notNow.waitFor({ timeout: 5000 }).then(() => notNow.click(), () => undefined);
}

export async function appReady(page: Page) {
  try {
    await expect(page.locator('.auth-screen')).toHaveCount(0, { timeout: 30_000 });
  } catch {
    throw new Error(`Still showing: ${await page.locator('.auth-screen').first().innerText().catch(() => '?')}`);
  }
  await expect(page.locator('.nav-link').first()).toBeVisible();
}

export async function signOut(page: Page) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Tikka Bites' })).toBeVisible();
}
