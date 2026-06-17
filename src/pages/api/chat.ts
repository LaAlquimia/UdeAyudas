import type { APIRoute } from 'astro';

export const prerender = false;

// ── Security configuration ────────────────────────────────────────────────────

// Allowlist of OpenRouter model slugs the client is permitted to request.
// Mirrors the <option value="..."> list in src/components/ChatBot.astro and
// prevents a malicious client from requesting arbitrary (potentially premium)
// models, which would burn the OpenRouter credit balance.
const ALLOWED_MODELS = new Set<string>([
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-sonnet-4-20250514',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'deepseek/deepseek-chat',
  'mistralai/mistral-small-3.1-24b-instruct',
]);

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

// Hard cap on a single user message. Anything bigger is rejected before we
// spend tokens forwarding it to OpenRouter. 4000 chars ~ 1k tokens, well
// under the 4k context of the cheapest models in the list.
const MAX_MESSAGE_LENGTH = 4000;

// Allowed origins for the browser-side Origin/Referer check. The endpoint
// itself is same-origin, but a malicious third-party site could otherwise
// POST to /api/chat from anywhere and use this server as an open relay to
// burn OpenRouter credits.
//
// Configure via env in production: set ALLOWED_ORIGINS to a comma-separated
// list of origins, e.g. `ALLOWED_ORIGINS=https://laalquimiai.netlify.app,https://www.example.com`.
// Anything set there is added on top of the defaults below — the defaults
// cover local dev and the common Netlify subdomains this project has used.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'https://neuralsync-ai.netlify.app',
  'https://laalquimiai.netlify.app',
];

const extraOrigins = (import.meta.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const ALLOWED_ORIGINS = new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);

// Per-IP rate limit: at most REQUESTS_PER_WINDOW requests per WINDOW_MS.
// In-memory only — works for a single Function instance. Netlify may run
// multiple instances, so the effective limit per IP is N * REQUESTS_PER_WINDOW.
// For a hackathon project this is a sane baseline; a real production system
// would back this with Netlify Blobs or Upstash Redis.
const REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, Bucket>();

function rateLimit(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

// Periodic cleanup so the Map doesn't grow unbounded. Runs lazily on each
// request; a single pass per minute is enough for our scale.
function pruneRateBuckets(): void {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(ip);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Tell intermediaries and the browser not to cache a response that
      // depends on the requester's IP / state.
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function getClientIp(request: Request): string {
  // Netlify sets x-forwarded-for with the original client first.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  // No Origin / Referer: only allow for same-origin / non-browser requests
  // where the browser wouldn't have sent one anyway. For a chat endpoint
  // meant to be called from our own UI, the absence of either header on a
  // POST is a strong signal of an out-of-band caller. We block it.
  if (!origin && !referer) return false;

  // If Origin is present it must match the allowlist.
  if (origin) return ALLOWED_ORIGINS.has(origin);

  // Fall back to checking the Referer's origin portion.
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      return ALLOWED_ORIGINS.has(refererOrigin);
    } catch {
      return false;
    }
  }

  return false;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  try {
    // 1. Origin check (cheap; do it first so a flood of bad-origin requests
    //    is rejected without parsing the body).
    if (!originAllowed(request)) {
      return jsonResponse({ error: 'Origen no permitido' }, 403);
    }

    // 2. Rate limit per client IP.
    const ip = getClientIp(request);
    pruneRateBuckets();
    const rl = rateLimit(ip);
    if (!rl.allowed) {
      return jsonResponse(
        { error: 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.' },
        429,
        { 'Retry-After': Math.ceil(rl.retryAfterMs / 1000).toString() },
      );
    }

    // 3. Body size + content-type sanity.
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_MESSAGE_LENGTH + 1024) {
      return jsonResponse({ error: 'Mensaje demasiado largo' }, 413);
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return jsonResponse({ error: 'Content-Type debe ser application/json' }, 415);
    }

    // 4. Parse + validate input.
    const raw = await request.text();
    if (raw.length > MAX_MESSAGE_LENGTH + 1024) {
      return jsonResponse({ error: 'Mensaje demasiado largo' }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: 'JSON inválido' }, 400);
    }

    if (!parsed || typeof parsed !== 'object') {
      return jsonResponse({ error: 'Cuerpo inválido' }, 400);
    }

    const { message, model } = parsed as { message?: unknown; model?: unknown };

    if (typeof message !== 'string' || message.trim().length === 0) {
      return jsonResponse({ error: 'Mensaje inválido' }, 400);
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse(
        { error: `El mensaje excede el máximo de ${MAX_MESSAGE_LENGTH} caracteres` },
        400,
      );
    }

    let selectedModel = DEFAULT_MODEL;
    if (typeof model === 'string' && model.trim().length > 0) {
      const candidate = model.trim();
      if (!ALLOWED_MODELS.has(candidate)) {
        // Silently fall back rather than echo the bad value. Don't leak the
        // full allowlist through error messages.
        selectedModel = DEFAULT_MODEL;
      } else {
        selectedModel = candidate;
      }
    }

    // 5. API key.
    const apiKey = import.meta.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      // Don't log the key absence on every call — that's noisy and reveals
      // the deployment is misconfigured to anyone who can see the response.
      return jsonResponse(
        { error: 'API key no configurada. Crea un .env con OPENROUTER_API_KEY y reinicia el servidor' },
        500,
      );
    }

    // 6. Call OpenRouter. Use a configurable HTTP-Referer so analytics work
    //    in dev (localhost) and in prod (the Netlify URL).
    const siteUrl = import.meta.env.PUBLIC_SITE_URL ?? 'https://neuralsync-ai.netlify.app';

    const upstreamResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': siteUrl,
        'X-Title': 'NeuralSync AI',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          {
            role: 'system',
            content: 'Eres NeuralSync AI, un asistente inteligente y amigable. Respondes en español de forma clara y concisa.',
          },
          { role: 'user', content: message },
        ],
      }),
    });

    if (!upstreamResponse.ok) {
      // Log the full upstream error server-side for debugging, but return a
      // generic message to the client. OpenRouter error payloads can include
      // request IDs, account info, and pricing details we don't want to leak.
      let upstreamBody: unknown = {};
      try {
        upstreamBody = await upstreamResponse.json();
      } catch {
        // ignore — body wasn't JSON
      }
      console.error('[chat] OpenRouter error', upstreamResponse.status, upstreamBody);
      return jsonResponse({ error: 'El servicio de IA no está disponible. Intenta de nuevo.' }, 502);
    }

    const data = await upstreamResponse.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content ?? 'No se pudo generar una respuesta.';

    return jsonResponse({ reply }, 200);
  } catch (error) {
    console.error('[chat] Internal error', error);
    return jsonResponse({ error: 'Error interno del servidor' }, 500);
  }
};

// Reject non-POST methods explicitly. Without this, a GET to /api/chat would
// currently fall through to a 404 — but a 405 with an Allow header is more
// informative and prevents accidental method-tampering clients from retrying
// with the same verb.
export const ALL: APIRoute = async ({ request }) => {
  if (request.method === 'POST') {
    return jsonResponse({ error: 'Method not implemented' }, 500);
  }
  return new Response(null, {
    status: 405,
    headers: {
      'Allow': 'POST',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
};
