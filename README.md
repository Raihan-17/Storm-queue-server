# Storm Queue — QueueStorm Ticket Classifier

A small, fast Express.js service that reads one customer-support ticket and
answers four questions in a single response:

1. **What kind of problem is this?** (`wrong_transfer`, `payment_failed`,
   `refund_request`, `phishing_or_social_engineering`, `other`)
2. **How serious is it?** (`low`, `medium`, `high`, `critical`)
3. **Which team should handle it?** (`customer_support`, `dispute_resolution`,
   `payments_ops`, `fraud_risk`)
4. **What is the one-sentence summary an agent reads in two seconds?**

Phishing and critical-severity tickets are flagged with
`human_review_required: true` so a human agent picks them up immediately.

The classifier is **rules-based** (weighted keyword matching) — no external
LLM, no GPU, no secrets in the repo. Latency on a cold start is well under
50 ms per request, comfortably inside the 30 s budget the grader allows.

---

## Endpoints

| Method | Path             | Purpose                                              |
| ------ | ---------------- | ---------------------------------------------------- |
| GET    | `/health`        | Service health check (returns `status`, `uptime`, timestamp) |
| POST   | `/sort-ticket`   | Classify a single ticket                             |

### Request — `POST /sort-ticket`

```json
{
  "ticket_id": "T-001",
  "channel":   "app",
  "locale":    "en",
  "message":   "I sent 5000 taka to a wrong number this morning, please help me get it back"
}
```

| Field       | Type   | Required | Notes                                                |
| ----------- | ------ | -------- | ---------------------------------------------------- |
| `ticket_id` | string | Yes      | Echoed back. Letters, digits, `.`, `_`, `:`, `-`; ≤ 64 chars. |
| `channel`   | string | Optional | One of `app`, `sms`, `call_center`, `merchant_portal`. |
| `locale`    | string | Optional | One of `bn`, `en`, `mixed`.                          |
| `message`   | string | Yes      | Free text, ≤ 4000 chars.                            |

### Response — `POST /sort-ticket`

```json
{
  "ticket_id":              "T-001",
  "case_type":              "wrong_transfer",
  "severity":               "high",
  "department":             "dispute_resolution",
  "agent_summary":          "Customer reports sending 5000 taka to the wrong recipient and is requesting recovery.",
  "human_review_required":  true,
  "confidence":             0.85,
  "_meta":                  { "classify_ms": 0.42 }
}
```

`human_review_required` is `true` whenever `severity` is `high` or
`critical`, **or** `case_type === "phishing_or_social_engineering"`. The
`_meta` block is for observability and is safe to ignore.

### Errors

All errors share the same shape:

```json
{ "error": "BadRequest", "message": "ticket_id is required.", "field": "ticket_id" }
```

| Status | `error`            | When                                                      |
| ------ | ------------------ | --------------------------------------------------------- |
| 400    | `BadRequest`       | Missing or malformed field                                |
| 413    | `PayloadTooLarge`  | Body > 64 KB                                              |
| 404    | `NotFound`         | Unknown path                                              |
| 500    | `InternalServerError` | Unexpected server-side failure (stack hidden in prod)  |

---

## How Classification Works

The classifier in `src/services/classifier.service.js` has two tiers of
keyword lists:

- **Strong** — very specific phrases (e.g. `"sent to a wrong number"`,
  `"someone called asking my OTP"`). Any strong hit in a category is the
  primary signal.
- **Weak** — supporting tokens (e.g. `"refund"`, `"OTP"`, `"wrong"`). They
  contribute to the confidence score but cannot pick a case on their own.

Priority order:

1. **Phishing always wins.** Any strong phishing hit overrides every other
   category — the safety rule is stricter than topical accuracy.
2. Otherwise, the case_type with the most strong hits wins.
3. **Severity boosts** bump the default severity when the message contains
   words like `urgent`, `stolen`, `hacked`, `police`, etc.

Confidence is `top_weak_hits / (top_weak_hits + second_weak_hits)`, clamped
to `[0.3, 0.7]` for weak-only classifications and `[0.7, 0.99]` once any
strong hit fires. Phishing always lands in the high-confidence band.

---

## Safety Rule (graded automatically)

`agent_summary` must **never** ask the customer to share their
`PIN`, `OTP`, `password`, `CVV`, or full card number. The grader auto-fails
any response that does.

Enforcement happens in `src/utils/sanitizer.js`:

1. The summary is built from a fixed template per case_type — it never
   quotes the customer message verbatim.
2. After construction, `sanitizeSummary` scrubs any leaked credential
   tokens (`pin`, `otp`, `password`, `passcode`, `cvv`,
   `card number`, …) with `[redacted-credential]`.
3. A second pass replaces the placeholder if any forbidden phrase survives.

---

## Security & API Protection

The service is designed to be safe to expose publicly.

### Transport & proxy
- `app.set('trust proxy', 1)` so `req.ip` and future rate-limits behave
  correctly behind Render / Railway / Fly.
- Graceful shutdown on `SIGTERM` / `SIGINT` — in-flight requests are
  allowed to finish, with a 10 s hard-exit fallback.

### Headers
- **`helmet`** sets the standard hardening headers (HSTS, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy`, …). `crossOriginResourcePolicy` is disabled so
  the grader's custom harness can call it from any origin.
- An additional middleware explicitly sets:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-XSS-Protection: 1; mode=block`
  - Removes `X-Powered-By` to avoid server fingerprinting.
  - `X-RateLimit-Limit` / `X-RateLimit-Remaining` informational headers.
  - `X-Request-ID` (echoes client header or mints one) for log tracing.

### CORS
- Configurable via `CORS_ORIGIN` env var (comma-separated list or `*`).
- Methods restricted to `GET`, `POST`, `OPTIONS`.
- `allowedHeaders`: `Content-Type`, `Authorization` only.

### Body parsing
- `express.json({ limit: '64kb' })` — tickets are short free-text, so a
  tight cap bounds memory and CPU per request. Requests over 64 KB return
  `413 PayloadTooLarge`.

### Input validation (`src/controllers/ticket.controller.js`)
- `ticket_id` must match `^[A-Za-z0-9._:-]{1,64}$`.
- `message` is required, ≤ 4000 chars, and must not be all whitespace.
- `channel` and `locale` must be from the spec's allowlist when provided.
- Suspicious patterns (`SELECT`, `<script>`, `javascript:`, …) are
  logged for audit but **not** blocked — the grader can pass any
  realistic customer message.

### Output sanitization
- `agent_summary` is run through `sanitizeSummary` so PIN / OTP / password
  / CVV / card-number can never appear in the response.
- In production (`NODE_ENV=production`) the 500-handler returns a generic
  message; stack traces are never leaked to the client.

### Logging
- Single-line request log with method, path, status, and elapsed
  milliseconds — easy to scrape, no `morgan` dependency.

### Secrets
- `dotenv` reads `.env` locally. The only secret currently in scope is
  optional (no LLM is used). `.env` is in `.gitignore`.

---

## Project Layout

```
.
├── server.js                  # Express bootstrap
├── package.json
├── .env.example               # Copy to .env for local dev
├── src/
│   ├── controllers/
│   │   └── ticket.controller.js   # Validation + response shaping
│   ├── routes/
│   │   └── ticket.routes.js      # /health and /sort-ticket
│   ├── services/
│   │   └── classifier.service.js # Keyword-weighted classifier
│   └── utils/
│       └── sanitizer.js          # Credential scrubber + normalizer
```

---

## Run Locally

```bash
# 1. Install
npm install

# 2. (optional) Create env file
cp .env.example .env

# 3. Start
npm start          # production-style
npm run dev        # nodemon auto-reload
```

The server listens on `PORT` (default `3000`).

### Smoke test with `curl`

```bash
# Health
curl -s https://storm-queue-server.onrender.com/health

# Wrong transfer
curl -s -X POST https://storm-queue-server.onrender.com/sort-ticket \
  -H 'Content-Type: application/json' \
  -d '{"ticket_id":"T-001","message":"I sent 5000 taka to a wrong number this morning, please help me get it back"}'

# Phishing
curl -s -X POST https://storm-queue-server.onrender.com/sort-ticket \
  -H 'Content-Type: application/json' \
  -d '{"ticket_id":"T-003","message":"Someone called asking my OTP, is that bKash?"}'
```

---

## Deployment Runbook

The service is a vanilla Node.js app — any HTTPS-capable PaaS works
(Render, Railway, Fly, EC2, Poridhi Lab, …).

1. **Provision a public HTTPS endpoint** with Node.js ≥ 18.
2. **Set environment variables**:
   - `PORT` — platform-provided (usually `10000` on Render).
   - `NODE_ENV=production`.
   - `CORS_ORIGIN` — comma-separated list, or `*` for the grader.
3. **Build & start command**: `npm install --omit=dev && npm start`.
4. **Health check path**: `GET /health`.
5. **Verify** with `curl https://<host>/health` → expect `{"status":"ok",...}`.

---

## Known Limits

- English keywords only. Bangla / mixed-locale messages still classify via
  shared Latin-script cues, but accuracy on pure Bangla is not tuned.
- Refund-vs-payment-failed disambiguation is heuristic; long-form edge
  cases may land in `other` rather than a specific bucket.
- Rate limiting is not enforced in-process; the platform / proxy layer
  should handle it. `X-RateLimit-*` headers are exposed so the proxy can
  surface quota state without an extra round-trip.