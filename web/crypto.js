'use strict';
// 순수 JS SHA-256 / HMAC / PBKDF2 — http 페이지나 앱 어디서든 동작 (WebCrypto 불필요)
(function (root) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const W = new Uint32Array(64);

  function sha256(data) {
    const l = data.length;
    const n = ((l + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(n);
    buf.set(data);
    buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(n - 8, Math.floor(l / 0x20000000));
    dv.setUint32(n - 4, (l << 3) >>> 0);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (let off = 0; off < n; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setUint32(i * 4, v >>> 0));
    return out;
  }

  function concat(a, b) {
    const r = new Uint8Array(a.length + b.length);
    r.set(a); r.set(b, a.length);
    return r;
  }

  function hmac(key, msg) {
    if (key.length > 64) key = sha256(key);
    const k = new Uint8Array(64);
    k.set(key);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    return sha256(concat(opad, sha256(concat(ipad, msg))));
  }

  function pbkdf2(pw, salt, iter, len) {
    const out = new Uint8Array(len);
    let pos = 0;
    for (let block = 1; pos < len; block++) {
      const s = new Uint8Array(salt.length + 4);
      s.set(salt);
      new DataView(s.buffer).setUint32(salt.length, block);
      let u = hmac(pw, s);
      const t = u.slice();
      for (let i = 1; i < iter; i++) {
        u = hmac(pw, u);
        for (let j = 0; j < 32; j++) t[j] ^= u[j];
      }
      out.set(t.subarray(0, Math.min(32, len - pos)), pos);
      pos += 32;
    }
    return out;
  }

  const utf8 = s => new TextEncoder().encode(String(s));
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => new Uint8Array((String(h).match(/../g) || []).map(x => parseInt(x, 16)));

  root.CRCrypto = { sha256, hmac, pbkdf2, utf8, hex, unhex };
})(typeof window !== 'undefined' ? window : globalThis);

// 공개 중계망(MQTT)으로 오가는 메시지 암호화: HMAC-SHA256 카운터 모드 + HMAC 인증 (encrypt-then-MAC)
(function (root) {
  const C = root.CRCrypto;
  const u32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const cat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  function keys(kenc) { return { ks: C.hmac(kenc, C.utf8('ks')), km: C.hmac(kenc, C.utf8('mac')) }; }
  function stream(ks, iv, data) {
    const out = new Uint8Array(data.length);
    for (let i = 0, b = 0; i < data.length; b++) {
      const block = C.hmac(ks, cat(iv, u32(b)));
      for (let j = 0; j < 32 && i < data.length; j++, i++) out[i] = data[i] ^ block[j];
    }
    return out;
  }
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = str => { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
  function seal(kenc, text) {
    const { ks, km } = keys(kenc);
    const iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    const ct = stream(ks, iv, C.utf8(text));
    const tag = C.hmac(km, cat(iv, ct)).subarray(0, 16);
    return b64(cat(iv, ct, tag));
  }
  function open(kenc, str) {
    let raw;
    try { raw = unb64(str); } catch { return null; }
    if (raw.length < 32) return null;
    const iv = raw.subarray(0, 16), ct = raw.subarray(16, raw.length - 16), tag = raw.subarray(raw.length - 16);
    const { ks, km } = keys(kenc);
    const expect = C.hmac(km, cat(iv, ct));
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= expect[i] ^ tag[i];
    if (diff) return null;
    return new TextDecoder().decode(stream(ks, iv, ct));
  }
  C.seal = seal;
  C.open = open;
})(typeof window !== 'undefined' ? window : globalThis);
