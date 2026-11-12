'use strict';
// 공개 무료 MQTT 서버(가입·키 불필요)를 이용한 "PC ID로 서로 찾기"
// - PC는 바깥으로 접속만 하므로 포트포워딩이 필요 없음
// - 3곳에 동시에 접속 → 한 곳이 멈춰도 계속 동작
// - hello / auth-fail 외의 모든 메시지는 비밀번호에서 만든 키로 암호화 (공개 서버라도 내용을 볼 수 없음)
const mqtt = require('mqtt');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { seal, open } = require('./seal');

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];
const PREFIX = 'chanremote/v1';
const CLEAR_TYPES = new Set(['hello', 'auth-fail']);
const IDLE_MS = 45000;
const MAX_CONNS = 20;

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

class VirtualSocket extends EventEmitter {
  constructor(relay, cid) {
    super();
    this.relay = relay;
    this.cid = cid;
    this.readyState = 1;
    this.kenc = null;
    this.authed = false;
    this.lastSeen = Date.now();
  }
  send(text) {
    if (this.readyState !== 1) return;
    let obj = null;
    try { obj = JSON.parse(text); } catch { /* ignore */ }
    if (obj && obj.t === 'hello') {
      const K = this.relay.getKey();
      this.kenc = K ? crypto.createHmac('sha256', K).update('enc:' + obj.nonce).digest() : null;
    }
    if (obj && obj.t === 'auth-ok') this.authed = true;
    if ((obj && CLEAR_TYPES.has(obj.t)) || !this.kenc) this.relay.toViewer(this.cid, { k: 'c', d: text });
    else this.relay.toViewer(this.cid, { k: 'x', d: seal(this.kenc, text) });
  }
  receive(text) {
    this.lastSeen = Date.now();
    this.emit('message', text);
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.relay.toViewer(this.cid, { k: 'end' });
    this.relay.conns.delete(this.cid);
    this.emit('close');
  }
  terminate() { this.close(); }
  ping() { /* MQTT 쪽은 자체 생존 확인 사용 */ }
}

function createMqttRelay({ deviceId, getKey, onViewer, log = () => {}, onStatus = () => {}, brokers = BROKERS }) {
  const hostTopic = `${PREFIX}/${deviceId}/h`;
  const presenceTopic = `${PREFIX}/${deviceId}/p`;
  const seen = new Map();
  const conns = new Map();
  const status = brokers.map(url => ({ url, connected: false }));
  const clients = [];
  let stopped = false;

  const relay = { getKey, conns, toViewer: null };

  function emitStatus() {
    onStatus({ connected: status.filter(s => s.connected).length, total: status.length, brokers: status.map(s => ({ host: new URL(s.url).hostname, connected: s.connected })) });
  }

  function publish(topic, obj, opts = {}) {
    const payload = JSON.stringify({ m: rid(6), ...obj });
    for (const c of clients) {
      if (c.connected) c.publish(topic, payload, { qos: 1, ...opts });
    }
  }
  relay.toViewer = (cid, obj) => publish(`${PREFIX}/${deviceId}/v/${cid}`, obj);

  function handle(str) {
    let msg;
    try { msg = JSON.parse(str); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.m || seen.has(msg.m)) return;
    seen.set(msg.m, Date.now());
    const cid = String(msg.c || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    if (!cid) return;
    if (msg.k === 'open') {
      if (conns.has(cid)) return; // 재전송된 open
      if (conns.size >= MAX_CONNS) return;
      const sock = new VirtualSocket(relay, cid);
      conns.set(cid, sock);
      onViewer(sock);
      return;
    }
    const sock = conns.get(cid);
    if (!sock) {
      // PC가 재시작되는 등으로 모르는 연결 → 다시 열라고 알려줌
      if (msg.k === 'x') relay.toViewer(cid, { k: 'end' });
      return;
    }
    if (msg.k === 'x') {
      const text = sock.kenc ? open(sock.kenc, msg.d) : null;
      if (text == null) {
        // 비밀번호가 틀려서 해독 실패 → 인증 실패로 처리
        if (!sock.authed && !sock.failed) { sock.failed = true; sock.receive(JSON.stringify({ t: 'auth', proof: '' })); }
        return;
      }
      sock.receive(text);
    } else if (msg.k === 'end') {
      sock.close();
    }
  }

  brokers.forEach((url, i) => {
    const c = mqtt.connect(url, {
      clientId: 'crh_' + rid(6),
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      clean: true,
      will: { topic: presenceTopic, payload: JSON.stringify({ on: 0 }), qos: 1, retain: true }
    });
    let warned = false;
    c.on('connect', () => {
      status[i].connected = true;
      warned = false;
      c.subscribe(hostTopic, { qos: 1 });
      c.publish(presenceTopic, JSON.stringify({ on: 1, t: Date.now() }), { qos: 1, retain: true });
      emitStatus();
    });
    c.on('close', () => { if (status[i].connected) { status[i].connected = false; emitStatus(); } });
    c.on('offline', () => { status[i].connected = false; emitStatus(); });
    c.on('error', e => { if (!warned) { warned = true; log(`중계망 연결 오류 (${new URL(url).hostname}): ${e.message}`); } });
    c.on('message', (_t, payload) => handle(payload.toString()));
    clients.push(c);
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [m, ts] of seen) if (now - ts > 5 * 60 * 1000) seen.delete(m);
    for (const sock of [...conns.values()]) if (now - sock.lastSeen > IDLE_MS) sock.close();
  }, 10000);

  emitStatus();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(sweeper);
      for (const c of clients) {
        try { if (c.connected) c.publish(presenceTopic, JSON.stringify({ on: 0 }), { qos: 1, retain: true }); } catch { /* ignore */ }
        try { c.end(false); } catch { /* ignore */ }
      }
    },
    status: () => ({ connected: status.filter(s => s.connected).length, total: status.length })
  };
}

module.exports = { createMqttRelay, BROKERS, PREFIX };
