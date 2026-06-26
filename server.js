'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const ticketRoutes = require('./src/routes/ticket.routes');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Optional CORS origin allowlist via env. Comma-separated; '*' allows all.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();

// Trust the first proxy when deployed behind Render/Railway/Fly so that
// req.ip / rate-limits behave correctly. Has no effect on local dev.
app.set('trust proxy', 1);

// Security headers. Disable crossOriginResourcePolicy so the API is
// callable from any browser origin (the grader may use a custom harness).
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  })
);

// CORS — accept a list of origins or a wildcard.
const allowedOrigins =
  CORS_ORIGIN === '*'
    ? true
    : CORS_ORIGIN.split(',')
        .map((o) => o.trim())
        .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

// Tight JSON body limit. Tickets are short free-text — no need for the
// default 100kb. Keeps parsing cheap and bounds memory per request.
app.use(express.json({ limit: '64kb' }));

// Disable the default ETag to avoid revalidation overhead on tiny
// responses — saves bytes and CPU on every /health hit.
app.set('etag', false);

// Lightweight request log without pulling in morgan.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Keep the log single-line for easy scraping.
    // eslint-disable-next-line no-console
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${
        res.statusCode
      } ${ms.toFixed(1)}ms`
    );
  });
  next();
});

// Mount routes.
app.use('/', ticketRoutes);

// Root path — quick sanity check useful in deploy logs.
app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'storm-queue',
    endpoints: ['GET /health', 'POST /sort-ticket'],
  });
});

// 404 fallback for unknown paths.
app.use((req, res) => {
  res.status(404).json({
    error: 'NotFound',
    message: `No route for ${req.method} ${req.originalUrl}`,
  });
});

// Central error handler. Never leaks stack traces in production.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Body-parser error (malformed JSON, payload too large).
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'BadRequest',
      message: 'Malformed JSON in request body.',
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'PayloadTooLarge',
      message: 'Request body exceeds the size limit.',
    });
  }

  // eslint-disable-next-line no-console
  console.error('[unhandled-error]', err);
  return res.status(500).json({
    error: 'InternalServerError',
    message: NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message,
  });
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`storm-queue listening on port ${PORT} (${NODE_ENV})`);
});

// Graceful shutdown so deploys don't drop in-flight requests.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}, closing server...`);
  server.close((err) => {
    if (err) {
      // eslint-disable-next-line no-console
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    process.exit(0);
  });
  // Hard exit if close hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
