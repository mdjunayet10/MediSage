import { z } from "zod";
import { isInternalClassifierText } from "./aiResponse.js";

const sourceSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["document", "dataset"]),
    title: z.string().min(1),
    excerpt: z.string().min(1),
  })
  .passthrough();

export const chatDataSchema = z.object({
  answer: z
    .string()
    .trim()
    .min(30)
    .refine((value) => !isInternalClassifierText(value)),
  groundingType: z.enum(["general", "document", "dataset", "hybrid"]),
  sources: z.array(sourceSchema),
  relatedQuestions: z.array(z.string().trim().min(8).max(180)).max(8),
  safety: z.object({
    level: z.enum(["normal", "caution", "urgent"]),
    requiresUrgentCare: z.boolean(),
    warning: z.string().nullable(),
  }),
});

export function successEnvelope(data, requestId, meta = {}) {
  return {
    success: true,
    data,
    meta: { requestId, createdAt: new Date().toISOString(), ...meta },
  };
}

export function errorEnvelope(code, message, requestId, meta = {}) {
  return {
    success: false,
    error: { code, message },
    meta: { requestId, ...meta },
  };
}
