'use strict';

const { sanitizeSummary } = require('../utils/sanitizer');

// ---------------------------------------------------------------------------
// Keyword dictionaries.
//
// Phrases are matched against a normalized lowercase, punctuation-stripped
// version of the customer message. Multi-word phrases match when the entire
// phrase appears as a substring (whitespace-collapsed). Single tokens match
// as word-boundary substrings to avoid false hits like "refundable" hitting
// "refund".
//
// Each case_type has two tiers:
//   - strong: very specific signal, dominates weak tiers
//   - weak:   supporting signal, summed up
//
// Phishing has the highest priority: any strong phishing hit overrides
// every other classification, including refund/payment_failed, because the
// safety rule is stricter than topical accuracy.
// ---------------------------------------------------------------------------

const CASE_TYPE = Object.freeze({
  WRONG_TRANSFER: 'wrong_transfer',
  PAYMENT_FAILED: 'payment_failed',
  REFUND_REQUEST: 'refund_request',
  PHISHING: 'phishing_or_social_engineering',
  OTHER: 'other',
});

const STRONG_KEYWORDS = {
  [CASE_TYPE.WRONG_TRANSFER]: [
    'wrong number',
    'wrong account',
    'wrong person',
    'wrong recipient',
    'sent to wrong',
    'sent money to wrong',
    'sent money wrong',
    'transferred to wrong',
    'transfer to wrong',
    'mistakenly sent',
    'accidentally sent',
    'sent by mistake',
    'sent to a wrong',
    'wrong number this morning',
    'wrong recipient please',
  ],
  [CASE_TYPE.PAYMENT_FAILED]: [
    'payment failed',
    'transaction failed',
    'payment declined',
    'transaction declined',
    'failed but balance deducted',
    'failed but money deducted',
    'failed but amount deducted',
    'failed but balance was deducted',
    'deducted but not received',
    'money deducted but',
    'amount deducted but',
    'balance deducted but',
    'did not receive',
    'didnt receive',
    "didn't receive",
    'not credited',
    'payment pending',
    'transaction pending',
    'pending but deducted',
    'failed mid transaction',
    'failed mid way',
    'failed during',
    'declined the payment',
    'charge but failed',
    'charged but failed',
    'failed but charged',
  ],
  [CASE_TYPE.REFUND_REQUEST]: [
    'please refund',
    'want a refund',
    'want refund',
    'want my refund',
    'need a refund',
    'need refund',
    'request a refund',
    'request refund',
    'asking for refund',
    'ask for refund',
    'ask for a refund',
    'refund my',
    'refund the',
    'refund please',
    'refund my last transaction',
    'refund my payment',
    'refund my money',
    'refund my order',
    'refund request',
    'give my money back',
    'get my money back',
    'money back please',
    'return my money',
    'changed my mind',
  ],
  [CASE_TYPE.PHISHING]: [
    'asking my otp',
    'asking for otp',
    'asked for otp',
    'asked my otp',
    'asked my pin',
    'asking my pin',
    'asking for pin',
    'asked for pin',
    'asking for password',
    'asked for password',
    'asked my password',
    'share your otp',
    'share your pin',
    'share otp',
    'share pin',
    'sending otp',
    'send your otp',
    'send otp',
    'tell me your otp',
    'tell me your pin',
    'fake call',
    'fake sms',
    'fraud call',
    'fraud sms',
    'scam call',
    'scam sms',
    'phishing call',
    'phishing sms',
    'phishing link',
    'phishing email',
    'suspicious link',
    'suspicious call',
    'suspicious sms',
    'suspicious message',
    'someone called asking',
    'someone asking for',
    'pretending to be',
    'impersonating',
    'is that bkash',
    'is that nagad',
    'is that rocket',
    'is that bank',
    'asked for my card',
    'asked for cvv',
    'asking for cvv',
    'asked for my pin',
    'fake customer care',
    'fake helpline',
    'fake support',
    'is this legitimate',
    'is this real',
    'is this legit',
    'asked me to share',
    'asking me to share',
    'asked me to send',
    'asking me to send',
  ],
};

// Weak / supporting keywords — only count when strong tier did not fire for
// any other category. They contribute to confidence but not to the
// case_type pick when a stronger signal is present.
const WEAK_KEYWORDS = {
  [CASE_TYPE.WRONG_TRANSFER]: [
    'wrong',
    'mistake',
    'mistakenly',
    'accidentally',
    'sent',
    'sent 5000',
    'sent 3000',
    'sent 1000',
    'transfer',
    'transferred',
    'to a wrong',
    'wrong number',
    'please help me get it back',
    'help me get it back',
    'get it back',
    'get my money back',
  ],
  [CASE_TYPE.PAYMENT_FAILED]: [
    'failed',
    'fail',
    'declined',
    'deducted',
    'balance',
    'pending',
    'not received',
    'charged',
    'not credited',
    'transaction',
    'payment',
    'mid transaction',
    'crash',
    'crashed',
    'stuck',
  ],
  [CASE_TYPE.REFUND_REQUEST]: [
    'refund',
    'money back',
    'return',
    'cancel',
    'cancellation',
    'changed my mind',
    'reversal',
    'reverse',
  ],
  [CASE_TYPE.PHISHING]: [
    'otp',
    'pin',
    'password',
    'cvv',
    'phishing',
    'scam',
    'fraud',
    'fake',
    'suspicious',
    'impersonat',
    'social engineering',
    'someone called',
    'someone is asking',
    'asked for',
    'asking for',
    'is that',
    'is this',
    'legitimate',
    'verify your',
    'verify account',
  ],
};

const DEFAULT_SEVERITY = {
  [CASE_TYPE.WRONG_TRANSFER]: 'high',
  [CASE_TYPE.PAYMENT_FAILED]: 'high',
  [CASE_TYPE.REFUND_REQUEST]: 'low',
  [CASE_TYPE.PHISHING]: 'critical',
  [CASE_TYPE.OTHER]: 'low',
};

const DEPARTMENT_FOR = {
  [CASE_TYPE.WRONG_TRANSFER]: 'dispute_resolution',
  [CASE_TYPE.PAYMENT_FAILED]: 'payments_ops',
  [CASE_TYPE.REFUND_REQUEST]: 'customer_support', // escalated to dispute_resolution if contested — out of scope for v1
  [CASE_TYPE.PHISHING]: 'fraud_risk',
  [CASE_TYPE.OTHER]: 'customer_support',
};

// Boost severity under certain conditions even when the case_type is
// something else. Highest severity wins.
const SEVERITY_BOOSTS = [
  { test: /\b(?:immediately|urgent|asap|right now|emergency|blocked|stolen|hacked)\b/i, to: 'high' },
  { test: /\b(?:police|arrested|threat|threatening)\b/i, to: 'critical' },
];

// Amount pattern for richer summaries: matches things like
// "5000 taka", "BDT 2,500", "$120", "1.5 lakh", "5000tk".
const AMOUNT_PATTERN = /(?:[\$৳£€]?\s?[\d][\d,]*(?:\.\d+)?\s*(?:taka|bdt|tk|usd|dollar|rup|rs|inr|lakh|lac|k|thousand|mn|million)?)/i;

const COUNTRY_HINTS = [
  { test: /\b(?:taka|bkash|nagad|rocket|bdt|bd\b)\b/i, country: 'Bangladesh', currency: 'BDT' },
  { test: /\b(?:rupees?|inr|bharat|india)\b/i, country: 'India', currency: 'INR' },
  { test: /\b(?:usd|dollar|us)\b/i, country: 'United States', currency: 'USD' },
];

// Pre-built regexes — one per keyword — for word-boundary token matching.
function buildMatchers(keywords) {
  return keywords.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // For multi-word phrases we want a substring match; for single tokens
    // we add word boundaries so "otp" doesn't fire inside "laptop".
    const isMultiWord = kw.includes(' ');
    return isMultiWord
      ? new RegExp(escaped, 'i')
      : new RegExp(`\\b${escaped}\\b`, 'i');
  });
}

const STRONG_MATCHERS = Object.fromEntries(
  Object.entries(STRONG_KEYWORDS).map(([k, v]) => [k, buildMatchers(v)])
);

const WEAK_MATCHERS = Object.fromEntries(
  Object.entries(WEAK_KEYWORDS).map(([k, v]) => [k, buildMatchers(v)])
);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Pick the case_type based on strong-keyword matches, with phishing as
 * a safety-first tiebreaker.
 * @param {string} normalized
 * @returns {{case_type: string, strongHits: number}}
 */
function pickCaseType(normalized) {
  const hits = {};
  for (const [caseType, matchers] of Object.entries(STRONG_MATCHERS)) {
    let count = 0;
    for (const re of matchers) {
      if (re.test(normalized)) count += 1;
    }
    hits[caseType] = count;
  }

  // Phishing safety override — any strong phishing hit wins outright.
  if (hits[CASE_TYPE.PHISHING] > 0) {
    return { case_type: CASE_TYPE.PHISHING, strongHits: hits[CASE_TYPE.PHISHING] };
  }

  let best = CASE_TYPE.OTHER;
  let bestHits = 0;
  for (const [caseType, count] of Object.entries(hits)) {
    if (count > bestHits) {
      bestHits = count;
      best = caseType;
    }
  }
  return { case_type: best, strongHits: bestHits };
}

/**
 * Count weak-keyword hits per case_type — used for confidence only.
 * @param {string} normalized
 * @returns {Record<string, number>}
 */
function weakHits(normalized) {
  const out = {};
  for (const [caseType, matchers] of Object.entries(WEAK_MATCHERS)) {
    let count = 0;
    for (const re of matchers) {
      if (re.test(normalized)) count += 1;
    }
    out[caseType] = count;
  }
  return out;
}

/**
 * Compute a confidence score in [0.3, 0.99] using strong-vs-weak ratio.
 * @param {number} strong
 * @param {number} topWeak
 * @param {number} secondWeak
 * @returns {number}
 */
function computeConfidence(strong, topWeak, secondWeak) {
  if (strong > 0) {
    const base = Math.min(1, 0.7 + strong * 0.1);
    return round(Math.max(0.7, Math.min(0.99, base)));
  }
  if (topWeak <= 0) return 0.3;
  const denom = topWeak + secondWeak;
  if (denom === 0) return 0.3;
  const ratio = topWeak / denom;
  return round(Math.max(0.3, Math.min(0.7, ratio)));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Decide final severity: start from the default for the case_type, then
 * apply boosts.
 * @param {string} case_type
 * @param {string} originalMessage
 * @returns {string}
 */
function pickSeverity(case_type, originalMessage) {
  const order = ['low', 'medium', 'high', 'critical'];
  let severity = DEFAULT_SEVERITY[case_type] || 'medium';
  let idx = order.indexOf(severity);
  for (const boost of SEVERITY_BOOSTS) {
    if (boost.test.test(originalMessage)) {
      const boostIdx = order.indexOf(boost.to);
      if (boostIdx > idx) {
        idx = boostIdx;
        severity = boost.to;
      }
    }
  }
  return severity;
}

/**
 * Extract the first monetary amount and currency from the message, used
 * to make the summary more useful.
 * @param {string} message
 * @returns {{amount: string|null, currency: string|null}}
 */
function extractAmount(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return { amount: null, currency: null };
  }
  const m = message.match(AMOUNT_PATTERN);
  const amount = m ? m[0].trim() : null;
  let currency = null;
  for (const hint of COUNTRY_HINTS) {
    if (hint.test.test(message)) {
      currency = hint.currency;
      break;
    }
  }
  return { amount, currency };
}

/**
 * Build a one-or-two-sentence neutral summary describing the ticket.
 * @param {string} message
 * @param {string} case_type
 * @returns {string}
 */
function buildSummary(message, case_type) {
  const { amount, currency } = extractAmount(message);
  const amountPhrase = amount
    ? currency
      ? `${amount} ${currency}`
      : amount
    : null;

  switch (case_type) {
    case CASE_TYPE.WRONG_TRANSFER:
      return amountPhrase
        ? `Customer reports sending ${amountPhrase} to the wrong recipient and is requesting recovery.`
        : 'Customer reports sending money to the wrong recipient and is requesting recovery.';
    case CASE_TYPE.PAYMENT_FAILED:
      return amountPhrase
        ? `Customer reports a ${amountPhrase} payment that failed although the balance may have been deducted.`
        : 'Customer reports a payment that failed although the balance may have been deducted.';
    case CASE_TYPE.REFUND_REQUEST:
      return amountPhrase
        ? `Customer is requesting a refund of ${amountPhrase} for a recent transaction.`
        : 'Customer is requesting a refund for a recent transaction.';
    case CASE_TYPE.PHISHING:
      return 'Customer reports a suspicious interaction in which a third party attempted to obtain account credentials. Flagged for fraud-team review.';
    case CASE_TYPE.OTHER:
    default:
      return 'Customer has raised an issue that does not match a known category; routing to general customer support for triage.';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single ticket message.
 * @param {{message: string}} input
 * @returns {{
 *   case_type: string,
 *   severity: string,
 *   department: string,
 *   agent_summary: string,
 *   human_review_required: boolean,
 *   confidence: number
 * }}
 */
function classify({ message }) {
  const { normalizeMessage } = require('../utils/sanitizer');
  const normalized = normalizeMessage(message);
  const { case_type, strongHits } = pickCaseType(normalized);

  // Weak hits for confidence: top scorer of this category, then the
  // runner-up.
  const weak = weakHits(normalized);
  const sorted = Object.values(weak).sort((a, b) => b - a);
  const topWeak = sorted[0] || 0;
  const secondWeak = sorted[1] || 0;
  const confidence = computeConfidence(strongHits, topWeak, secondWeak);

  const severity = pickSeverity(case_type, message);
  const department = DEPARTMENT_FOR[case_type] || 'customer_support';

  const rawSummary = buildSummary(message, case_type);
  const agent_summary = sanitizeSummary(rawSummary);

  const human_review_required =
    severity === 'critical' ||
    severity === 'high' ||
    case_type === CASE_TYPE.PHISHING;

  return {
    case_type,
    severity,
    department,
    agent_summary,
    human_review_required,
    confidence,
  };
}

module.exports = {
  classify,
  CASE_TYPE,
  DEPARTMENT_FOR,
  DEFAULT_SEVERITY,
  extractAmount,
};
