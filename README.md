# Rigel authentication template

Standalone GitHub App authentication for a Rigel editor, with one shared auth core and thin Cloudflare Workers, Netlify Functions and Vercel entry points. No website framework, database, telemetry or sibling repository is required.

This template uses Apache-2.0. The npm package stays `private: true` to prevent accidental publication.

Platform deployments have not yet been verified. Run the live checklist below on each host before relying on it.

## Files and commands

| File | Role |
| --- | --- |
| `src/auth.ts` | Shared authentication and security checks |
| `src/gateway.ts` | Common Hono app and gateway routes |
| `cloudflare/index.ts` | Worker default export |
| `src/index.ts` | Native Vercel Hono default export |
| `src/node.ts` | Shared Node Request handler with explicit runtime environment mapping |
| `netlify/functions/auth.ts` | Default Request-to-Response handler; `netlify.toml` forces root routes to this function |
| `wrangler.jsonc`, `netlify.toml`, `vercel.json` | Provider configuration; Vercel explicitly selects framework `hono` |
| `.env.example` | Variable names with all values blank |

Use Node 24 and pnpm 11.7.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:browser
```

`pnpm check` runs TypeScript checking. `pnpm test` runs `node --experimental-strip-types --test tests/*.test.ts`. The browser suite uses native Chrome with mocked GitHub transport, not real credentials. Set `CHROME_PATH` if Chrome is installed elsewhere. `pnpm build` only typechecks; each provider bundles its entry point.

| Command | Local gateway | Underlying command |
| --- | --- | --- |
| `pnpm dev:cloudflare` | `http://localhost:8789` | `wrangler dev --port 8789` |
| `pnpm dev:netlify` | `http://localhost:8888` | `pnpm --package=netlify-cli@27.14.2 dlx netlify dev --offline --port 8888` |
| `pnpm dev:vercel` | `http://localhost:3000` | `pnpm --package=vercel@65.2.0 dlx vercel dev --listen 3000` |

Synthetic tests do not prove GitHub registration, deployed runtime behavior or editor integration. Vercel's CLI may require account/project setup even for local development.

## Runtime configuration

Set these on the gateway's hosting runtime, never in the editor bundle or build output.

| Variable | Value |
| --- | --- |
| `GH_CLIENT_ID` | Required GitHub App client ID, not the numeric App ID |
| `GH_CLIENT_SECRET` | Required GitHub App client secret |
| `AUTH_SECRET` | Required independent cryptographically random secret, at least 32 characters; not a GitHub credential |
| `SITE_ORIGIN` | Required exact gateway origin, for example `https://auth.example.com` |
| `ALLOWED_ORIGINS` | Optional. Blank means public destination confirmation. An exact comma-separated list restricts destinations and skips confirmation. |

Generate `AUTH_SECRET` independently for each deployment, using a password manager or a local cryptographic generator, and save it directly to the host's secret store. Rotating it invalidates existing gateway cookies. Never put secrets, authorization codes or tokens in URLs, source control, logs or chat.

Origins must be canonical: scheme and hostname with an optional port, without a trailing slash, path, query, fragment, credentials or wildcard. For example, restricted mode can use `https://editor.example.com,https://preview.example.com`. An allowlist is not a repository access control list.

HTTPS is required except for explicit `http://localhost:<port>` development origins. HTTP `127.0.0.1` and IPv6 origins are rejected. The request host must match `SITE_ORIGIN`; a random provider preview URL is not interchangeable with it. Give a preview its own explicit origin, callback and runtime configuration if you need to test it.

For local development, manually copy the blank `.env.example` to ignored `.dev.vars` for Wrangler, or an ignored `.env` for the Node provider CLI. Fill it locally; do not commit it. Set `SITE_ORIGIN` to the chosen localhost gateway above and register that exact origin plus `/callback` with a separate development GitHub App. Restart the dev server after changing variables.

## Register your GitHub App

Follow GitHub's [registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app). Under your account or organization's Settings, open Developer settings, GitHub Apps, then New GitHub App.

1. Choose your own unique app name and operator homepage, for example `https://example.com`.
2. Set Callback URL to exactly `SITE_ORIGIN/callback`, for example `https://auth.example.com/callback`. Disable wildcard matching if offered. A gateway mounted under an `/auth` path prefix is not this template's contract.
3. Keep **Expire user authorization tokens** enabled. This gateway requires expiring GitHub App user tokens.
4. Leave **Request user authorization (OAuth) during installation** off. Login must start from the editor so the gateway can establish state and the popup destination.
5. Leave Device Flow off, Setup URL blank and Redirect on update off. Turn webhook Active off; leave webhook URL/secret and event subscriptions empty.
6. Give repository **Contents** and **Pull requests** read/write access for editing and publishing reviews. Metadata is read-only. Use read-only **Checks**, **Commit statuses** and **Deployments** where the selected backend needs publish/review status. Leave unrelated repository, organization, account and enterprise permissions at no access.
7. Choose Any account if other people or organizations must install your app; otherwise restrict it to your account. This setting does not control destination confirmation.
8. Create the app, copy its client ID, then generate a client secret and save it only to the gateway runtime. This flow does not require an App private key.
9. Install the app on the needed account and select only the repositories the editor should access. Organization approval may be required. Installation and repository grants are separate from user authorization; successful sign-in alone does not prove repository access.

The returned token is a GitHub App **user** access token, not an installation bot token. Its permissions are the intersection of the user's access and the app's installation permissions. It can cover every repository in that intersection, not just the repository selected in an editor. A public confirmation page cannot prove a destination runs Rigel. Confirm only editor origins you trust with those privileges.

Protocol references: [user access tokens and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [token expiry and refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

## Deploy

Choose a provider to create your own deployment. Register [your GitHub App](#register-your-github-app), set the [runtime variables](#runtime-configuration), and match its callback URL to your gateway's final domain. The buttons set up hosting; they do not register the GitHub App for you.

### Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Frigel-cms%2Frigel-github-auth-template)

1. Connect your repository to Workers Builds, or use the Wrangler CLI from this directory. Keep `cloudflare/index.ts` as the entry point in `wrangler.jsonc`.
2. Store all four required variables as Worker secrets, not build-only variables. Use `pnpm exec wrangler secret put NAME` for each of `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `AUTH_SECRET` and `SITE_ORIGIN`; each command prompts locally. Set optional `ALLOWED_ORIGINS` in `wrangler.jsonc`. Keeping the required values as secrets prevents later Wrangler deployments from overwriting dashboard-only variables.
3. Run `pnpm check` as the build check and `pnpm exec wrangler deploy` as the deployment command, or deploy with that command yourself. Configure your chosen custom domain and make its origin match `SITE_ORIGIN` exactly.
4. Keep `observability.enabled` false in `wrangler.jsonc`. Review upstream proxy and account logging separately.

### Netlify Functions

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https%3A%2F%2Fgithub.com%2Frigel-cms%2Frigel-github-auth-template)

1. Import your repository into Netlify with its root as the base directory. Use Node 24, pnpm 11.7.0 and build command `pnpm build`; retain the functions settings in `netlify.toml`. This is a function-only gateway, not a static website build.
2. Set all required variables in the site's environment settings with **Functions/runtime** availability. Build-only variables do not configure the running function. Use the correct production or preview context and redeploy after changes.
3. Deploy through Netlify's Git integration or `pnpm --package=netlify-cli@27.14.2 dlx netlify deploy --build --prod` after linking your own site. Configure the domain and exact `SITE_ORIGIN`/GitHub callback pair.
4. Keep `netlify/functions/auth.ts` as a modern Node Function returning a web `Response` from a web `Request`. Retain the forced catch-all rewrite in `netlify.toml`, which preserves the original request URL and auth error status codes. Do not add function `config.path` routing or an SPA rewrite over the gateway routes.

See [Netlify's function setup](https://docs.netlify.com/build/functions/get-started/). Provider request/function logs need a separate review; application silence does not mean Netlify collects no request metadata.

### Vercel

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frigel-cms%2Frigel-github-auth-template&env=GH_CLIENT_ID%2CGH_CLIENT_SECRET%2CAUTH_SECRET%2CSITE_ORIGIN&envDescription=Create+your+own+GitHub+App+and+configure+its+callback+before+signing+in.&envLink=https%3A%2F%2Fgithub.com%2Frigel-cms%2Frigel-github-auth-template%23register-your-github-app)

1. Import your repository into Vercel with its root as the project directory. Use Node 24 and pnpm 11.7.0. Keep `framework: "hono"` in `vercel.json` and the default Hono export in `src/index.ts`.
2. Set the required environment variables in Project Settings for the intended Production or Preview environment. Keep secrets server-side and redeploy after changes. Match the deployment's stable origin to `SITE_ORIGIN` and the GitHub callback.
3. Deploy through the Git integration or `pnpm --package=vercel@65.2.0 dlx vercel --prod` after linking your own project. `pnpm build` is a typecheck, not a generated static output directory.
4. Use [Vercel's native Hono support](https://vercel.com/docs/frameworks/backend/hono). Do not add framework scaffolding, an `api/` wrapper or a second auth implementation.

Review Vercel's request logs, observability and any log drains independently. This template cannot promise that provider-level callback URL logging is universally disabled.

## Connect the editor

Set your editor's GitHub `appSlug` to the actual slug shown on your own GitHub App page, and `authOrigin` to your gateway's exact `SITE_ORIGIN`. Do not derive the slug from a suggested display name. Keep the configured content repository separate from these auth settings.

The popup opens `GET /authorize?origin=<encoded editor origin>&nonce=<random caller nonce>`. Use `crypto.randomUUID()` or another cryptographically random nonce of 32 to 128 URL-safe characters. Blank `ALLOWED_ORIGINS` shows an exact-destination confirmation before GitHub; restricted mode rejects unlisted origins and skips that page. The confirmation submits to `POST /authorize`; GitHub returns to `GET /callback`.

The callback posts `{ type: 'rigel:auth', provider: 'github', nonce, access_token, expires_in }` to the recorded opener origin, or an `error` instead of token fields. The editor must check the exact gateway message origin, popup window source and caller nonce, then validate the payload. Clean up listeners on success, cancellation and timeout. Preserve the opener: do not use `noopener` for the sign-in popup, and do not isolate the editor with COOP `same-origin`. Use the default policy or `same-origin-allow-popups`; auth responses retain `unsafe-none`.

The gateway stores the refresh token only in an encrypted HttpOnly cookie. `POST /refresh` is bodyless, same-origin only and requires `X-Rigel-CSRF: 1`; it is not an editor cross-origin API. There is no automatic refresh across origins. Reopen the login popup when the editor's access token expires. Avoid concurrent refresh calls.

Rigel CMS 1.0.0-rc.1 stores its access-token session in `localStorage`, separate from the gateway's HttpOnly refresh cookie. Same-origin editor scripts can read that session.

## Live test checklist

Repeat for Cloudflare, Netlify and Vercel. Use a development app and disposable repository first; tests that publish or save should have deliberate, reversible changes.

Run `pnpm test:platform https://auth.example.com https://editor.example.com` with your exact gateway and an allowed editor origin. This checks routing, method guards, hardened failures, destination confirmation or allowlist mode, PKCE and separate cookies. It never follows the GitHub redirect or exchanges real tokens; complete the real popup checks below yourself.

- [ ] `GET /health` returns success. Check it separately from authentication: liveness alone proves neither configuration nor GitHub access.
- [ ] Confirm the final HTTPS host, `SITE_ORIGIN`, exact `/callback` registration and editor `authOrigin`/`appSlug` agree. Review provider/proxy callback logging and remove analytics or URL logging from the auth path.
- [ ] In public mode, start from the actual editor and verify the exact destination warning, cancellation and confirmation. In restricted mode, verify an allowed origin works and an unlisted origin fails.
- [ ] Complete real GitHub authorization in the popup. Confirm return to the opener, popup closure and successful editor identity. Deny a second attempt and verify a safe error without losing drafts.
- [ ] Inspect production cookies without copying values: host-only, Secure, HttpOnly and expected SameSite behavior. Verify state clearing and that a callback opened without valid state fails. Do not record callback URLs, codes, tokens or cookie values in screenshots or reports.
- [ ] Confirm installation/repository selection and any organization approval. Verify access to the intended repository, then save a reversible change and read it back. Verify the backend's publish/review operation separately from sign-in.
- [ ] Verify popup blocking and editor COOP behavior, rejected forged messages, and expiration/reauthentication. Cross-origin `/refresh` must fail; failed saves should preserve drafts.
- [ ] Record the provider, tested routes and outcomes without secrets. Leave any untested deployment or flow marked unverified.

The application has no telemetry and must not log callback URLs or provider bodies. Hosting providers may still collect request metadata. Supply your own operator identity, privacy notice and terms, and review cookie/token handling and provider retention before public use. Deploying this template does not make Rigel's hosted-service policies apply to your service.

## License

Copyright 2026 Alex Zappa (FreshJuice). Licensed under the [Apache License, Version 2.0](LICENSE).

The software is provided "AS IS", without warranties or conditions of any kind. See [LICENSE](LICENSE) for the full terms and limitations of liability.
