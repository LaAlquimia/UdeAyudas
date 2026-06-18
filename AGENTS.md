# AGENTS.md

UdeAyudas — Astro 6 SSR landing page + chatbot that helps University of Antioquia (UdeA) students with university procedures. Deployed to Netlify Functions.

## Stack

- Astro 6 (`output: 'server'`, `@astrojs/netlify` adapter — every route is SSR)
- OpenRouter AI (`https://openrouter.ai/api/v1/chat/completions`)
- Copiloto UdeA — LangGraph + FastAPI institucional (`POST https://copiloto-admin-udea.onrender.com/api/invoke`)
- `marked` v18 (AI reply markdown rendering, client-side)
- Bun (package manager + runtime; `bun.lock` is the lockfile)
- TypeScript strict (`astro/tsconfigs/strict`)

## Chat engines

The chat exposes **two engines** the user picks explicitly from a pill selector at the top of the chat panel (persisted in `localStorage['chatProvider']`):

- **`copiloto`** (default) — institutional. Forwards the user message verbatim to our LangGraph backend and returns its `generation` field. No auth, no system prompt (the upstream has its own router + corpus), no model selection, text-only. URL is `COPILOTO_API_URL` (default = Render deploy). 90s timeout (Render free tier cold starts ~30s).
- **`openrouter`** — multi-model. Forwards the user message + a UdeA-specific system prompt to OpenRouter. Requires `OPENROUTER_API_KEY`. Model is allowlisted in `ALLOWED_MODELS` (`src/pages/api/chat.ts`) and currently hardcoded to `openai/gpt-4o-mini` on the client.

`POST /api/chat` body: `{ message: string, provider: "openrouter" | "copiloto", model?: string }`. `model` is ignored when `provider === "copiloto"`. Each assistant bubble gets a small badge (`Copiloto UdeA` / `OpenRouter`) so the user always knows which engine answered.

## Commands

- `bun install` — install deps.
- `bun run dev` — dev server on http://localhost:4321.
- `bun run build` — production build → `dist/` (also runs Astro type-check via the strict tsconfig).
- `bun run preview` — preview the built site.
- `npx astro check` — explicit type-check / diagnostics pass. Not wired into `package.json` scripts; run it manually when changing types.

There is **no test runner, no linter, and no formatter** configured. Don't run `npm test`, `eslint`, `prettier`, etc. — they aren't installed. Verification is `bun run build` + manual `/chatbot` exercise.

## Environment

- Required (only for the OpenRouter engine): `OPENROUTER_API_KEY` in `.env` (copy `.env.example`). `src/pages/api/chat.ts` returns HTTP 500 with a Spanish error if it's missing — the server must be restarted after editing `.env`.
- Optional: `PUBLIC_SITE_URL` — used as the `HTTP-Referer` header when calling OpenRouter. Defaults to `https://udeayudas.netlify.app`; set to `http://localhost:4321` during local dev so OpenRouter analytics are accurate.
- Optional: `COPILOTO_API_URL` — URL of the LangGraph / FastAPI Copiloto Administrativo backend used by the `copiloto` chat engine. Defaults to `https://copiloto-admin-udea.onrender.com/api/invoke`; override to point at a local/staging deployment.
- Optional: `ALLOWED_ORIGINS` — comma-separated list of extra origins allowed to POST `/api/chat`, on top of the built-in defaults (`http://localhost:4321`, `http://127.0.0.1:4321`, `https://laalquimiai.netlify.app`, `https://udeayudas.netlify.app`). Use this when you deploy under a different Netlify subdomain or a custom domain — without it the API returns 403 `Origen no permitido`.
- `package.json` declares `engines.node >= 22.12.0`.
- Generated `.astro/` (Astro types), `dist/` (build output), `.netlify/` (local Netlify state), and `node_modules/` are gitignored — never commit them.

## Architecture

Single package, no monorepo.

Routes:
- `/` → `src/pages/index.astro` (landing).
- `/chatbot` → `src/pages/chatbot.astro` (full-height chat; body overflow is hidden via `<style is:global>`).
- `POST /api/chat` → `src/pages/api/chat.ts` (SSR; `export const prerender = false` is explicit — keep it).

Layout (`src/layouts/Layout.astro`) owns the nav, footer, `ThemeToggle`, and an inline pre-paint script that reads `localStorage['theme']` to set `data-theme` on `<html>` before paint. Don't remove or reorder that script — it prevents dark/light FOUC.

All styling lives in `src/styles/global.css` (single file). `src/assets/` is empty — static assets go in `public/` (`favicon.ico`, `favicon.svg` only).

## Conventions

- UI strings and the chat API's system prompt are **Spanish**. Keep new user-facing strings in Spanish unless asked otherwise.
- `src/components/ChatBot.astro` client script: `import { marked } from 'marked'` (ESM, v18). AI replies are rendered with `marked.parse(text, { breaks: true })` — keep `breaks: true` so newlines become `<br>`. User messages are inserted via `textContent` (not `innerHTML`).
- Model dropdown IDs in `ChatBot.astro` are OpenRouter model slugs. To change the default, update both the `<option value="…">` and the fallback in `src/pages/api/chat.ts` (currently `'openai/gpt-4o-mini'`).
- Theme state: `localStorage['theme']` + `data-theme` on `<html>`. Theme-aware CSS uses `[data-theme="dark"]` / `[data-theme="light"]` selectors in `global.css`.
- No formatter: match existing style — 2-space indent, single quotes, semicolons in `.ts` files.
- Don't add `prerender = true` to pages or API routes unless explicitly asked — the whole site is currently SSR and switching a page to prerendered breaks the dynamic OpenRouter call.
- Security headers (CSP, HSTS, etc.) live in `src/middleware.ts`. **Production CSP is strict**: inline scripts are allowed only via the SHA256 hash of the theme pre-paint script in `Layout.astro` (`<script is:inline>`). Don't edit that script without recomputing the hash in `middleware.ts` — Safari blocks unmatched inline scripts silently (Chrome is more permissive, so this fails unevenly across browsers). Dev CSP is relaxed to keep Vite HMR + Astro dev toolbar working.
- `/api/chat` rejects cross-origin POSTs with 403 `Origen no permitido` unless the request's `Origin` (or `Referer`) matches an entry in `ALLOWED_ORIGINS`. When you change deploy targets, update `DEFAULT_ALLOWED_ORIGINS` in `src/pages/api/chat.ts` and/or set the `ALLOWED_ORIGINS` env var — see the Environment section.
- The `provider` field in the `/api/chat` body is allowlisted (`ALLOWED_PROVIDERS`). Unknown values silently fall back to `openrouter`. `model` is only consumed on the `openrouter` branch; sending one with `provider: "copiloto"` is harmless but pointless.

## Deployment

- `netlify.toml` runs `bun run build` and publishes `dist/`. Either push to GitHub for CI/CD or run `netlify deploy --prod --dir=dist` manually.
- Set `OPENROUTER_API_KEY` in the Netlify site's environment variables before the first deploy — without it `/api/chat` returns 500 in production.
- If the Netlify site uses a different subdomain than `laalquimiai.netlify.app` or a custom domain, also set `ALLOWED_ORIGINS` (comma-separated, `https://` included) so the chat doesn't get blocked by the origin check. Optionally set `PUBLIC_SITE_URL` to the same URL so OpenRouter analytics reflect production traffic.
