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
    expect(c).toEqual({ backend: 'supabase', url: URL_OK, anonKey: ANON });
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

  it('backend "supabase" needs both values; an unknown backend is refused', () => {
    expect(resolveCloudConfig({ backend: 'supabase', supabaseUrl: URL_OK, supabaseAnonKey: ANON }).backend).toBe('supabase');
    expect(() => resolveCloudConfig({ backend: 'supabase' })).toThrow('BOTH');
    expect(() => resolveCloudConfig({ backend: 'firebase' })).toThrow('backend must be');
    expect(resolveCloudConfig({ backend: '', sheetsUrl: '' })).toEqual(NO_CLOUD);
  });

  it('refuses the SECRET key, which would bypass every security rule', () => {
    expect(() => resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: jwt({ role: 'service_role' }) })).toThrow('SECRET');
    expect(() => resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' })).toThrow('SECRET');
    expect(resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' }).anonKey).toMatch(/^sb_publishable_/);
  });
});

describe('Google Sheets backend (backend "sheets", sheetsUrl)', () => {
  const EXEC = 'https://script.google.com/macros/s/AKfycbx1234567890abcdef_-XYZ/exec';

  it('takes the web app address; the page may talk only to Google’s two web app addresses', () => {
    const c = resolveCloudConfig({ backend: 'sheets', sheetsUrl: ` ${EXEC} `, supabaseUrl: URL_OK, supabaseAnonKey: ANON });
    expect(c).toEqual({ backend: 'sheets', url: EXEC, anonKey: '' });
    expect(connectSrc(c)).toBe("'self' https://script.google.com https://script.googleusercontent.com");
  });

  it('environment variables win (Netlify can switch it without a code change)', () => {
    expect(resolveCloudConfig({ supabaseUrl: URL_OK, supabaseAnonKey: ANON }, { backend: 'sheets', sheetsUrl: EXEC }).backend).toBe('sheets');
    expect(resolveCloudConfig({ backend: 'sheets', sheetsUrl: EXEC, supabaseUrl: URL_OK, supabaseAnonKey: ANON }, { backend: 'supabase' }).backend).toBe('supabase');
  });

  it('Google Workspace addresses work; local test servers only on this computer', () => {
    expect(resolveCloudConfig({ backend: 'sheets', sheetsUrl: 'https://script.google.com/a/macros/tikka.in/s/AKfycbx1234567890/exec' }).backend).toBe('sheets');
    const local = resolveCloudConfig({ backend: 'sheets', sheetsUrl: 'http://localhost:54330/macros/s/fake-e2e-deployment/exec' });
    expect(connectSrc(local)).toBe("'self' http://localhost:54330");
  });

  it.each([
    [{ backend: 'sheets' }, 'sheetsUrl is empty'],
    [{ backend: 'sheets', sheetsUrl: 'script.google.com/macros/s/AKfycbx1234567890/exec' }, 'sheetsUrl must be'],
    [{ backend: 'sheets', sheetsUrl: 'http://script.google.com/macros/s/AKfycbx1234567890/exec' }, 'sheetsUrl must be'],
    [{ backend: 'sheets', sheetsUrl: 'https://evil.example.com/macros/s/AKfycbx1234567890/exec' }, 'sheetsUrl must be'],
    [{ backend: 'sheets', sheetsUrl: 'https://script.google.com/macros/s/AKfycbx1234567890/dev' }, 'sheetsUrl must be'],
    [{ backend: 'sheets', sheetsUrl: `${EXEC}?x=1` }, 'sheetsUrl must be'],
    [{ backend: 'sheets', sheetsUrl: 'https://docs.google.com/spreadsheets/d/1abcdefghijk/edit' }, 'sheetsUrl must be'],
  ])('refuses %j', (file, msg) => {
    expect(() => resolveCloudConfig(file)).toThrow(msg);
  });

  it('still refuses a Supabase SECRET key left in the file', () => {
    expect(() => resolveCloudConfig({ backend: 'sheets', sheetsUrl: EXEC, supabaseUrl: URL_OK, supabaseAnonKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' })).toThrow('SECRET');
  });
});
