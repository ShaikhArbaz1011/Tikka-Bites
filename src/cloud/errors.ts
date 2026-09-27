/**
 * offline   – no connection / timed out (safe to retry)
 * auth      – not signed in, or the sign-in expired
 * not-staff – signed in, but the owner has not put this account on the staff list
 * rejected  – the database refused the change; `message` says why (written for people)
 * setup     – the database is missing a table/function: run supabase/schema.sql again
 * rejoin    – the shared database was replaced by a new one (different dbId)
 * server    – anything else on the server side
 */
export type CloudErrorKind = 'offline' | 'auth' | 'not-staff' | 'rejected' | 'setup' | 'rejoin' | 'server';

/** A problem with the shared database. `message` is always safe to show to the person using the app. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly kind: CloudErrorKind,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export const OFFLINE_MESSAGE = 'No internet connection. Check the connection and try again.';
export const SIGNED_OUT_MESSAGE = 'Your sign-in has expired. Please sign in again.';
