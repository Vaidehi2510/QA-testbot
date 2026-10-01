const { redact } = require('../ai/context');
class NativeProtocolError extends Error { constructor(message, { status = 'execution_error' } = {}) { super(message); this.status = status; } }
function nativeEndpoint(value) {
  if (typeof value !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:\/wd\/hub)?\/?$/.test(value)) throw new Error('Native server must use literal loopback HTTP(S), optionally /wd/hub');
  const parsed = new URL(value);
  if (parsed.port && Number(parsed.port) < 1) throw new Error('Invalid native server port');
  return parsed.href.replace(/\/$/, '');
}
class NativeClient {
  constructor({ serverUrl, timeoutMs, requestTimeoutMs, maxRequests, fetchImpl = globalThis.fetch }) {
    this.url = nativeEndpoint(serverUrl); this.deadline = Date.now() + timeoutMs;
    this.requestTimeoutMs = requestTimeoutMs; this.maxRequests = maxRequests; this.fetch = fetchImpl; this.requests = 0; this.bytes = 0;
  }
  async request(method, endpoint, body, { screenshot = false, cleanup = false } = {}) {
    // Only the fixed W3C subset used below is available, even to internal callers.
    if (!['GET', 'POST', 'DELETE'].includes(method) || !/^\/(?:session(?:\/[A-Za-z0-9_-]{1,160}(?:\/(?:elements|screenshot|element\/[A-Za-z0-9_-]{1,160}\/(?:displayed|text|click|clear|value)))?)?)$/.test(endpoint)) throw new NativeProtocolError('Native command is outside the fixed protocol allowlist');
    if (!cleanup && (this.requests >= this.maxRequests - 1 || Date.now() >= this.deadline)) throw new NativeProtocolError('Native request or total time budget is exhausted', { status: 'blocked' });
    if (cleanup && (method !== 'DELETE' || !/^\/session\/[A-Za-z0-9_-]+$/.test(endpoint))) throw new NativeProtocolError('Invalid cleanup command');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 16384) throw new NativeProtocolError('Native request body exceeds its limit');
    this.requests++;
    const timeout = cleanup ? Math.min(this.requestTimeoutMs, 5000) : Math.min(this.requestTimeoutMs, Math.max(1, this.deadline - Date.now()));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetch(`${this.url}${endpoint}`, { method, headers: { Accept: 'application/json', ...(encoded ? { 'Content-Type': 'application/json' } : {}) },
        ...(encoded ? { body: encoded } : {}), redirect: 'error', signal: controller.signal });
      const limit = screenshot ? 3 * 1024 * 1024 : 256 * 1024;
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new NativeProtocolError('Native response exceeds its byte limit');
      if (!response.body?.getReader) throw new NativeProtocolError('Native response has no readable body');
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; this.bytes += part.value.byteLength;
          if (bytes > limit || this.bytes > 16 * 1024 * 1024) throw new NativeProtocolError('Native response or run exceeds its byte budget');
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new NativeProtocolError('Native server returned truncated or invalid JSON'); }
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'value')) throw new NativeProtocolError('Native response is not a W3C result');
      if (!response.ok || value.value?.error) {
        const error = value.value?.error;
        throw new NativeProtocolError(`Native driver rejected ${method} ${endpoint}: ${redact(String(error || 'HTTP ' + response.status)).slice(0, 100)}`,
          { status: ['no such element', 'element not interactable', 'stale element reference'].includes(error) ? 'failed' : endpoint === '/session' ? 'blocked' : 'execution_error' });
      }
      if ((method === 'DELETE' || method === 'POST' && /\/(?:click|clear|value)$/.test(endpoint)) && value.value !== null) throw new NativeProtocolError('Native command did not return the required W3C null acknowledgement');
      return value.value;
    } catch (error) {
      if (error instanceof NativeProtocolError) throw error;
      throw new NativeProtocolError('Native server is unavailable, redirected, or exceeded its request timeout', { status: 'blocked' });
    } finally { clearTimeout(timer); }
  }
}
module.exports = { NativeClient, NativeProtocolError, nativeEndpoint };
