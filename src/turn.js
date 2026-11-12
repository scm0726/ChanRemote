'use strict';
// 내장 TURN 중계 서버 (RFC 5389 / 5766, UDP + TCP 수신)
// 밖(LTE)에서 직접 연결이 안 될 때, 폰 → (공유기 포트) → 이 PC의 중계 → 이 PC의 화면 전송 으로 이어준다.
// 보안: 이 PC 자신의 주소로만 중계를 허용한다 (남이 중계기로 악용 불가).
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

const MAGIC = 0x2112A442;
const METHOD = { BINDING: 1, ALLOCATE: 3, REFRESH: 4, SEND: 6, DATA: 7, CREATE_PERMISSION: 8, CHANNEL_BIND: 9 };
const CLS = { REQ: 0x0000, IND: 0x0010, OK: 0x0100, ERR: 0x0110 };
const ATTR = {
  MAPPED_ADDRESS: 0x0001, USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000C, LIFETIME: 0x000D, XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013,
  REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED_ADDRESS: 0x0016, REQUESTED_ADDRESS_FAMILY: 0x0017,
  REQUESTED_TRANSPORT: 0x0019, XOR_MAPPED_ADDRESS: 0x0020, SOFTWARE: 0x8022, FINGERPRINT: 0x8028
};
const PERMISSION_MS = 300 * 1000;
const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function parse(buf) {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  if (type & 0xC000) return null;
  const len = buf.readUInt16BE(2);
  if (buf.readUInt32BE(4) !== MAGIC || 20 + len > buf.length) return null;
  const msg = {
    method: (type & 0x000F) | ((type & 0x00E0) >> 1) | ((type & 0x3E00) >> 2),
    cls: type & 0x0110,
    tid: Buffer.from(buf.subarray(8, 20)),
    raw: buf.subarray(0, 20 + len),
    attrs: [],
    miOffset: -1
  };
  let off = 20;
  while (off + 4 <= 20 + len) {
    const t = buf.readUInt16BE(off);
    const l = buf.readUInt16BE(off + 2);
    if (off + 4 + l > 20 + len) return null;
    if (msg.miOffset < 0) {
      msg.attrs.push([t, buf.subarray(off + 4, off + 4 + l)]);
      if (t === ATTR.MESSAGE_INTEGRITY) msg.miOffset = off;
    }
    off += 4 + ((l + 3) & ~3);
  }
  msg.get = t => { const a = msg.attrs.find(x => x[0] === t); return a ? a[1] : null; };
  msg.all = t => msg.attrs.filter(x => x[0] === t).map(x => x[1]);
  return msg;
}

function attrHeader(t, l) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(t, 0);
  h.writeUInt16BE(l, 2);
  return h;
}

function build(method, cls, tid, attrs, key, fingerprint = true) {
  const parts = [];
  for (const [t, v] of attrs) {
    parts.push(attrHeader(t, v.length), v);
    const pad = (4 - (v.length % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  let body = Buffer.concat(parts);
  const type = (method & 0x000F) | ((method & 0x0070) << 1) | ((method & 0x0F80) << 2) | cls;
  const header = len => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(len, 2);
    h.writeUInt32BE(MAGIC, 4);
    tid.copy(h, 8);
    return h;
  };
  if (key) {
    const mi = crypto.createHmac('sha1', key).update(Buffer.concat([header(body.length + 24), body])).digest();
    body = Buffer.concat([body, attrHeader(ATTR.MESSAGE_INTEGRITY, 20), mi]);
  }
  if (fingerprint) {
    const fp = Buffer.alloc(4);
    fp.writeUInt32BE((crc32(Buffer.concat([header(body.length + 8), body])) ^ 0x5354554e) >>> 0);
    body = Buffer.concat([body, attrHeader(ATTR.FINGERPRINT, 4), fp]);
  }
  return Buffer.concat([header(body.length), body]);
}

function xorAddr(ip, port) {
  const v = Buffer.alloc(8);
  v.writeUInt8(0, 0);
  v.writeUInt8(1, 1);
  v.writeUInt16BE((port ^ (MAGIC >>> 16)) & 0xffff, 2);
  const n = ip.split('.').reduce((a, o) => ((a << 8) | (Number(o) & 0xff)) >>> 0, 0);
  v.writeUInt32BE((n ^ MAGIC) >>> 0, 4);
  return v;
}

function readXorAddr(v) {
  if (!v || v.length < 8 || v[1] !== 1) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const n = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { ip: [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), port };
}

function errorCode(code, reason) {
  const r = Buffer.from(reason, 'utf8');
  const v = Buffer.alloc(4 + r.length);
  v.writeUInt8(Math.floor(code / 100), 2);
  v.writeUInt8(code % 100, 3);
  r.copy(v, 4);
  return v;
}

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function localIps() {
  const set = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4') set.add(a.address);
  }
  return set;
}

function createTurnServer({ port, realm = 'chanremote', relayIp, log = () => {} }) {
  const users = new Map(); // username -> md5 key
  let nonce = crypto.randomBytes(12).toString('hex');
  const allocs = new Map(); // clientKey -> allocation
  let localSet = localIps();
  const software = Buffer.from('ChanRemote');

  const udp = dgram.createSocket({ type: 'udp4' });
  const tcp = net.createServer(sock => handleTcp(sock));

  function addUser(username, password) {
    users.set(username, crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest());
  }
  function removeUser(username) {
    users.delete(username);
    for (const [k, a] of allocs) if (a.username === username) freeAlloc(k);
  }

  function freeAlloc(key) {
    const a = allocs.get(key);
    if (!a) return;
    allocs.delete(key);
    try { a.relay.close(); } catch { /* ignore */ }
  }

  function permitted(a, ip) {
    const exp = a.perms.get(ip);
    return exp && exp > Date.now();
  }

  function fromPeer(a, data, rinfo) {
    if (!permitted(a, rinfo.address)) return;
    const ch = a.peerCh.get(`${rinfo.address}:${rinfo.port}`);
    if (ch) {
      const pad = a.client.tcp ? (4 - (data.length % 4)) % 4 : 0;
      const frame = Buffer.alloc(4 + data.length + pad);
      frame.writeUInt16BE(ch, 0);
      frame.writeUInt16BE(data.length, 2);
      data.copy(frame, 4);
      a.client.send(frame);
    } else {
      a.client.send(build(METHOD.DATA, CLS.IND, crypto.randomBytes(12), [
        [ATTR.XOR_PEER_ADDRESS, xorAddr(rinfo.address, rinfo.port)],
        [ATTR.DATA, data]
      ], null, false));
    }
  }

  function reply(client, msg, cls, attrs, key) {
    client.send(build(msg.method, cls, msg.tid, [...attrs, [ATTR.SOFTWARE, software]], key));
  }
  function replyError(client, msg, code, reason, key, extra = []) {
    reply(client, msg, CLS.ERR, [[ATTR.ERROR_CODE, errorCode(code, reason)], ...extra], key);
  }
  function challenge(client, msg, code = 401, reason = 'Unauthorized') {
    replyError(client, msg, code, reason, null, [[ATTR.REALM, Buffer.from(realm)], [ATTR.NONCE, Buffer.from(nonce)]]);
  }

  function authenticate(client, msg) {
    const user = msg.get(ATTR.USERNAME);
    if (!user || msg.miOffset < 0) { challenge(client, msg); return null; }
    const key = users.get(user.toString('utf8'));
    if (!key) { challenge(client, msg); return null; }
    const pre = Buffer.from(msg.raw.subarray(0, msg.miOffset));
    pre.writeUInt16BE(msg.miOffset + 24 - 20, 2);
    const expect = crypto.createHmac('sha1', key).update(pre).digest();
    const got = msg.raw.subarray(msg.miOffset + 4, msg.miOffset + 24);
    if (got.length !== 20 || !crypto.timingSafeEqual(expect, got)) { challenge(client, msg); return null; }
    const n = msg.get(ATTR.NONCE);
    if (!n || n.toString() !== nonce) { challenge(client, msg, 438, 'Stale Nonce'); return null; }
    return { key, username: user.toString('utf8') };
  }

  function handleStun(client, msg) {
    if (msg.method === METHOD.BINDING && msg.cls === CLS.REQ) {
      return reply(client, msg, CLS.OK, [[ATTR.XOR_MAPPED_ADDRESS, xorAddr(client.ip, client.port)]], null);
    }
    const a = allocs.get(client.key);
    if (msg.method === METHOD.SEND && msg.cls === CLS.IND) {
      if (!a) return;
      const peer = readXorAddr(msg.get(ATTR.XOR_PEER_ADDRESS));
      const data = msg.get(ATTR.DATA);
      if (peer && data && permitted(a, peer.ip)) a.relay.send(data, peer.port, peer.ip);
      return;
    }
    if (msg.cls !== CLS.REQ) return;
    if (![METHOD.ALLOCATE, METHOD.REFRESH, METHOD.CREATE_PERMISSION, METHOD.CHANNEL_BIND].includes(msg.method)) {
      return replyError(client, msg, 400, 'Bad Request');
    }
    const auth = authenticate(client, msg);
    if (!auth) return;
    const { key } = auth;

    switch (msg.method) {
      case METHOD.ALLOCATE: {
        if (a) {
          if (a.tid.equals(msg.tid)) return client.send(a.response); // 재전송
          return replyError(client, msg, 437, 'Allocation Mismatch', key);
        }
        const rt = msg.get(ATTR.REQUESTED_TRANSPORT);
        if (!rt || rt[0] !== 17) return replyError(client, msg, 442, 'Unsupported Transport Protocol', key);
        const fam = msg.get(ATTR.REQUESTED_ADDRESS_FAMILY);
        if (fam && fam[0] !== 1) return replyError(client, msg, 440, 'Address Family not Supported', key);
        const lt = msg.get(ATTR.LIFETIME);
        const lifetime = Math.min(MAX_LIFETIME, Math.max(DEFAULT_LIFETIME, lt ? lt.readUInt32BE(0) : DEFAULT_LIFETIME));
        const relay = dgram.createSocket({ type: 'udp4' });
        const alloc = {
          client, username: auth.username, relay, tid: msg.tid, response: null,
          perms: new Map(), channels: new Map(), peerCh: new Map(),
          expires: Date.now() + lifetime * 1000
        };
        allocs.set(client.key, alloc);
        relay.on('message', (data, rinfo) => fromPeer(alloc, data, rinfo));
        relay.on('error', () => freeAlloc(client.key));
        relay.bind(0, '0.0.0.0', () => {
          if (allocs.get(client.key) !== alloc) { try { relay.close(); } catch { /* ignore */ } return; }
          const rport = relay.address().port;
          alloc.response = build(msg.method, CLS.OK, msg.tid, [
            [ATTR.XOR_RELAYED_ADDRESS, xorAddr(relayIp(), rport)],
            [ATTR.XOR_MAPPED_ADDRESS, xorAddr(client.ip, client.port)],
            [ATTR.LIFETIME, u32(lifetime)],
            [ATTR.SOFTWARE, software]
          ], key);
          client.send(alloc.response);
        });
        return;
      }
      case METHOD.REFRESH: {
        if (!a) return replyError(client, msg, 437, 'Allocation Mismatch', key);
        const lt = msg.get(ATTR.LIFETIME);
        let lifetime = lt ? lt.readUInt32BE(0) : DEFAULT_LIFETIME;
        if (lifetime === 0) { freeAlloc(client.key); }
        else {
          lifetime = Math.min(MAX_LIFETIME, Math.max(DEFAULT_LIFETIME, lifetime));
          a.expires = Date.now() + lifetime * 1000;
        }
        return reply(client, msg, CLS.OK, [[ATTR.LIFETIME, u32(lifetime)]], key);
      }
      case METHOD.CREATE_PERMISSION: {
        if (!a) return replyError(client, msg, 437, 'Allocation Mismatch', key);
        const peers = msg.all(ATTR.XOR_PEER_ADDRESS).map(readXorAddr);
        if (!peers.length || peers.some(p => !p)) return replyError(client, msg, 400, 'Bad Request', key);
        if (peers.some(p => !localSet.has(p.ip))) return replyError(client, msg, 403, 'Forbidden', key);
        peers.forEach(p => a.perms.set(p.ip, Date.now() + PERMISSION_MS));
        return reply(client, msg, CLS.OK, [], key);
      }
      case METHOD.CHANNEL_BIND: {
        if (!a) return replyError(client, msg, 437, 'Allocation Mismatch', key);
        const chv = msg.get(ATTR.CHANNEL_NUMBER);
        const peer = readXorAddr(msg.get(ATTR.XOR_PEER_ADDRESS));
        const ch = chv ? chv.readUInt16BE(0) : 0;
        if (!peer || ch < 0x4000 || ch > 0x7FFE) return replyError(client, msg, 400, 'Bad Request', key);
        if (!localSet.has(peer.ip)) return replyError(client, msg, 403, 'Forbidden', key);
        const pk = `${peer.ip}:${peer.port}`;
        const existing = a.channels.get(ch);
        if (existing && `${existing.ip}:${existing.port}` !== pk) return replyError(client, msg, 400, 'Bad Request', key);
        const otherCh = a.peerCh.get(pk);
        if (otherCh && otherCh !== ch) return replyError(client, msg, 400, 'Bad Request', key);
        a.channels.set(ch, peer);
        a.peerCh.set(pk, ch);
        a.perms.set(peer.ip, Date.now() + PERMISSION_MS);
        return reply(client, msg, CLS.OK, [], key);
      }
    }
  }

  function handlePacket(client, buf) {
    if (buf.length < 4) return;
    if ((buf[0] & 0xC0) === 0x40) {
      const a = allocs.get(client.key);
      if (!a) return;
      const ch = buf.readUInt16BE(0);
      const len = buf.readUInt16BE(2);
      const peer = a.channels.get(ch);
      if (peer && permitted(a, peer.ip) && buf.length >= 4 + len) a.relay.send(buf.subarray(4, 4 + len), peer.port, peer.ip);
      return;
    }
    const msg = parse(buf);
    if (msg) {
      try { handleStun(client, msg); } catch (e) { log('TURN 오류: ' + e.message); }
    }
  }

  udp.on('message', (buf, rinfo) => {
    const client = {
      key: `udp:${rinfo.address}:${rinfo.port}`, ip: rinfo.address, port: rinfo.port, tcp: false,
      send: b => udp.send(b, rinfo.port, rinfo.address)
    };
    const a = allocs.get(client.key);
    handlePacket(a ? a.client : client, buf);
  });
  udp.on('error', e => log('TURN UDP 오류: ' + e.message));

  let tcpSeq = 0;
  function handleTcp(sock) {
    sock.setNoDelay(true);
    const client = {
      key: `tcp:${++tcpSeq}`, ip: (sock.remoteAddress || '').replace(/^::ffff:/, ''), port: sock.remotePort, tcp: true,
      send: b => { if (!sock.destroyed) sock.write(b); }
    };
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (buf.length > 1024 * 1024) { sock.destroy(); return; }
      while (buf.length >= 4) {
        let total;
        if ((buf[0] & 0xC0) === 0x40) total = 4 + ((buf.readUInt16BE(2) + 3) & ~3);
        else total = 20 + buf.readUInt16BE(2);
        if (buf.length < total) break;
        handlePacket(client, buf.subarray(0, total));
        buf = buf.subarray(total);
      }
    });
    const done = () => freeAlloc(client.key);
    sock.on('close', done);
    sock.on('error', done);
    sock.setTimeout(10 * 60 * 1000, () => sock.destroy());
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    localSet = localIps();
    for (const [k, a] of allocs) {
      if (a.expires < now) freeAlloc(k);
      else for (const [ip, exp] of a.perms) if (exp < now) a.perms.delete(ip);
    }
  }, 30000);

  return {
    addUser,
    removeUser,
    start() {
      return Promise.all([
        new Promise((res, rej) => { udp.once('error', rej); udp.bind(port, '0.0.0.0', () => { udp.removeListener('error', rej); res(); }); }),
        new Promise((res, rej) => { tcp.once('error', rej); tcp.listen(port, '0.0.0.0', () => { tcp.removeListener('error', rej); res(); }); })
      ]);
    },
    stop() {
      clearInterval(sweeper);
      for (const k of [...allocs.keys()]) freeAlloc(k);
      try { udp.close(); } catch { /* ignore */ }
      try { tcp.close(); } catch { /* ignore */ }
    },
    rotateNonce() { nonce = crypto.randomBytes(12).toString('hex'); }
  };
}

// 외부 STUN 서버로 이 PC의 실제 공인 IP 확인 (이중 NAT 감지용)
function stunPublicIp(host = 'stun.l.google.com', port = 19302, timeout = 3000) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const tid = crypto.randomBytes(12);
    const timer = setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve(null); }, timeout);
    sock.on('message', buf => {
      const msg = parse(buf);
      if (!msg || !msg.tid.equals(tid)) return;
      const addr = readXorAddr(msg.get(ATTR.XOR_MAPPED_ADDRESS));
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(addr ? addr.ip : null);
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
    sock.send(build(METHOD.BINDING, CLS.REQ, tid, [], null, false), port, host);
  });
}

module.exports = { createTurnServer, stunPublicIp, _internal: { parse, build, xorAddr, readXorAddr } };
