# Investigator API

A complaint investigator copilot for support agents. It reads one customer complaint plus a short transaction history snippet, decides which transaction (if any) the complaint is about, classifies and routes the case, and drafts a safe reply that never asks for PIN/OTP/password and never confirms a refund it has no authority to confirm.

- Live URL: `https://investigator-api-3wd0.onrender.com`
- Health: `GET https://investigator-api-3wd0.onrender.com/health`
- Analyze: `POST https://investigator-api-3wd0.onrender.com/analyze-ticket`

---

## 1. Runbook (Render Live URL)

The service is already deployed on Render at the URL above. If the URL is down for any reason, use the local fallback below.

### 1.1 Verify the live deployment

```bash
# Health check
curl https://investigator-api-3wd0.onrender.com/health
# -> {"status":"ok"}

# Sample analyze call
curl -X POST https://investigator-api-3wd0.onrender.com/analyze-ticket \
  -H "Content-Type: application/json" \
  -d @tests/sample_input.json
```

### 1.2 Local fallback (run from a clean clone)

```bash
git clone https://github.com/Raihan-17/Investigator-api.git
cd Investigator-api

# Install
npm install

# (Optional) set env. Nothing is required for the rule-based engine.
# copy .env.example .env

# Start the server
npm start

# Server listens on PORT (default 3000)
# Health:   GET  http://127.0.0.1:3000/health
# Analyze:  POST http://127.0.0.1:3000/analyze-ticket

# Run the public sample case pack
npm test
```

### 1.3 Docker fallback (if Render is down)

```bash
# Build
docker build -t investigator-api .

# Run
docker run --rm -p 3000:3000 --env-file .env.example investigator-api

# Health:   GET  http://127.0.0.1:3000/health
# Analyze:  POST http://127.0.0.1:3000/analyze-ticket
```

---

## 2. Tech Stack

| Layer       | Choice                                | Why                                                       |
| ----------- | ------------------------------------- | --------------------------------------------------------- |
| Runtime     | Node.js 18+                           | Small footprint, fast cold start on Render free tier.     |
| Framework   | Express 4                             | Minimal HTTP surface, well-known contract.                 |
| Hardening   | helmet, cors                          | Standard secure headers and CORS for the judge harness.   |
| Config      | dotenv                                | Twelve-factor env vars without code changes.              |
| Reasoning   | Rule-based engine (no external LLM)   | Deterministic, free, sub-second latency, no leaked secrets. |
| Tests       | Plain `node` + built-in `http`        | Zero extra deps, runs anywhere `npm` runs.                |
| Container   | `node:18-alpine` Docker               | ~180 MB image, fits the <5 GB guidance easily.            |
| Deploy      | Render Web Service                    | Public HTTPS, free tier, auto-rebuild on git push.        |

No external LLM is called at runtime. See Section 5 for why.

---

## 3. API Contract

### 3.1 `GET /health`

```json
{ "status": "ok" }
```

Responds within 60 seconds of service start.

### 3.2 `POST /analyze-ticket`

Request body (matches the judge harness schema):

```json
{
  "ticket_id": "TKT-001",
  "complaint": "I sent 5000 taka to a wrong number around 2pm today.",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "campaign_context": "boishakh_bonanza_day_1",
  "transaction_history": [
    {
      "transaction_id": "TXN-9101",
      "timestamp": "2026-04-14T14:08:22Z",
      "type": "transfer",
      "amount": 5000,
      "counterparty": "+8801719876543",
      "status": "completed"
    }
  ]
}
```

Response body:

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending 5000 BDT to a wrong number at 14:00, matching TXN-9101 (completed, 5000 BDT).",
  "recommended_next_action": "Verify TXN-9101 details with the customer and open a dispute through the official dispute portal; do not contact the counterparty directly.",
  "customer_reply": "Thank you for reaching out. We have noted your concern about transaction TXN-9101. Any eligible amount will be reviewed and processed through official channels only. We will never ask for your PIN, OTP, or password. Please continue to use only the in-app support chat for further updates.",
  "human_review_required": true,
  "confidence": 0.9,
  "reason_codes": ["wrong_transfer", "amount_match", "completed_status"]
}
```

### 3.3 HTTP codes

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 200  | Successful analysis.                                                |
| 400  | Malformed JSON or missing required field (`ticket_id`, `complaint`). |
| 422  | Schema valid but semantically invalid (e.g. empty complaint).       |
| 500  | Unexpected internal error. No stack traces or secrets in the body.  |

---

## 4. Architecture

```
                  +----------------------------+
HTTP request ->  |  routes/analyze.routes.js  |
                  +-------------+--------------+
                                |
                                v
                  +-------------+--------------+
                  | controllers/analyze.ctrl   |   validates request shape
                  +-------------+--------------+
                                |
                                v
                  +-------------+--------------+
                  |  utils/validators.js       |   required fields, enums
                  |  utils/sanitizer.js        |   prompt-injection guard, output scrub
                  |  utils/language_detector   |   en / bn / mixed
                  +-------------+--------------+
                                |
                                v
                  +-------------+--------------+
                  | services/investigator.svc  |   orchestrates the verdict
                  +-------------+--------------+
                                |
              +-----------------+------------------+
              |                                    |
              v                                    v
  +-----------+------------+      +-----------------+----------------+
  | transaction_matcher.svc|     |      classifier.service.js      |
  |  score transactions    |      | case_type, severity, department  |
  |  pick best match       |      | reason_codes                    |
  +------------------------+      +---------------------------------+
                                |
                                v
                  +-------------+--------------+
                  |  safety layer (sanitizer)  |  redacts creds, blocks
                  +-------------+--------------+  "we will refund" language
                                |
                                v
                  JSON response (Section 3.2)
```

The flow is intentionally synchronous and in-process so the request stays under the 30 second budget with comfortable headroom.

---

## 5. AI Approach & Reasoning

This service is built as a **rule-based investigator**, not an LLM call. Rationale:

- **Determinism.** The judge harness scores evidence reasoning, not creativity. A deterministic scorer gives identical answers on identical inputs, which keeps test outcomes stable.
- **Cost and latency.** The problem statement explicitly says no LLM credits are provided and any LLM call adds cost, network failure modes, and tail latency that risks the 30 second timeout.
- **Safety.** A rule-based engine cannot be tricked by prompt injection inside a complaint to reveal a system prompt, refund money, or leak a secret, because there is no system prompt and no secret to leak.
- **Cold start.** Render's free tier cold-starts in seconds; pulling a model at runtime would blow the 60 second `/health` budget.

What the engine actually does, in order:

1. **Parse and validate.** Required fields, enum values, transaction shape. Anything missing returns 400 / 422.
2. **Detect language.** `en`, `bn`, or `mixed` using a small Bangla Unicode range check plus English keyword density. Banglish falls into `mixed`.
3. **Extract features from the complaint.** Amounts (digits and Bangla digits), counterparty phone numbers, keywords per case type (wrong_transfer, payment_failed, refund_request, duplicate_payment, merchant_settlement_delay, agent_cash_in_issue, phishing_or_social_engineering), time references.
4. **Score each transaction.** Each matching dimension adds points: amount match, counterparty match, type match, status match, time proximity.
5. **Decide evidence verdict.** `consistent` if a strong match, `inconsistent` if the data contradicts the complaint, `insufficient_data` if the complaint is vague or multiple transactions tie.
6. **Classify case_type.** Based on keyword sets. Tie-breakers prefer the more specific type (e.g. `duplicate_payment` over generic `payment_failed`).
7. **Pick department and severity.** From the taxonomy in Section 7 of the problem statement, with severity raised for high amounts, contested refunds, and any phishing signal.
8. **Generate safe output.** `customer_reply` and `recommended_next_action` go through the sanitizer, which removes any phrase that asks for a credential or promises a refund.

The `MODELS` section below makes the no-model choice explicit.

---

## 6. Safety Logic

All four safety rules from Section 8 of the problem statement are enforced. Violations are structurally impossible, not merely discouraged.

| Rule | Where it is enforced | How |
| ---- | -------------------- | --- |
| Never ask for PIN, OTP, password, full card | `utils/sanitizer.js` + reply templates | The `customer_reply` is assembled from a fixed template set that never contains those tokens. A post-generation scrub removes any accidental inclusion. |
| Never confirm a refund / reversal / unblock | `utils/sanitizer.js` | Phrases like "we will refund", "your money will be returned", "account will be unblocked" are replaced with safe equivalents: "any eligible amount will be reviewed and processed through official channels". |
| Never instruct contact with a third party | `utils/sanitizer.js` + reply templates | Replies only reference official channels (in-app chat, official hotline). |
| Adversarial complaint text must not override rules | `utils/sanitizer.js` `stripInjection` | Detects and strips prompt-injection markers ("ignore previous instructions", "system:", role impersonation, etc.) before any reasoning reads the complaint body. |

`human_review_required` is set to `true` for:

- Any `wrong_transfer` or contested `refund_request`.
- Any `phishing_or_social_engineering` signal.
- Any `case_type` with severity `high` or `critical`.
- Any `evidence_verdict` of `insufficient_data` so an agent confirms the verdict.

---

## 7. Sample Outputs

`tests/sample_input.json` is one input from the public sample case pack.
`sample_output.json` is the corresponding response produced by this service.

Run `npm test` to regenerate sample outputs and check the rule-based engine against ten representative cases covering each `case_type` and each `evidence_verdict`.

---

## 8. MODELS

| Model | Where it runs | Why it was chosen |
| ----- | ------------- | ----------------- |
| None (rule-based engine) | In-process, in the Node.js service | Deterministic, free, no API key, no network dependency, no prompt-injection surface, no leaked secrets, sub-50 ms typical latency. The problem statement explicitly allows rule-based solutions and does not require an LLM. |

No model is downloaded at runtime. No external AI provider is called. The Docker image stays small and cold-start stays fast.

---

## 9. Environment Variables

See `.env.example`. Only `PORT` is required; everything else has a safe default.

```
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
```

No API keys, no tokens, no database URLs.

---

## 10. Assumptions

- The complaint text is the only free-form signal. The model trusts structured fields (`language`, `channel`, `user_type`, `campaign_context`) over weak text inference.
- Bangla text uses Unicode range `0980-09FF`. Banglish (Latin script Bangla) is treated as `mixed`.
- Transaction history may be `undefined` or empty for safety-only cases. The engine returns `insufficient_data` and routes to `customer_support`.
- Timestamps are ISO 8601. Time proximity is checked only when the complaint mentions a clock time.
- Amounts in the complaint may be written as digits (5000) or Bangla digits (৫০০০); both are normalized.
- `transaction_id` is preserved verbatim from the request; we never invent IDs.

## 11. Known Limitations

- The keyword set is curated from the public sample case pack and common Bangla/Banglish phrases. Novel phrasings of an existing case type may fall through to `other`.
- The scorer is heuristic, not learned. It will not catch highly ambiguous multi-issue complaints as well as a tuned LLM would.
- There is no persistent storage. Every request is stateless.
- Multilingual detection is simple Unicode-based; we do not run full tokenization.
- The service does not perform any real payment action; it only drafts and routes.

---

## 12. Project Layout

```
investigator-api/
├── server.js
├── package.json
├── Dockerfile
├── .env.example
├── README.md
├── sample_output.json
├── src/
│   ├── controllers/
│   │   └── analyze.controller.js
│   ├── routes/
│   │   └── analyze.routes.js
│   ├── services/
│   │   ├── investigator.service.js
│   │   ├── transaction_matcher.service.js
│   │   └── classifier.service.js
│   └── utils/
│       ├── validators.js
│       ├── sanitizer.js
│       └── language_detector.js
└── tests/
    ├── sample_cases.test.js
