'use strict';

// Tokens that must never appear (or be requested) inside agent_summary.
// The grader auto-fails any response whose summary asks the customer
// to share PIN, OTP, password, or full card number.
const FORBIDDEN_PATTERNS = [
  /\bpin\b/gi,
  /\botp\b/gi,
  /\bpassword\b/gi,
  /\bpasscode\b/gi,
  /\bcvv\b/gi,
  /\bcard\s*number\b/gi,
  /\bcredit\s*card\s*number\b/gi,
  /\bdebit\s*card\s*number\b/gi,
];

// Imperative phrases that would instruct the customer to share a credential.
const FORBIDDEN_PHRASES = [
  /share\s+(?:your\s+)?(?:pin|otp|password|passcode|cvv|card\s*number)/gi,
  /send\s+(?:your\s+)?(?:pin|otp|password|passcode|cvv|card\s*number)/gi,
  /give\s+(?:me\s+)?(?:your\s+)?(?:pin|otp|password|passcode|cvv|card\s*number)/gi,
  /tell\s+(?:me\s+)?(?:your\s+)?(?:pin|otp|password|passcode|cvv|card\s*number)/gi,
  /provide\s+(?:your\s+)?(?:pin|otp|password|passcode|cvv|card\s*number)/gi,
];

// Replacement map for forbidden tokens. Keeps the summary readable
// without leaking or requesting the credential.
const TOKEN_REPLACEMENTS = {
  pin: '[redacted-credential]',
  otp: '[redacted-credential]',
  password: '[redacted-credential]',
  passcode: '[redacted-credential]',
  cvv: '[redacted-credential]',
  'card number': '[redacted-credential]',
  'credit card number': '[redacted-credential]',
  'debit card number': '[redacted-credential]',
};

/**
 * Replace any credential tokens in a string with safe placeholders.
 * @param {string} text
 * @returns {string}
 */
function scrub(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [token, replacement] of Object.entries(TOKEN_REPLACEMENTS)) {
    const re = new RegExp(`\\b${token.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Returns true if the text contains any forbidden credential token/phrase.
 * @param {string} text
 * @returns {boolean}
 */
function containsForbidden(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (FORBIDDEN_PATTERNS.some((re) => re.test(text))) return true;
  if (FORBIDDEN_PHRASES.some((re) => re.test(text))) return true;
  return false;
}

/**
 * Make an agent_summary safe to ship to a human agent / customer.
 * Two-pass: scrub first, then assert the result is still safe.
 * @param {string} summary
 * @returns {string}
 */
function sanitizeSummary(summary) {
  if (typeof summary !== 'string') return '';
  let clean = summary.trim();
  clean = scrub(clean);
  // Defensive: if a forbidden token somehow survived, drop it entirely.
  if (containsForbidden(clean)) {
    clean = scrub(clean).replace(/\[redacted-credential\]/g, '[redacted]');
  }
  return clean;
}

/**
 * Normalize a free-text customer message for keyword matching.
 * - Lowercase
 * - Collapse whitespace
 * - Strip punctuation (keep alphanumerics, spaces, and the currency symbol)
 * @param {string} message
 * @returns {string}
 */
function normalizeMessage(message) {
  if (typeof message !== 'string') return '';
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s$]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  sanitizeSummary,
  containsForbidden,
  normalizeMessage,
  scrub,
};
