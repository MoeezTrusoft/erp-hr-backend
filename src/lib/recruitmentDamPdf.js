import { signServiceJwtEdDSA } from "./serviceJwt.js";

const fail = () =>
  Object.assign(new Error("Offer PDF could not be downloaded securely"), {
    status: 503,
    code: "HR-5511",
  });
/** Authenticate only to DAM. Signed storage redirects never receive internal credentials. */
export async function downloadRecruitmentPdf(
  tenantId,
  mediaId,
  { fetchImpl = globalThis.fetch, env = process.env } = {},
) {
  if (
    !Number.isSafeInteger(mediaId) ||
    mediaId < 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      tenantId || "",
    )
  )
    throw fail();
  const token = signServiceJwtEdDSA({ tenantId, tid: tenantId });
  if (!token || !env.DAM_SERVICE_URL) throw fail();
  const endpoint = new URL(
    env.DAM_SERVICE_URL.replace(/\/$/, "") + "/assets/video-stream/" + mediaId,
  );
  const allowed = new Set(
    (env.HR_DAM_DOWNLOAD_HOSTS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers = {
    "X-Service-Authorization": "Bearer " + token,
    "X-Tenant-Id": tenantId,
  };
  const limit = 16 * 1024 * 1024;
  let response,
    currentUrl = endpoint;
  try {
    response = await fetchImpl(endpoint, {
      headers,
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(15000),
    });
    for (
      let redirect = 0;
      [301, 302, 303, 307, 308].includes(response.status);
      redirect++
    ) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (redirect >= 2 || !location) throw fail();
      const next = new URL(location, currentUrl);
      if (
        next.protocol !== "https:" ||
        next.username ||
        next.password ||
        !allowed.has(next.hostname.toLowerCase())
      )
        throw fail();
      currentUrl = next;
      response = await fetchImpl(next, {
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(15000),
      });
    }
    if (
      response.status !== 200 ||
      Number(response.headers.get("content-length")) > limit
    ) {
      await response.body?.cancel();
      throw fail();
    }
    const parts = [];
    let length = 0;
    for await (const part of response.body) {
      length += part.length;
      if (length > limit) throw fail();
      parts.push(Buffer.from(part));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw fail();
    return bytes;
  } catch {
    throw fail();
  }
}
