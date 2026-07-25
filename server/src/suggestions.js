import { tokenize } from "./retrieval.js";

const DOCUMENT_QUESTIONS = {
  en: [
    "Summarize this document with page references.",
    "Create exam-focused notes from this PDF.",
    "List the most important definitions.",
    "Explain the most difficult section simply.",
    "Generate ten short questions and answers.",
    "Compare the two main concepts in the document.",
    "Create a revision checklist.",
    "Identify information that requires professional verification.",
  ],
  bn: [
    "পৃষ্ঠা উল্লেখ করে এই ডকুমেন্টের সারাংশ দিন।",
    "এই PDF থেকে পরীক্ষাভিত্তিক নোট তৈরি করুন।",
    "সবচেয়ে গুরুত্বপূর্ণ সংজ্ঞাগুলো তালিকাভুক্ত করুন।",
    "সবচেয়ে কঠিন অংশটি সহজভাবে বুঝিয়ে দিন।",
    "দশটি সংক্ষিপ্ত প্রশ্ন ও উত্তর তৈরি করুন।",
    "ডকুমেন্টের প্রধান দুটি ধারণা তুলনা করুন।",
    "দ্রুত রিভিশনের একটি তালিকা তৈরি করুন।",
    "যেসব তথ্য পেশাদারভাবে যাচাই করা দরকার তা চিহ্নিত করুন।",
  ],
};

export function detectedLanguage(text = "", requested = "auto") {
  if (requested !== "auto") return requested;
  return /[\u0980-\u09FF]/.test(text) ? "bn" : "en";
}

export function documentSuggestions(document, outputLanguage = "auto") {
  const language = detectedLanguage(
    document.chunks
      .slice(0, 5)
      .map((chunk) => chunk.text)
      .join(" "),
    outputLanguage,
  );
  const base = DOCUMENT_QUESTIONS[language];
  const frequency = new Map();
  for (const chunk of document.chunks.slice(0, 40)) {
    for (const token of tokenize(chunk.text))
      frequency.set(token, (frequency.get(token) || 0) + 1);
  }
  const keyTerm = [...frequency.entries()]
    .filter(
      ([token]) =>
        token.length > 5 &&
        !/^https?$|copyright|document|information$/i.test(token),
    )
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const dynamic = keyTerm
    ? language === "bn"
      ? `এই ডকুমেন্টে “${keyTerm}” কীভাবে ব্যবহৃত হয়েছে বুঝিয়ে দিন।`
      : `Explain how “${keyTerm}” is used in this document.`
    : null;
  const offset = document.filename.length % 3;
  return [dynamic, ...base.slice(offset), ...base.slice(0, offset)]
    .filter(Boolean)
    .slice(0, 8);
}

export function relatedQuestions({
  question,
  groundingType,
  outputLanguage = "auto",
}) {
  const language = detectedLanguage(question, outputLanguage);
  if (language === "bn") {
    return ["document", "hybrid"].includes(groundingType)
      ? [
          "কোন পৃষ্ঠাগুলোতে সবচেয়ে শক্তিশালী সমর্থন আছে?",
          "এই উত্তরটি সংক্ষিপ্ত স্টাডি নোটে রূপান্তর করুন।",
          "ডকুমেন্টে কোন গুরুত্বপূর্ণ সীমাবদ্ধতার কথা বলা হয়েছে?",
        ]
      : [
          "মনে রাখার মতো মূল বিষয়গুলো কী?",
          "এই বিষয়ে প্রচলিত ভুল ধারণাগুলো কী?",
          "কখন পেশাদার চিকিৎসা পরামর্শ নেওয়া উচিত?",
        ];
  }
  const topic =
    question
      .replace(/[?!.]+$/g, "")
      .replace(
        /^(?:what are the key points to remember about|what common misconceptions relate to|when should someone seek professional advice about)\s+/i,
        "",
      )
      .replace(
        /^(?:please\s+)?(?:explain|describe|summarize|tell me about|what (?:is|are)|how does|compare)\s+/i,
        "",
      )
      .replace(/\s+in (?:simple|clear) language$/i, "")
      .trim()
      .slice(0, 90) || "this topic";
  if (["document", "hybrid"].includes(groundingType))
    return [
      "Which locations contain the strongest supporting details?",
      "Turn this answer into concise study notes.",
      "What important limitations does the document mention?",
    ];
  return [
    `What are the key points to remember about ${topic}?`,
    `What common misconceptions relate to ${topic}?`,
    `When should someone seek professional advice about ${topic}?`,
  ];
}
