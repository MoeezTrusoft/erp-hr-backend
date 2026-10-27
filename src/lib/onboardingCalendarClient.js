import { signServiceJwtEdDSA } from "./serviceJwt.js";
import {
  OnboardingCalendarIntent,
  OnboardingCalendarReceipt,
} from "@trusoft/contracts/recruitment-calendar";
export async function syncOnboardingCalendar({ tenantId, intent }) {
  const payload = OnboardingCalendarIntent.parse(intent);
  const token = signServiceJwtEdDSA({
    tid: tenantId,
    purpose: "onboarding-calendar",
  });
  if (!token)
    throw Object.assign(new Error("Calendar service credential unavailable"), {
      code: "HR-5901",
    });
  const base = process.env.COMMUNICATION_SERVICE_URL;
  if (!base)
    throw Object.assign(new Error("Calendar service URL unavailable"), {
      code: "HR-5902",
    });
  let url;
  try {
    url = new URL("/internal/onboarding/calendar", base);
  } catch {
    throw Object.assign(new Error("Invalid calendar service URL"), {
      code: "HR-5902",
    });
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Object.assign(new Error("Invalid calendar service URL"), {
      code: "HR-5902",
    });
  const response = await globalThis.fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      "X-Service-Authorization": "Bearer " + token,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(
      new Error("Calendar service rejected synchronization"),
      { code: "HR-5903" },
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw Object.assign(new Error("Calendar response missing"), {
      code: "HR-5903",
    });
  let text = "",
    length = 0;
  const decoder = new globalThis.TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) throw Error("Response too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const result = OnboardingCalendarReceipt.parse(JSON.parse(text));
    if (
      result.sessionId !== payload.sessionId ||
      result.revision !== payload.revision ||
      result.state !== payload.state ||
      (result.state !== "CANCELLED" && !result.eventId)
    )
      throw Error("Receipt identity mismatch");
    return result;
  } catch {
    await reader.cancel().catch(() => {});
    throw Object.assign(new Error("Invalid calendar synchronization receipt"), {
      code: "HR-5904",
    });
  }
}
