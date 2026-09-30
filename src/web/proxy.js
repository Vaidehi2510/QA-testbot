// The browser's proxy enforces allowed destinations on every connection, even
// redirect hops that Playwright does not expose to a routing callback.
const http = require('node:http');
const net = require('node:net');

async function createPreviewProxy({ allowedOrigins, allowMutations, timeoutMs }) {
  const allowed = new Set(allowedOrigins);
  const sockets = new Set();
  let blocked = 0;
  const server = http.createServer((request, response) => {
    let target;
    try { target = new URL(request.url); } catch { response.writeHead(400); response.end(); return; }
    if (target.protocol !== 'http:' || target.username || target.password || !allowed.has(target.origin)
      || !allowMutations && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      blocked++; response.writeHead(403); response.end('Outside configured QA preview policy'); return;
    }
    const headers = { ...request.headers, host: target.host };
    for (const key of ['proxy-authorization', 'proxy-connection', 'connection']) delete headers[key];
    const upstream = http.request(target, { method: request.method, headers, timeout: timeoutMs }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      let bytes = 0;
      incoming.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { blocked++; upstream.destroy(); response.destroy(); }
      });
      incoming.on('error', () => { upstream.destroy(); response.destroy(); });
      incoming.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Preview request timeout')));
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connect', (request, client, head) => {
    let target;
    try { target = new URL(`https://${request.url}`); } catch { client.destroy(); return; }
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash || !allowed.has(target.origin)) {
      blocked++; client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443) });
    sockets.add(upstream);
    upstream.setTimeout(timeoutMs, () => upstream.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); });
  server.maxConnections = 64;
  server.requestTimeout = timeoutMs;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server: `http://127.0.0.1:${server.address().port}`, get blocked() { return blocked; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createPreviewProxy };
