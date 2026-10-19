// src/services/engagement/redaction.js — C4 minimisation before any text is
// sent to the LLM or persisted on a fact. The engine needs commercial and
// editorial context, never payment instruments or secrets. Replacements are
// stable tokens so the model still sees that "a card number was shared".
// Order matters: the more specific identity patterns run before the generic
// digit-run card pattern so a CNIC is labelled as such.
const RULES = [
  { name: "CNIC", re: /\b\d{5}-\d{7}-\d\b/g },
  { name: "IBAN", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g },
  { name: "CARD", re: /\b(?:\d[ -]?){13,19}\b/g },
  { name: "SECRET", re: /\b(password|passcode|pin|otp|cvv|cvc)\b\s*[:=]\s*\S+/gi },
  { name: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
];

export function redactSensitive(text) {
  let out = String(text ?? "");
  for (const rule of RULES) out = out.replace(rule.re, `[REDACTED:${rule.name}]`);
  return out;
}

export function redactEvent(event) {
  return { ...event, subject: redactSensitive(event.subject), body: redactSensitive(event.body) };
}
