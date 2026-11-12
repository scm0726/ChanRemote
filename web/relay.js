'use strict';
// 뷰어 쪽 공개 중계망(MQTT) 연결 — PC ID로 PC를 찾아 암호화된 메시지를 주고받음
(function () {
  const BROKERS = window.CR_BROKERS || [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  const PREFIX = 'chanremote/v1';
  const C = window.CRCrypto;
  const rid = n => C.hex(crypto.getRandomValues(new Uint8Array(n)));

  const clients = [];
  const subs = new Map(); // topic -> handler(obj)
  const seen = new Map();
  const statusListeners = new Set();

  function connectedCount() { return clients.filter(c => c.connected).length; }
  function emitStatus() { statusListeners.forEach(fn => { try { fn(connectedCount()); } catch { /* ignore */ } }); }

  function ensure() {
    if (clients.length || !window.mqtt) return;
    for (const url of BROKERS) {
      const c = window.mqtt.connect(url, {
        clientId: 'crv_' + rid(6), keepalive: 30, reconnectPeriod: 3000, connectTimeout: 10000, clean: true
      });
      c.on('connect', () => {
        for (const topic of subs.keys()) c.subscribe(topic, { qos: 1 });
        emitStatus();
      });
      c.on('close', emitStatus);
      c.on('offline', emitStatus);
      c.on('error', () => {});
      c.on('message', (topic, payload) => {
        const fn = subs.get(topic);
        if (!fn) return;
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        if (msg && msg.m) {
          if (seen.has(msg.m)) return;
          seen.set(msg.m, Date.now());
          if (seen.size > 2000) { const cut = Date.now() - 300000; for (const [k, t] of seen) if (t < cut) seen.delete(k); }
        }
        fn(msg, topic);
      });
      clients.push(c);
    }
  }

  function subscribe(topic, fn) {
    ensure();
    subs.set(topic, fn);
    clients.forEach(c => { if (c.connected) c.subscribe(topic, { qos: 1 }); });
  }
  function unsubscribe(topic) {
    subs.delete(topic);
    clients.forEach(c => { if (c.connected) { try { c.unsubscribe(topic); } catch { /* ignore */ } } });
  }
  function publish(topic, obj) {
    ensure();
    const s = JSON.stringify({ m: rid(6), ...obj });
    let n = 0;
    clients.forEach(c => { if (c.connected) { c.publish(topic, s, { qos: 1 }); n++; } });
    return n;
  }

  // PC 켜짐/꺼짐 (PC가 남겨둔 상태 + 끊기면 서버가 자동으로 '꺼짐' 표시)
  const presence = new Map(); // id -> {on, at}
  const presenceListeners = new Set();
  function watchPresence(id) {
    const topic = `${PREFIX}/${id}/p`;
    if (subs.has(topic)) return;
    subscribe(topic, (msg) => {
      presence.set(id, { on: !!msg.on, at: Date.now() });
      presenceListeners.forEach(fn => { try { fn(id, !!msg.on); } catch { /* ignore */ } });
    });
  }

  // PC와의 채널 하나 (뷰어 세션마다 새 cid)
  function openChannel(pcId) {
    const cid = rid(8);
    const myTopic = `${PREFIX}/${pcId}/v/${cid}`;
    const hostTopic = `${PREFIX}/${pcId}/h`;
    const ch = { kind: 'relay', kenc: null, closed: false, onmessage: null, onclose: null };
    let gotHello = false;

    subscribe(myTopic, (msg) => {
      if (ch.closed) return;
      if (msg.k === 'c') {
        let m;
        try { m = JSON.parse(msg.d); } catch { return; }
        if (m.t === 'hello') { gotHello = true; clearInterval(openTimer); }
        if (ch.onmessage) ch.onmessage(m);
      } else if (msg.k === 'x') {
        if (!ch.kenc) return;
        const t = C.open(ch.kenc, msg.d);
        if (t == null) return;
        let m;
        try { m = JSON.parse(t); } catch { return; }
        if (ch.onmessage) ch.onmessage(m);
      } else if (msg.k === 'end') {
        ch.close(true);
      }
    });

    const sendOpen = () => { if (!gotHello) publish(hostTopic, { k: 'open', c: cid }); };
    const openTimer = setInterval(sendOpen, 1200);
    setTimeout(sendOpen, 50);

    ch.send = obj => {
      if (ch.closed) return;
      const text = JSON.stringify(obj);
      if (ch.kenc) publish(hostTopic, { k: 'x', c: cid, d: C.seal(ch.kenc, text) });
    };
    ch.close = remote => {
      if (ch.closed) return;
      ch.closed = true;
      clearInterval(openTimer);
      if (!remote) publish(hostTopic, { k: 'end', c: cid });
      setTimeout(() => unsubscribe(myTopic), 500);
      if (ch.onclose) ch.onclose();
    };
    return ch;
  }

  window.CRRelay = {
    ensure,
    openChannel,
    watchPresence,
    presence: id => presence.get(id),
    onPresence: fn => presenceListeners.add(fn),
    onStatus: fn => statusListeners.add(fn),
    connectedCount,
    total: () => BROKERS.length,
    available: () => !!window.mqtt
  };
})();
