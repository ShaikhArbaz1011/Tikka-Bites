import { describe, it, expect } from 'vitest';
import { resolveCloudConfig, connectSrc, NO_CLOUD, CloudConfigError } from '../../src/core/cloudConfig';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature_part_xx`;
const ANON = jwt({ role: 'anon', iss: 'supabase' });
const URL_OK = 'https://abcd1234.supabase.co';

describe('shared database config (cloud.config.json)', () => {
  it('both empty means local-only mode, exactly as before', () => {
    expect(resolveCloudConfig({ supabaseUrl: '', supabaseAnonKey: '' })).toEqual(NO_CLOUD);
    expect(resolveCloudConfig({})).toEqual(NO_CLOUD);
    expect(connectSrc(NO_CLOUD)).toBe("'self'");
  });

  it('keeps only the origin, and the page may talk to that one address', () => {
    const c = resolveCloudConfig({ supabaseUrl: ` ${URL_OK}/ `, supabaseAnonKey: ANON });
    expect(c).toEqual({ url: URL_OK, anonKey: ANON });
    expect(connectSrc(c)).toBe(`'self' ${URL_OK}`);
  });

  it('environment variables win over the file', () => {
    expect(resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: ANON }, { url: 'https://other.supabase.co' }).url).toBe('https://other.supabase.co');
  });

  it('plain http is allowed only for this computer (local tests)', () => {
    expect(resolveCloudConfig({ supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: ANON }).url).toBe('http://127.0.0.1:54321');
    expect(() => resolveCloudConfig({ supabaseUrl: 'http://abcd1234.supabase.co', supabaseAnonKey: ANON })).toThrow(CloudConfigError);
  });

  it.each([
    [{ supabaseUrl: URL_OK }, 'BOTH'],
    [{ supabaseAnonKey: ANON }, 'BOTH'],
    [{ supabaseUrl: 'abcd1234.supabase.co', supabaseAnonKey: ANON }, 'not a web address'],
    [{ supabaseUrl: `${URL_OK}/rest/v1`, supabaseAnonKey: ANON }, 'must look like'],
    [{ supabaseUrl: 'https://user:pw@abcd1234.supabase.co', supabaseAnonKey: ANON }, 'must look like'],
    [{ supabaseUrl: URL_OK, supabaseAnonKey: 'short' }, 'does not look like'],
    [{ supabaseUrl: URL_OK, supabaseAnonKey: 'has spaces in it and is long enough' }, 'does not look like'],
  ])('refuses %j', (file, msg) => {
    expect(() => resolveCloudConfig(file)).toThrow(msg);
  });

  it('refuses the SECRET key, which would bypass every security rule', () => {
    expect(() => resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: jwt({ role: 'service_role' }) })).toThrow('SECRET');
    expect(() => resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' })).toThrow('SECRET');
    expect(resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' }).anonKey).toMatch(/^sb_publishable_/);
  });
});
