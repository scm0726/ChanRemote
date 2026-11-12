'use strict';
// web/crypto.js 의 seal/open 과 똑같은 방식 (Node 버전)
const crypto = require('crypto');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function keys(kenc) { return { ks: hmac(kenc, 'ks'), km: hmac(kenc, 'mac') }; }

function stream(ks, iv, data) {
  const out = Buffer.alloc(data.length);
  for (let i = 0, b = 0; i < data.length; b++) {
    const block = hmac(ks, Buffer.concat([iv, u32(b)]));
    for (let j = 0; j < 32 && i < data.length; j++, i++) out[i] = data[i] ^ block[j];
  }
  return out;
}

function seal(kenc, text) {
  const { ks, km } = keys(kenc);
  const iv = crypto.randomBytes(16);
  const ct = stream(ks, iv, Buffer.from(String(text), 'utf8'));
  const tag = hmac(km, Buffer.concat([iv, ct])).subarray(0, 16);
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

function open(kenc, str) {
  let raw;
  try { raw = Buffer.from(String(str), 'base64'); } catch { return null; }
  if (raw.length < 32) return null;
  const iv = raw.subarray(0, 16), ct = raw.subarray(16, raw.length - 16), tag = raw.subarray(raw.length - 16);
  const { ks, km } = keys(kenc);
  const expect = hmac(km, Buffer.concat([iv, ct])).subarray(0, 16);
  if (!crypto.timingSafeEqual(expect, tag)) return null;
  return stream(ks, iv, ct).toString('utf8');
}

module.exports = { seal, open };
