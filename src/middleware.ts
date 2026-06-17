import { defineMiddleware } from 'astro:middleware';

// ── Dev vs. production CSP ────────────────────────────────────────────────────
//
// In dev mode, Vite injects inline scripts for HMR and the Astro dev toolbar.
// A strict CSP without 'unsafe-inline' would block them, breaking the page.
// We relax script-src in dev to keep the developer experience smooth while
// still applying the other security headers.
//
// In production (Netlify), we apply the full strict CSP.

function securityHeaders(): Record<string, string> {
  const isDev = import.meta.env.DEV;

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };

  if (isDev) {
    // Relaxed CSP for dev — still useful but allows Vite injection.
    headers['Content-Security-Policy'] = [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-eval' 'unsafe-inline'`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src 'self' https://fonts.gstatic.com data:`,
      `img-src 'self' data:`,
      `connect-src 'self' ws:`,
      `frame-ancestors 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `object-src 'none'`,
    ].join('; ');
  } else {
    // Strict CSP for production.
    headers['Content-Security-Policy'] = [
      `default-src 'self'`,
      `script-src 'self' 'sha256-1d070a13902e027ebe21c49d1ef30bd3ec311c66de505079a4eb72d1a546039d'`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src 'self' https://fonts.gstatic.com data:`,
      `img-src 'self' data:`,
      `connect-src 'self'`,
      `frame-ancestors 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `object-src 'none'`,
      `upgrade-insecure-requests`,
    ].join('; ');

    // HSTS is only meaningful over HTTPS (Netlify prod).
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();

  // Clone response to mutate headers (immutable in some runtimes).
  const newHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (!newHeaders.has(name)) {
      newHeaders.set(name, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});
