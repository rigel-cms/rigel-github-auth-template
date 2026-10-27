import { html } from 'hono/html'
import { rigelLogo } from './rigel-logo.ts'

export function consentPage(target: string, csrf: string, nonce: string) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to GitHub | Rigel CMS</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      --background: #F8FAFC;
      --surface: #FFFFFF;
      --surface-raised: #F1F5F9;
      --text: #080F1C;
      --muted: #475569;
      --border: #CBD5E1;
      --accent: #005AA3;
      --accent-hover: #084B85;
      --on-accent: #FFFFFF;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --background: #080F1C;
        --surface: #111C2E;
        --surface-raised: #1E293B;
        --text: #F8FAFC;
        --muted: #B6C5D8;
        --border: #334155;
        --accent: #72D8FF;
        --accent-hover: #ADE8FF;
        --on-accent: #080F1C;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      padding: 32px 16px;
      display: grid;
      place-items: center;
      background: var(--background);
      color: var(--text);
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    }
    main { width: 100%; max-width: 480px; padding: 32px; background: var(--surface); border: 1px solid var(--border); }
    header { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 700; }
    header img { width: 32px; height: 32px; flex-shrink: 0; }
    h1 { margin: 28px 0 8px; font-size: 24px; line-height: 1.25; letter-spacing: -0.025em; font-weight: 650; }
    h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    p { margin: 0; color: var(--muted); }
    .destination { margin: 24px 0 16px; padding: 16px; border: 1px solid var(--border); background: var(--surface-raised); }
    .destination span { display: block; margin-bottom: 6px; color: var(--muted); font-size: 12px; }
    code { display: block; font: 500 15px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .permissions { margin: 24px 0; padding-top: 24px; border-top: 1px solid var(--border); }
    strong { color: var(--text); font-weight: 600; }
    form { margin: 24px 0 0; }
    button {
      display: block;
      width: 100%;
      min-height: 44px;
      padding: 10px 16px;
      border: 1px solid var(--accent);
      border-radius: 0;
      background: var(--accent);
      color: var(--on-accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    .cancel { margin-top: 16px; text-align: center; font-size: 13px; }
    @media (max-width: 380px) {
      body { padding: 16px 12px; }
      main { padding: 24px; }
    }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <header><img src="${rigelLogo}" alt="" width="32" height="32"><span>Rigel CMS</span></header>
    <h1 id="title">Connect to GitHub</h1>
    <p>This website will receive your GitHub access token:</p>
    <div class="destination"><span>Editor website</span><code>${target}</code></div>
    <p>Continue only if you trust this exact website. This gateway does not verify that it runs Rigel CMS.</p>
    <section class="permissions" aria-labelledby="permissions-title">
      <h2 id="permissions-title">What this allows</h2>
      <p>Access can include <strong>all repositories</strong> available to both you and this GitHub App, not just this website's repository. The website may read content, make changes and open pull requests with your permissions.</p>
    </section>
    <form method="post" action="/authorize">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">Continue to GitHub</button>
    </form>
    <p class="cancel">To cancel, close this window.</p>
  </main>
</body>
</html>`
}
