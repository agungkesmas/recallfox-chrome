// lib/crypto.js — Enkripsi backup dengan Web Crypto API
// AES-GCM 256 + PBKDF2 100k iter
// RecallFox v0.1.0

const PBKDF2_ITER = 100000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITER,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBackup(jsonString, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);

  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(jsonString)
  );

  const payload = {
    format: 'recallfox-encrypted-backup',
    version: 1,
    kdf: { name: 'PBKDF2', iter: PBKDF2_ITER, hash: 'SHA-256', salt: bufToB64(salt) },
    cipher: { name: 'AES-GCM', iv: bufToB64(iv) },
    data: bufToB64(ciphertext)
  };
  return JSON.stringify(payload, null, 2);
}

export async function decryptBackup(fileContent, passphrase) {
  let payload;
  try {
    payload = JSON.parse(fileContent);
  } catch (e) {
    throw new Error('INVALID_BACKUP');
  }

  if (payload.format !== 'recallfox-encrypted-backup') {
    // try plain JSON
    if (payload.items || payload.version !== undefined) {
      return fileContent; // already plain
    }
    throw new Error('INVALID_BACKUP');
  }

  const salt = new Uint8Array(b64ToBuf(payload.kdf.salt));
  const iv = new Uint8Array(b64ToBuf(payload.cipher.iv));
  const key = await deriveKey(passphrase, salt);

  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      b64ToBuf(payload.data)
    );
  } catch (e) {
    throw new Error('WRONG_PASSPHRASE');
  }

  return new TextDecoder().decode(plainBuf);
}

// Simple check if string is encrypted backup format
export function isEncryptedBackup(content) {
  try {
    const p = JSON.parse(content);
    return p?.format === 'recallfox-encrypted-backup';
  } catch (e) {
    return false;
  }
}
