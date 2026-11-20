export const credentialPattern = /^[a-f0-9]{64}$/;
export const timestamp = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const randomCredential = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
export const digest = async value => hex(new Uint8Array(await sha256(value)));

export function uclaAddress(email) {
  if (typeof email !== 'string' || email.length > 254) return null;
  const match = /^([a-z0-9._+-]+)@(?:g\.)?ucla\.edu$/i.exec(email.trim());
  return match ? `${match[1].toLowerCase()}@ucla.edu` : null;
}
