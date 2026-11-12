'use strict';
// 뷰어 웹페이지 제공(HTTP) + 인증/시그널링(WebSocket)
// - 비밀번호는 오가지 않음: 서버가 준 일회용 nonce에 대한 HMAC 증명으로 로그인
// - 화면 연결 정보(SDP)는 세션키로 서명 → 중간에서 가로채 바꿔치기 불가
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const GRACE_MS = 30000; // 웹소켓이 끊겨도 이 시간 동안 세션 유지
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

const sign = (key, text) => crypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex');

function createSignalServer(opts) {
  const { port, webDir, auth, extraAuthOk, onJoin, onResume, onSignal, onLeave, log } = opts;
  const viewers = new Map(); // id -> { ws, sess, token, name, ip, since, leaveTimer }
  const fails = new Map();
  const root = path.resolve(webDir);

  const httpServer = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end(); }
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const file = path.resolve(path.join(root, urlPath));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 2 * 1024 * 1024 });

  const sendWs = (ws, msg) => {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  };

  wss.on('connection', (ws, req) => attach(ws, (req.socket.remoteAddress || '').replace(/^::ffff:/, '')));

  // ws: 실제 웹소켓 또는 중계망(MQTT) 가상 소켓 — 같은 인증/시그널링 처리
  function attach(ws, ip) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const nonce = crypto.randomBytes(16).toString('hex');
    let id = null;
    let sess = null;

    const info = auth.info();
    sendWs(ws, { t: 'hello', v: 2, salt: info.salt, iter: info.iter, nonce, host: info.hostName });

    const reject = (reason, code) => {
      sendWs(ws, { t: 'auth-fail', reason, code });
      setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 300);
    };

    const handleAuth = m => {
      const now = Date.now();
      let f = fails.get(ip);
      if (f && f.until && f.until <= now) { fails.delete(ip); f = null; }
      if (f && f.until > now) return reject(`비밀번호를 여러 번 틀려 잠겼어요. ${Math.ceil((f.until - now) / 1000)}초 후 다시 시도하세요`, 'locked');
      if (!auth.info().salt) return reject('호스트 PC에서 먼저 비밀번호를 설정하세요', 'nopw');
      if (!auth.verify(nonce, m.proof)) {
        const count = (f ? f.count : 0) + 1;
        fails.set(ip, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
        log(`비밀번호 오류 (${ip}) ${count}회`);
        return reject(count >= MAX_FAILS ? '비밀번호를 5번 틀려 5분간 잠겼어요' : '비밀번호가 틀렸어요', 'badpw');
      }
      fails.delete(ip);
      sess = auth.sessionKey(nonce);

      if (m.resume) {
        for (const [vid, v] of viewers) {
          if (v.token === m.resume) {
            clearTimeout(v.leaveTimer);
            v.leaveTimer = null;
            if (v.ws && v.ws !== ws) { try { v.ws.terminate(); } catch { /* ignore */ } }
            v.ws = ws;
            v.sess = sess;
            v.ip = ip;
            id = vid;
            sendWs(ws, { t: 'auth-ok', id, token: v.token, resumed: true, ...extraAuthOk(id) });
            log(`재연결: ${v.name} (${ip})`);
            if (onResume) onResume(id);
            return;
          }
        }
      }

      id = crypto.randomUUID();
      const token = crypto.randomBytes(18).toString('hex');
      const vinfo = { name: String(m.name || '뷰어').slice(0, 40), ip, since: now };
      viewers.set(id, { ws, sess, token, ...vinfo, leaveTimer: null });
      onJoin(id, vinfo); // TURN 계정 생성 등은 auth-ok 전에
      sendWs(ws, { t: 'auth-ok', id, token, ...extraAuthOk(id) });
      log(`접속: ${vinfo.name} (${ip})`);
    };

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') return sendWs(ws, { t: 'pong', ts: m.ts });
      if (!id) {
        if (m.t === 'auth') handleAuth(m);
        return;
      }
      const v = viewers.get(id);
      if (!v || v.ws !== ws) return;
      if (m.t === 'signal' && m.data && typeof m.data === 'object') {
        if (m.data.type === 'answer' && m.data.sig !== sign(v.sess, m.data.sdp)) {
          log('⚠ 서명이 맞지 않는 연결 정보를 무시했어요');
          return;
        }
        onSignal(id, m.data);
      } else if (m.t === 'bye') {
        removeViewer(id, '종료');
      }
    });

    ws.on('close', () => {
      if (!id) return;
      const v = viewers.get(id);
      if (!v || v.ws !== ws) return;
      v.ws = null;
      clearTimeout(v.leaveTimer);
      v.leaveTimer = setTimeout(() => removeViewer(id, '시간 초과'), GRACE_MS);
    });
    ws.on('error', () => { /* close에서 처리 */ });
  }

  function removeViewer(id, why) {
    const v = viewers.get(id);
    if (!v) return;
    clearTimeout(v.leaveTimer);
    viewers.delete(id);
    if (v.ws) { try { v.ws.close(); } catch { /* ignore */ } }
    log(`접속 종료: ${v.name} (${why})`);
    onLeave(id);
  }

  const hb = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } return; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, 10000);

  return {
    attach,
    start() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '0.0.0.0', () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });
    },
    // 호스트 → 뷰어 시그널 (offer는 현재 연결의 세션키로 서명)
    signal(id, data) {
      const v = viewers.get(id);
      if (!v || !v.ws) return;
      const out = { ...data };
      if (out.type === 'offer') out.sig = sign(v.sess, out.sdp);
      sendWs(v.ws, { t: 'signal', data: out });
    },
    kick(id) {
      const v = viewers.get(id);
      if (!v) return;
      sendWs(v.ws, { t: 'kicked' });
      setTimeout(() => removeViewer(id, '호스트가 끊음'), 100);
    },
    kickAll() {
      for (const id of [...viewers.keys()]) this.kick(id);
    },
    close() {
      clearInterval(hb);
      try { wss.close(); } catch { /* ignore */ }
      try { httpServer.close(); } catch { /* ignore */ }
    }
  };
}

module.exports = { createSignalServer };
