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

// ── Provider routing ─────────────────────────────────────────────────────────
//
// The chatbot exposes two engines:
//   - "openrouter": forwards the user message + UdeA system prompt to OpenRouter
//     using one of ALLOWED_MODELS above.
//   - "copiloto": forwards the user message as-is to our LangGraph + FastAPI
//     backend (the "Copiloto Administrativo" service) and returns its generated
//     answer verbatim. The copiloto endpoint has no auth and is text-only — it
//     does its own intent routing on the server side, so no model selection or
//     system prompt is applied here.
//
// Set COPILOTO_API_URL to override the default for local dev / staging.
const ALLOWED_PROVIDERS = new Set<string>(['openrouter', 'copiloto']);
const DEFAULT_PROVIDER = 'copiloto';
const COPILOTO_DEFAULT_URL = 'https://copiloto-admin-udea.onrender.com/api/invoke';
const COPILOTO_TIMEOUT_MS = 90_000; // Render free tier can cold-start for ~30s.

// Hard cap on a single user message. Anything bigger is rejected before we
// spend tokens forwarding it to either upstream. 4000 chars ~ 1k tokens,
// well under the 4k context of the cheapest models in the OpenRouter list.
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
  'https://laalquimiai.netlify.app',
  'https://udeayudas.netlify.app',
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

    const { message, model, provider } = parsed as {
      message?: unknown;
      model?: unknown;
      provider?: unknown;
    };

    if (typeof message !== 'string' || message.trim().length === 0) {
      return jsonResponse({ error: 'Mensaje inválido' }, 400);
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse(
        { error: `El mensaje excede el máximo de ${MAX_MESSAGE_LENGTH} caracteres` },
        400,
      );
    }

    // Resolve the provider. Silently fall back to the default if the client
    // sends an unrecognized value, rather than echoing the allowlist.
    let selectedProvider = DEFAULT_PROVIDER;
    if (typeof provider === 'string' && provider.trim().length > 0) {
      const candidate = provider.trim();
      if (ALLOWED_PROVIDERS.has(candidate)) {
        selectedProvider = candidate;
      }
    }

    // Model is only meaningful for the OpenRouter provider. Validate it
    // unconditionally (so a bad value gets caught before we route), but only
    // USE it on the openrouter branch below.
    let selectedModel = DEFAULT_MODEL;
    if (typeof model === 'string' && model.trim().length > 0) {
      const candidate = model.trim();
      if (ALLOWED_MODELS.has(candidate)) {
        selectedModel = candidate;
      }
    }

    // ── Branch on provider ─────────────────────────────────────────────────
    if (selectedProvider === 'copiloto') {
      return await handleCopiloto(message);
    }
    return await handleOpenRouter(selectedModel, message);
  } catch (error) {
    console.error('[chat] Internal error', error);
    return jsonResponse({ error: 'Error interno del servidor' }, 500);
  }
};

// ── OpenRouter provider ──────────────────────────────────────────────────────
//
// Forwards the user message along with the UdeA-specific system prompt to
// OpenRouter. The API key must be configured. Returns the assistant's reply
// as `{ reply: string }`.
async function handleOpenRouter(model: string, message: string): Promise<Response> {
  const apiKey = import.meta.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Don't log the key absence on every call — that's noisy and reveals
    // the deployment is misconfigured to anyone who can see the response.
    return jsonResponse(
      { error: 'API key no configurada. Crea un .env con OPENROUTER_API_KEY y reinicia el servidor' },
      500,
    );
  }

  // Configurable HTTP-Referer so OpenRouter analytics work in dev (localhost)
  // and in prod (the Netlify URL).
  const siteUrl = import.meta.env.PUBLIC_SITE_URL ?? 'https://udeayudas.netlify.app';

  const upstreamResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': siteUrl,
      'X-Title': 'UdeAyudas',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'Eres UdeAyudas, un asistente amable y experto en los trámites y procesos universitarios de la Universidad de Antioquia (UdeA), en Medellín, Colombia. Tu objetivo es orientar a estudiantes, egresados, docentes y personal administrativo sobre procedimientos académicos y administrativos de la UdeA, tales como: matrícula académica, adiciones y cancelaciones de asignaturas, certificados y constancias, homologaciones, transferencias internas y externas, reingresos, calendario académico, becas y auxilios socioeconómicos, prácticas académicas y profesionales, opciones de grado (trabajo de grado, monografía, seminarios, prácticas, créditos de posgrado), grados, agendamiento de citas en dependencias como Admisiones y Registro, y canales de atención oficiales. Responde SIEMPRE en español, de forma clara, concisa y respetuosa. Cuando des un paso a paso, numéralos. Si no conoces un dato exacto o vigente (por ejemplo, una fecha de calendario de un semestre específico), indícalo y recomienda consultar el sitio oficial https://www.udea.edu.co o la dependencia correspondiente. No inventes requisitos ni procedimientos: si dudas, dilo y sugiere dónde confirmar. Cierra las respuestas complejas invitando al usuario a seguir preguntando.',
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

  return jsonResponse({ reply, provider: 'openrouter' }, 200);
}

// ── Copiloto provider ────────────────────────────────────────────────────────
//
// Forwards the user message verbatim to our LangGraph + FastAPI backend
// ("Copiloto Administrativo") and returns its `generation` field as the reply.
// No auth, no model selection, no system prompt — the upstream has its own
// router and corpus. Includes a generous timeout because Render's free tier
// can take ~30s to cold-start.
async function handleCopiloto(message: string): Promise<Response> {
  const url = import.meta.env.COPILOTO_API_URL ?? COPILOTO_DEFAULT_URL;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COPILOTO_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        question: message,
        debug_mode: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('[chat] Copiloto timeout after', COPILOTO_TIMEOUT_MS, 'ms');
      return jsonResponse(
        { error: 'El Copiloto UdeA tardó demasiado en responder. Intenta de nuevo.' },
        504,
      );
    }
    console.error('[chat] Copiloto fetch error', err);
    return jsonResponse(
      { error: 'No se pudo contactar al Copiloto UdeA. Intenta de nuevo.' },
      502,
    );
  }
  clearTimeout(timeoutId);

  if (!upstreamResponse.ok) {
    let upstreamBody: unknown = {};
    try {
      upstreamBody = await upstreamResponse.json();
    } catch {
      // ignore — body wasn't JSON
    }
    console.error('[chat] Copiloto error', upstreamResponse.status, upstreamBody);
    return jsonResponse(
      { error: 'El Copiloto UdeA no está disponible. Intenta de nuevo.' },
      502,
    );
  }

  const data = await upstreamResponse.json() as {
    generation?: string;
    router_decision?: string;
    is_relevant?: boolean;
    context?: string;
  };

  const reply = (data.generation ?? '').trim() || 'No se pudo generar una respuesta.';

  return jsonResponse(
    {
      reply,
      provider: 'copiloto',
      router_decision: data.router_decision ?? null,
      is_relevant: data.is_relevant ?? null,
    },
    200,
  );
}

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
