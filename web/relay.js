'use strict';
// 뷰어 쪽 공개 중계망(MQTT) 연결 — PC ID로 PC를 찾아 암호화된 메시지를 주고받음
(function () {
  const BROKERS = window.CR_BROKERS || [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  const PREFIX = 'chanremote/v1';
  const CLEAR = new Set(['hello', 'auth', 'auth-ok', 'auth-fail', 'kicked', 'ping', 'pong', 'bye']);
  const C = window.CRCrypto;
  const rid = n => C.hex(crypto.getRandomValues(new Uint8Array(n)));

  const clients = [];
  const subs = new Map(); // 정확한 topic -> handler(obj)
  const rawSubs = new Map(); // 와일드카드 필터 -> handler(payloadStr, topic) : 원시 payload
  const seen = new Map();
  const statusListeners = new Set();

  // MQTT 토픽 와일드카드(+, #) 매칭
  function topicMatch(filter, topic) {
    const f = filter.split('/'), t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true;
      if (f[i] === '+') { if (t[i] === undefined) return false; continue; }
      if (f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  }

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
        for (const filter of rawSubs.keys()) c.subscribe(filter, { qos: 1 });
        emitStatus();
      });
      c.on('close', emitStatus);
      c.on('offline', emitStatus);
      c.on('error', () => {});
      c.on('message', (topic, payload) => {
        const payloadStr = payload.toString();
        // 원시(와일드카드) 핸들러 먼저: 멤버 알림 등 평문 래핑이 아닌 경우
        for (const [filter, fn] of rawSubs) {
          if (topicMatch(filter, topic)) { try { fn(payloadStr, topic); } catch { /* ignore */ } }
        }
        const fn = subs.get(topic);
        if (!fn) return;
        let msg;
        try { msg = JSON.parse(payloadStr); } catch { return; }
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
    rawSubs.delete(topic);
    clients.forEach(c => { if (c.connected) { try { c.unsubscribe(topic); } catch { /* ignore */ } } });
  }
  function rawSubscribe(filter, fn) {
    ensure();
    rawSubs.set(filter, fn);
    clients.forEach(c => { if (c.connected) c.subscribe(filter, { qos: 1 }); });
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
      // 인증 전·인증용 메시지는 평문, 그 외(신호)는 비밀번호 키로 암호화
      if (ch.kenc && obj && !CLEAR.has(obj.t)) publish(hostTopic, { k: 'x', c: cid, d: C.seal(ch.kenc, text) });
      else publish(hostTopic, { k: 'c', c: cid, d: text });
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

  // 관리자 로그인: "내 PC 묶음" 토픽을 구독해, 마스터 키로 암호화된 멤버(이름)를 풀어 목록을 받음
  let fleetSub = null;
  function watchFleet(fleetId, encBytes, onMember) {
    stopFleet();
    fleetSub = `${PREFIX}/fleet/${fleetId}/#`;
    rawSubscribe(fleetSub, (payloadStr) => {
      if (!payloadStr) return; // 빈 payload = 묶음에서 제거됨(retained clear)
      const t = C.open(encBytes, payloadStr);
      if (t == null) return;
      let m;
      try { m = JSON.parse(t); } catch { return; }
      if (!m || !m.id) return;
      watchPresence(m.id);
      onMember(m.id, m.name || 'PC');
    });
  }
  function stopFleet() {
    if (fleetSub) {
      rawSubs.delete(fleetSub);
      clients.forEach(c => { if (c.connected) { try { c.unsubscribe(fleetSub); } catch { /* ignore */ } } });
      fleetSub = null;
    }
  }

  window.CRRelay = {
    ensure,
    openChannel,
    watchPresence,
    watchFleet,
    stopFleet,
    presence: id => presence.get(id),
    onPresence: fn => presenceListeners.add(fn),
    onStatus: fn => statusListeners.add(fn),
    connectedCount,
    total: () => BROKERS.length,
    available: () => !!window.mqtt
  };
})();
