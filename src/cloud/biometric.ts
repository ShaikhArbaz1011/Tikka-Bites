/**
 * Fingerprint unlock (WebAuthn with the phone's built-in sensor: fingerprint, face
 * or screen lock; Windows Hello on a PC). After signing in with the password once,
 * a phone can be unlocked with the fingerprint. It guards opening the app on this
 * phone; the password stays the real account sign-in.
 */
import { getMeta, setMeta, deleteMeta } from '../db/settingsRepo';

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** User Verified flag in WebAuthn authenticator data (byte 32, bit 2): the fingerprint/PIN was checked. */
export function userVerified(authData: ArrayBuffer): boolean {
  const bytes = new Uint8Array(authData);
  return bytes.length > 32 && (bytes[32]! & 0x04) !== 0;
}

/** True if this phone/PC has a built-in fingerprint (or face / screen-lock) sensor the browser can use. */
export async function biometricAvailable(): Promise<boolean> {
  try {
    return (
      typeof window.PublicKeyCredential === 'function' &&
      typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function' &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

export async function biometricEnrolled(username?: string): Promise<boolean> {
  const b = await getMeta('biometric');
  return !!b && (username === undefined || b.username === username);
}

/** Turn on fingerprint unlock for this account on this phone (asks for the fingerprint once). */
export async function enrollBiometric(username: string): Promise<void> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Tikka Bites' }, // this website only
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: username, displayName: `Tikka Bites · ${username}` },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256 (Windows Hello)
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Fingerprint was not set up.');
  await setMeta('biometric', { credentialId: b64url(cred.rawId), username });
}

/** Ask for the fingerprint. True only if the phone confirms the person was verified. */
export async function verifyBiometric(): Promise<boolean> {
  const b = await getMeta('biometric');
  if (!b) return false;
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromB64url(b.credentialId), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    const res = cred?.response as AuthenticatorAssertionResponse | undefined;
    return !!res && b64url(cred!.rawId) === b.credentialId && userVerified(res.authenticatorData);
  } catch {
    return false; // cancelled, timed out, or the fingerprint didn't match
  }
}

export async function disableBiometric(): Promise<void> {
  await deleteMeta('biometric');
}
