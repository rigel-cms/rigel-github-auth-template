import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import app from '../src/gateway.ts';

await mkdir('_temp', { recursive: true });
const profile = await mkdtemp(`${process.cwd()}/_temp/chrome-`);
const realFetch = globalThis.fetch;
const errors = [];
const requests = [];
const callbacks = [];
const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).map(value => {
  value /= 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
let exchanges = 0;
let gatewayOrigin;
let openerOrigin;
let mode = 'success';
const tokens = { access_token: 'browser-test-access', refresh_token: 'browser-test-refresh', token_type: 'bearer', scope: '', expires_in: 28800, refresh_token_expires_in: 15897600 };
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'https://github.com/login/oauth/access_token');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('client_secret'), 'browser-fixture-secret');
  assert.equal(form.get('client_id'), 'browser-fixture');
  assert.ok(form.has('code_verifier') || form.get('grant_type') === 'refresh_token');
  exchanges++;
  return mode === 'failure' ? Response.json({ error: 'private-provider-detail' }, { status: 400 }) : Response.json(tokens);
};
const gateway = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, gatewayOrigin);
    requests.push(url.href);
    if (url.pathname === '/fixture-inspect') {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Content-Security-Policy', "default-src 'none'; connect-src 'self'");
      response.end('<!doctype html><title>Cookie and refresh inspection fixture</title>');
      return;
    }
    const env = { GH_CLIENT_ID: 'browser-fixture', GH_CLIENT_SECRET: 'browser-fixture-secret', AUTH_SECRET: 'browser-fixture-encryption-secret-1234567890', SITE_ORIGIN: gatewayOrigin, ...(mode.startsWith('public') ? {} : { ALLOWED_ORIGINS: openerOrigin }) };
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await app.request(url.href, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }, env);
    response.statusCode = result.status;
    for (const [key, value] of result.headers) if (key !== 'set-cookie') response.setHeader(key, key === 'content-security-policy' ? value.replace('https://github.com', openerOrigin) : value);
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('Set-Cookie', cookies);
    if (url.pathname === '/authorize' && [302, 303].includes(result.status)) {
      const provider = new URL(result.headers.get('location'));
      assert.equal(provider.origin, 'https://github.com');
      assert.equal(provider.searchParams.get('scope'), 'offline_access');
      assert.equal(provider.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(provider.searchParams.get('redirect_uri'), `${gatewayOrigin}/callback`);
      response.setHeader('Location', `${openerOrigin}/mock-github?${provider.searchParams}`);
    }
    const body = await result.text();
    if (url.pathname === '/callback') callbacks.push({ status: result.status, body, headers: result.headers });
    response.end(body);
  } catch (error) { errors.push(String(error)); response.statusCode = 500; response.end('Browser fixture failed'); }
});
const opener = createServer((request, response) => {
  const url = new URL(request.url, openerOrigin);
  requests.push(url.href);
  if (url.pathname === '/mock-github') {
    const callback = new URL('/callback', gatewayOrigin);
    callback.searchParams.set('state', mode === 'state' ? 'wrong-state' : url.searchParams.get('state'));
    callback.searchParams.set(mode === 'denial' ? 'error' : 'code', mode === 'denial' ? 'access_denied' : 'synthetic-code');
    response.writeHead(302, { Location: callback.href });
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  response.end(`<!doctype html><meta charset="utf-8"><title>Separate-origin editor fixture</title><script>
  window.received = [];
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.origin !== ${JSON.stringify(gatewayOrigin)} || event.source !== window.authPopup || !data || data.type !== 'rigel:auth' || data.provider !== 'github' || data.nonce !== 'browser-test-nonce-1234567890123456') return;
    if (typeof data.error !== 'string' && !(typeof data.access_token === 'string' && Number.isInteger(data.expires_in) && data.expires_in > 0)) return;
    window.received.push(data);
  });
  </script>`);
});
let chrome;
let socket;
try {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  gatewayOrigin = `http://localhost:${gateway.address().port}`;
  opener.listen(0, '127.0.0.1');
  await once(opener, 'listening');
  openerOrigin = `http://localhost:${opener.address().port}`;
  assert.notEqual(gatewayOrigin, openerOrigin);
  chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
    chrome.on('error', reject);
    chrome.stderr.on('data', chunk => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && message.params.entry.text.includes('Content Security Policy')) errors.push(message.params.entry.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser timeout: ${expression}`);
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `${openerOrigin}/` });
  await waitFor('document.readyState === "complete" && Array.isArray(window.received)');
  for (const scenario of ['success', 'denial', 'failure', 'state', 'forbidden', 'public', 'public-cancel']) {
    mode = scenario;
    const before = exchanges;
    await evaluate('window.received = []; window.authPopup = window.open("about:blank", "rigel-auth-test"); true');
    assert.equal(await evaluate('!!window.authPopup'), true);
    await evaluate(`(() => {
      const data = { type: 'rigel:auth', provider: 'github', nonce: 'browser-test-nonce-1234567890123456', access_token: 'forged', expires_in: 60 };
      for (const event of [
        { origin: 'https://evil.example', source: window.authPopup, data },
        { origin: ${JSON.stringify(gatewayOrigin)}, source: window, data },
        { origin: ${JSON.stringify(gatewayOrigin)}, source: window.authPopup, data: { ...data, nonce: 'wrong' } }
      ]) window.dispatchEvent(new MessageEvent('message', event));
    })()`);
    assert.equal(await evaluate('window.received.length'), 0);
    const url = `${gatewayOrigin}/authorize?${new URLSearchParams({ origin: scenario === 'forbidden' ? 'https://evil.example' : openerOrigin, nonce: 'browser-test-nonce-1234567890123456' })}`;
    const previousCallbacks = callbacks.length;
    await evaluate(`window.authPopup.location = ${JSON.stringify(url)}; true`);
    if (scenario.startsWith('public')) {
      let popupSession;
      for (let n = 0; n < 100; n++) {
        const target = (await send('Target.getTargets')).targetInfos.find(target => target.url === url);
        if (target) { popupSession = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(popupSession, 'public confirmation popup must be visible');
      const popupEvaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, popupSession);
        assert.equal(result.exceptionDetails, undefined);
        return result.result.value;
      };
      for (let n = 0; n < 100 && !await popupEvaluate('!!document.querySelector("button")'); n++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(await popupEvaluate('document.querySelector("code")?.textContent'), openerOrigin);
      assert.equal(await popupEvaluate('document.querySelector("button")?.textContent'), 'Continue to GitHub');
      assert.equal(await popupEvaluate('document.querySelectorAll("script, iframe, link").length'), 0);
      assert.equal(await popupEvaluate('Promise.all([...document.images].map(image => image.decode())).then(() => [...document.images].every(image => image.naturalWidth === 128))'), true);
      assert.equal(exchanges, before, 'no provider exchange before confirmation');
      assert.equal(await evaluate('window.received.length'), 0);
      if (scenario === 'public-cancel') {
        await evaluate('window.authPopup.close()');
        assert.equal(callbacks.length, previousCallbacks);
        continue;
      }
      await send('Runtime.enable', {}, popupSession);
      await send('Log.enable', {}, popupSession);
      for (const theme of ['light', 'dark']) {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, popupSession);
        for (const width of [600, 390, 320]) {
          await send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false }, popupSession);
          assert.equal(await popupEvaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme} ${width} overflow`);
          assert.equal(await popupEvaluate('getComputedStyle(document.documentElement).colorScheme'), theme);
          const colors = await popupEvaluate(`(() => {
            const style = selector => getComputedStyle(document.querySelector(selector));
            return { surface: style('main').backgroundColor, text: style('h1').color, muted: style('p').color, destination: style('.destination').backgroundColor, code: style('code').color, button: style('button').backgroundColor, onButton: style('button').color };
          })()`);
          for (const [foreground, background] of [['text', 'surface'], ['muted', 'surface'], ['code', 'destination'], ['onButton', 'button']]) assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${theme} ${foreground} contrast`);
          assert.equal(await popupEvaluate('document.querySelector("button").getBoundingClientRect().height >= 44'), true);
          await writeFile(`_temp/auth-${theme}-${width}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, popupSession)).data, 'base64'));
        }
      }
      await popupEvaluate('document.querySelector("code").textContent = "https://" + "long-editor-domain".repeat(10) + ".example"');
      assert.equal(await popupEvaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'long origin must wrap without clipping');
      await popupEvaluate(`document.querySelector('code').textContent = ${JSON.stringify(openerOrigin)}`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, popupSession);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, popupSession);
      assert.equal(await popupEvaluate('document.activeElement === document.querySelector("button") && document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineWidth === "3px"'), true);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 }, popupSession);
    }
    if (['success', 'denial', 'failure', 'public'].includes(scenario)) {
      await waitFor('window.received.length === 1 && window.authPopup.closed');
      const result = await evaluate('window.received[0]');
      assert.equal(result.type, 'rigel:auth');
      assert.equal(result.provider, 'github');
      assert.equal(result.nonce, 'browser-test-nonce-1234567890123456');
      assert.equal('refresh_token' in result, false);
      if (['success', 'public'].includes(scenario)) assert.equal(result.access_token, tokens.access_token);
      else assert.equal(result.error, scenario === 'denial' ? 'Authorization denied' : 'Token exchange failed');
      const callback = callbacks.at(-1);
      assert.equal(callback.status, 200);
      assert.equal((callback.body.match(/<script/g) || []).length, 1);
      assert.ok(!callback.body.includes('src='));
      const nonce = callback.body.match(/<script nonce="([^"]+)">/)[1];
      assert.ok(callback.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
      assert.equal(callback.headers.get('cross-origin-opener-policy'), 'unsafe-none');
      assert.ok(!callback.body.includes(tokens.refresh_token));
      assert.ok(!callback.body.includes('private-provider-detail'));
    } else {
      for (let n = 0; n < 100; n++) {
        if (scenario === 'state' ? callbacks.length > previousCallbacks : requests.includes(url)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(await evaluate('window.received.length'), 0);
      if (scenario === 'state') assert.equal(callbacks.at(-1).status, 400);
      else {
        assert.ok(requests.includes(url));
        const denied = await realFetch(url);
        assert.equal(denied.status, 403);
      }
      await evaluate('window.authPopup.close()');
    }
    assert.equal(exchanges - before, ['success', 'failure', 'public'].includes(scenario) ? 1 : 0);
  }
  mode = 'success';
  const crossOriginRefresh = await evaluate(`fetch(${JSON.stringify(`${gatewayOrigin}/refresh`)}, { method: 'POST', credentials: 'include', headers: { 'X-Rigel-CSRF': '1' } }).then(() => 'allowed', () => 'blocked')`);
  assert.equal(crossOriginRefresh, 'blocked');
  await cdp('Page.navigate', { url: `${gatewayOrigin}/fixture-inspect` });
  await waitFor(`location.origin === ${JSON.stringify(gatewayOrigin)} && document.readyState === 'complete'`);
  assert.equal(await evaluate('document.cookie'), '');
  const cookies = (await cdp('Network.getCookies', { urls: [gatewayOrigin] })).cookies;
  const refreshCookie = cookies.find(cookie => cookie.name === 'rigel-refresh');
  assert.ok(refreshCookie?.httpOnly);
  assert.ok(!refreshCookie.value.includes(tokens.refresh_token));
  const refreshed = await evaluate(`fetch('/refresh', { method: 'POST', headers: { 'X-Rigel-CSRF': '1' } }).then(async response => ({ status: response.status, body: await response.json() }))`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.access_token, tokens.access_token);
  assert.equal('refresh_token' in refreshed.body, false);
  for (const url of requests) {
    assert.ok(!url.includes(tokens.access_token) && !url.includes(tokens.refresh_token));
    assert.ok(['/', '/authorize', '/callback', '/refresh', '/health', '/fixture-inspect', '/favicon.ico', '/mock-github'].includes(new URL(url).pathname), `Unexpected asset/analytics request: ${url}`);
  }
  assert.deepEqual(errors, []);
  assert.equal(exchanges, 4);
  console.log('PASS: 7 cross-origin popup scenarios; branded consent in light/dark at 600/390/320px, long-origin wrapping, AA text/button contrast, embedded logo, 44px action, keyboard focus and Enter submission; public cancellation; message-spoof guards; nonce-only callback CSP; HttpOnly encrypted refresh; same-origin refresh; cross-origin refresh blocked; no URL tokens or external assets/analytics. GitHub transport mocked (4 exchanges).');
} finally {
  globalThis.fetch = realFetch;
  gateway.closeAllConnections();
  gateway.close();
  opener.closeAllConnections();
  opener.close();
  socket?.close();
  if (chrome && chrome.exitCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGKILL'); await exited; }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
