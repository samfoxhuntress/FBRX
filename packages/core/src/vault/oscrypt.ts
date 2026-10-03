import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';

/**
 * Chromium's OSCrypt format on macOS, which Electron's safeStorage used for FBRX's vault key up to 1.8.0:
 * "v10" + AES-128-CBC, key = PBKDF2-SHA1(the Keychain item's password, "saltysalt", 1003 rounds), IV of 16 spaces.
 * Only ever used to bring an old key over (see MovedKeychain).
 */
const key = (password: string) => pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

export function openMacSafeStorage(password: string, data: Buffer): string {
  if (data.subarray(0, 3).toString() !== 'v10') throw new Error('The saved key has an unknown format.');
  const d = createDecipheriv('aes-128-cbc', key(password), IV);
  return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8');
}

/** The other direction, for tests. */
export function sealMacSafeStorage(password: string, text: string): Buffer {
  const c = createCipheriv('aes-128-cbc', key(password), IV);
  return Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]);
}
