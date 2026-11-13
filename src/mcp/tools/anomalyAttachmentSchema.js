import { z } from "zod";
export const anomalyAttachmentsSchema = z
  .array(
    z
      .object({
        fileName: z.string().min(1).max(200),
        mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
        fileBase64: z.string().min(1).max(2800000),
      })
      .strict(),
  )
  .max(5)
  .optional();
