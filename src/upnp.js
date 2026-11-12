'use strict';
// 공유기 자동 포트 열기 (UPnP IGD) — ipTIME 등 대부분의 가정용 공유기 지원
const dgram = require('dgram');
const http = require('http');

const SSDP_ADDR = '239.255.255.250';
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

function discover(timeout = 3000) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = [];
    sock.on('message', m => {
      const loc = /^location:\s*(\S+)/im.exec(m.toString());
      if (loc && !found.includes(loc[1])) found.push(loc[1]);
    });
    sock.on('error', () => { /* ignore */ });
    sock.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:1900`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', ''].join('\r\n'));
        sock.send(msg, 1900, SSDP_ADDR);
        setTimeout(() => { try { sock.send(msg, 1900, SSDP_ADDR); } catch { /* ignore */ } }, 600);
      }
    });
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve(found); }, timeout);
  });
}

function request(url, { method = 'GET', headers = {}, body = null, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), localAddress: req.socket && req.socket.localAddress }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
};

async function findService(location) {
  const res = await request(location);
  if (res.status !== 200) throw new Error('description ' + res.status);
  const xml = res.text;
  const base = tag(xml, 'URLBase') || location;
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map(m => m[1]);
  for (const s of services) {
    const type = tag(s, 'serviceType');
    const ctrl = tag(s, 'controlURL');
    if (type && ctrl && /WAN(IP|PPP)Connection/i.test(type)) {
      return { type, control: new URL(ctrl, base).toString(), localAddress: (res.localAddress || '').replace(/^::ffff:/, '') };
    }
  }
  throw new Error('WAN 서비스 없음');
}

async function soap(svc, action, args = {}) {
  const argXml = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${argXml}</u:${action}></s:Body></s:Envelope>`;
  const res = await request(svc.control, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"`, 'Content-Length': Buffer.byteLength(body) },
    body
  });
  if (res.status !== 200) {
    const code = tag(res.text, 'errorCode');
    const desc = tag(res.text, 'errorDescription');
    throw new Error(`${action} 실패 (${res.status}${code ? ' ' + code : ''}${desc ? ' ' + desc : ''})`);
  }
  return res.text;
}

let cachedSvc = null;

async function getService() {
  if (cachedSvc) return cachedSvc;
  const locations = await discover();
  for (const loc of locations) {
    try { cachedSvc = await findService(loc); return cachedSvc; } catch { /* 다음 후보 */ }
  }
  return null;
}

// mappings: [{ port, protocol: 'TCP'|'UDP' }]
async function mapPorts(mappings, description = 'ChanRemote') {
  let svc;
  try { svc = await getService(); } catch (e) { svc = null; }
  if (!svc) return { ok: false, reason: '공유기에서 UPnP를 찾지 못했어요 (공유기 설정에서 UPnP 켜기 필요)' };
  const results = [];
  for (const m of mappings) {
    const args = {
      NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: m.protocol, NewInternalPort: m.port,
      NewInternalClient: svc.localAddress, NewEnabled: 1, NewPortMappingDescription: `${description} ${m.protocol} ${m.port}`
    };
    try {
      await soap(svc, 'AddPortMapping', { ...args, NewLeaseDuration: 0 });
      results.push({ ...m, ok: true });
    } catch (e1) {
      try {
        await soap(svc, 'AddPortMapping', { ...args, NewLeaseDuration: 7200 });
        results.push({ ...m, ok: true });
      } catch (e2) {
        results.push({ ...m, ok: false, error: e2.message });
      }
    }
  }
  let externalIp = null;
  try { externalIp = tag(await soap(svc, 'GetExternalIPAddress'), 'NewExternalIPAddress'); } catch { /* ignore */ }
  const ok = results.every(r => r.ok);
  if (!ok) cachedSvc = null;
  return { ok, results, externalIp, internalIp: svc.localAddress, reason: ok ? null : results.filter(r => !r.ok).map(r => `${r.protocol} ${r.port}: ${r.error}`).join(', ') };
}

async function unmapPorts(mappings) {
  const svc = cachedSvc;
  if (!svc) return;
  for (const m of mappings) {
    try { await soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: m.protocol }); } catch { /* ignore */ }
  }
}

function resetCache() { cachedSvc = null; }

function isPrivateIp(ip) {
  if (!ip) return true;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a === 0;
}

module.exports = { mapPorts, unmapPorts, resetCache, isPrivateIp };
