const URGENT_PATTERNS = [
  /severe|crushing|sudden.*chest pain|chest pain.*(breath|breathing)/i,
  /can't breathe|cannot breathe|difficulty breathing|not breathing/i,
  /face droop|one[- ]sided weakness|slurred speech|stroke symptoms/i,
  /unconscious|passed out|severe bleeding|anaphylaxis|overdose|poisoning/i,
  /suicidal|kill myself|end my life|self[- ]harm/i,
  /বুকে তীব্র ব্যথা|শ্বাস নিতে পারছি না|শ্বাসকষ্ট খুব বেশি|অজ্ঞান|প্রচুর রক্তপাত|আত্মহত্যা/i,
];

const CAUTION_PATTERNS = [
  /symptom|pain|fever|rash|vomit|bleeding|dizzy|medicine|medication|dose|pregnan/i,
  /লক্ষণ|ব্যথা|জ্বর|ওষুধ|মাত্রা|গর্ভবতী/i,
];

export function evaluateSafety({ message = "" }) {
  const requiresUrgentCare = URGENT_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
  const level = requiresUrgentCare
    ? "urgent"
    : CAUTION_PATTERNS.some((pattern) => pattern.test(message))
      ? "caution"
      : "normal";
  return {
    level,
    requiresUrgentCare,
    warning: requiresUrgentCare
      ? "These symptoms may require emergency care. Contact your local emergency service now or go to the nearest emergency department."
      : null,
    guidance: requiresUrgentCare
      ? "Respond concisely. Lead with immediate emergency action, avoid diagnosis, and do not delay care with lengthy explanations."
      : level === "caution"
        ? "Include proportionate safety guidance without overwhelming the direct answer."
        : "Answer directly without adding irrelevant urgent-care language.",
  };
}
