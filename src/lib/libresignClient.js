import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PDF = 16 * 1024 * 1024;
const API = "/ocs/v2.php/apps/libresign/api/v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (
  message,
  status = 502,
  reason = "PROVIDER_RESPONSE",
  uncertain = false,
) =>
  Object.assign(new Error(message), {
    status,
    code: "HR-5510",
    reason,
    uncertain,
  });
const positive = (n) => Number.isSafeInteger(n) && n > 0;

function baseAddress(raw, allowLocalHttp) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail("LibreSign address is not configured", 503, "CONFIGURATION");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(allowLocalHttp && local && url.protocol === "http:"))
  ) {
    throw fail("LibreSign requires an HTTPS address", 503, "CONFIGURATION");
  }
  return url.href.replace(/\/$/, "");
}

/** Server-owned configuration; a request can select only its verified tenant. */
export async function configuredLibreSign(
  tenantId,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  if (!UUID.test(tenantId || "") || !env.HR_LIBRESIGN_CONFIG_FILE)
    throw fail(
      "LibreSign is not configured for this tenant",
      503,
      "CONFIGURATION",
    );
  let entries;
  try {
    entries = JSON.parse(await readFile(env.HR_LIBRESIGN_CONFIG_FILE, "utf8"));
  } catch {
    throw fail(
      "LibreSign configuration could not be read",
      503,
      "CONFIGURATION",
    );
  }
  const config = entries?.[tenantId];
  if (!config?.baseUrl || !config?.username || !config?.appPasswordFile)
    throw fail(
      "LibreSign is not configured for this tenant",
      503,
      "CONFIGURATION",
    );
  const allowLocalHttp =
    env.NODE_ENV !== "production" &&
    env.HR_LIBRESIGN_ALLOW_LOCAL_HTTP === "true";
  const baseUrl = baseAddress(config.baseUrl, allowLocalHttp);
  // Separate Nextcloud accounts prevent one ERP tenant from enumerating another's offers.
  if (
    Object.entries(entries).some(
      ([id, other]) =>
        id !== tenantId &&
        baseAddress(other?.baseUrl, allowLocalHttp) === baseUrl &&
        other?.username?.toLowerCase() === config.username.toLowerCase(),
    )
  )
    throw fail(
      "Each tenant needs a separate LibreSign account",
      503,
      "CONFIGURATION",
    );
  let appPassword;
  try {
    appPassword = (await readFile(config.appPasswordFile, "utf8")).trim();
  } catch {
    throw fail("LibreSign credential is unavailable", 503, "CONFIGURATION");
  }
  return createLibreSignClient({
    ...config,
    tenantId,
    baseUrl,
    appPassword,
    allowLocalHttp,
    fetchImpl,
  });
}

export function createLibreSignClient({
  tenantId,
  baseUrl,
  username,
  appPassword,
  allowLocalHttp = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
}) {
  if (
    !UUID.test(tenantId || "") ||
    !/^[A-Za-z0-9_.@-]{1,128}$/.test(username || "") ||
    typeof appPassword !== "string" ||
    !appPassword ||
    /[\r\n]/.test(appPassword)
  )
    throw fail("LibreSign configuration is incomplete", 503, "CONFIGURATION");
  const base = baseAddress(baseUrl, allowLocalHttp);
  const auth =
    "Basic " + Buffer.from(username + ":" + appPassword).toString("base64");
  const davRoot = "/remote.php/dav/files/" + encodeURIComponent(username);

  async function request(
    path,
    {
      method = "GET",
      body,
      headers = {},
      accepted = [200],
      maximum = 1024 * 1024,
      uncertain = false,
    } = {},
  ) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        body,
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: auth,
          Accept: "application/json",
          "OCS-APIRequest": "true",
          ...headers,
        },
      });
      if (!accepted.includes(response.status)) {
        await response.body?.cancel();
        throw fail(
          "LibreSign rejected the request",
          502,
          "PROVIDER_REJECTED",
          uncertain && response.status >= 500,
        );
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > maximum) {
        await response.body?.cancel();
        throw fail("LibreSign response is too large");
      }
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const part of response.body) {
          size += part.length;
          if (size > maximum) throw fail("LibreSign response is too large");
          chunks.push(Buffer.from(part));
        }
      return {
        status: response.status,
        bytes: Buffer.concat(chunks),
        headers: response.headers,
      };
    } catch (error) {
      if (error.code === "HR-5510") {
        if (uncertain && error.reason === "PROVIDER_RESPONSE")
          error.uncertain = true;
        throw error;
      }
      // Do not attach fetch errors: they can contain credentials, signer addresses or URLs.
      throw fail("LibreSign could not be reached", 503, "TRANSPORT", uncertain);
    }
  }

  async function ocs(path, options = {}) {
    const result = await request(API + path, {
      ...options,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    let envelope;
    try {
      envelope = JSON.parse(result.bytes.toString("utf8"));
    } catch {
      throw fail(
        "LibreSign returned an invalid response",
        502,
        "PROVIDER_RESPONSE",
        options.uncertain,
      );
    }
    if (
      envelope?.ocs?.meta?.status !== "ok" ||
      ![100, 200].includes(Number(envelope?.ocs?.meta?.statuscode)) ||
      envelope.ocs.data == null
    )
      throw fail(
        "LibreSign did not confirm the operation",
        502,
        "PROVIDER_RESPONSE",
        options.uncertain,
      );
    return envelope.ocs.data;
  }

  function documentIdentity({
    kind = "offer",
    offerId,
    documentId,
    version,
    sha256,
  }) {
    const id = kind === "onboarding" ? documentId : offerId;
    if (
      !["offer", "onboarding"].includes(kind) ||
      !positive(id) ||
      !positive(version) ||
      !/^[0-9a-f]{64}$/.test(sha256 || "")
    )
      throw fail("A versioned offer PDF is required", 422, "DOCUMENT");
    const name = kind + "-" + id + "-v" + version + "-" + sha256;
    const folder =
      (kind === "onboarding"
        ? "/OnboardingDocuments/"
        : "/RecruitmentOffers/") + tenantId;
    return { name, path: davRoot + folder + "/" + name + ".pdf", folder };
  }

  function verifyWorkflow(row, expected) {
    if (
      !row ||
      !positive(row.id) ||
      !UUID.test(row.uuid || "") ||
      row.nodeId !== expected.nodeId ||
      row.name !== expected.name ||
      ![0, 1, 2, 3, 4, 5, 6].includes(row.status) ||
      !Array.isArray(row.signers) ||
      row.signers.length !== 1
    )
      throw fail(
        "LibreSign workflow does not match the approved offer",
        409,
        "IDENTITY",
      );
    const signer = row.signers[0];
    const emailIdentity = signer.identifyMethods?.find(
      (m) => m.method === "email",
    );
    const address = emailIdentity?.value ?? signer.email;
    if (
      typeof address !== "string" ||
      address.toLowerCase() !== expected.email.toLowerCase() ||
      !positive(signer.signRequestId)
    )
      throw fail(
        "LibreSign signer does not match the candidate",
        409,
        "IDENTITY",
      );
    if (
      expected.fileId &&
      (row.id !== expected.fileId || row.uuid !== expected.fileUuid)
    )
      throw fail("LibreSign document identity changed", 409, "IDENTITY");
    const signUuid = signer.sign_request_uuid;
    if (signUuid != null && !UUID.test(signUuid))
      throw fail("LibreSign returned an invalid signer session");
    if (
      row.status === 3 &&
      (!signer.signed ||
        !Number.isFinite(Date.parse(signer.signed)) ||
        Number(signer.status) !== 2)
    )
      throw fail(
        "LibreSign has not confirmed the required signature",
        409,
        "INCOMPLETE",
      );
    if (row.status === 6 && Number(signer.status) !== 3)
      throw fail(
        "LibreSign cancellation lacks the candidate rejection",
        409,
        "IDENTITY",
      );
    return {
      fileId: row.id,
      fileUuid: row.uuid,
      nodeId: row.nodeId,
      name: row.name,
      status: row.status,
      declined: row.status === 6 && Number(signer.status) === 3,
      signerId: signer.signRequestId,
      signedAt: signer.signed ?? null,
      signingUrl: signUuid
        ? base + "/index.php/apps/libresign/p/sign/" + signUuid
        : null,
    };
  }

  /** Idempotent upload: never overwrites an already prepared or signed file. */
  async function prepareDocument(input, bytes) {
    const identity = documentIdentity(input);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > MAX_PDF ||
      bytes.subarray(0, 5).toString() !== "%PDF-" ||
      digest(bytes) !== input.sha256
    )
      throw fail(
        "Offer PDF does not match its recorded checksum",
        422,
        "DOCUMENT",
      );
    for (const folder of [
      identity.folder.slice(0, identity.folder.lastIndexOf("/")),
      identity.folder,
    ])
      await request(davRoot + folder, {
        method: "MKCOL",
        accepted: [201, 405],
      });
    const uploaded = await request(identity.path, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "application/pdf", "If-None-Match": "*" },
      accepted: [201, 412],
    });
    if (uploaded.status === 412) {
      const prior = await request(identity.path, { maximum: MAX_PDF });
      if (digest(prior.bytes) !== input.sha256)
        throw fail("The prepared offer PDF has changed", 409, "DOCUMENT");
    }
    const props = await request(identity.path, {
      method: "PROPFIND",
      accepted: [207],
      headers: { "Content-Type": "application/xml", Depth: "0" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
    });
    const ids = [
      ...props.bytes
        .toString("utf8")
        .matchAll(
          /<(?:[A-Za-z_][\w.-]*:)?fileid[^>]*>\s*(\d+)\s*<\/(?:[A-Za-z_][\w.-]*:)?fileid>/g,
        ),
    ];
    if (ids.length !== 1 || !positive(Number(ids[0][1])))
      throw fail("LibreSign file identity is missing");
    return { ...identity, nodeId: Number(ids[0][1]) };
  }

  /** Read-only recovery after a timed-out POST; never creates another request. */
  async function reconcile(expected) {
    if (!positive(expected.nodeId) || !expected.name || !expected.email)
      throw fail("Prepared offer identity is required", 422, "DOCUMENT");
    const result = await ocs(
      "/file/list?details=1&length=2&page=1&nodeIds%5B%5D=" + expected.nodeId,
    );
    if (!Array.isArray(result.data))
      throw fail("LibreSign returned an invalid workflow list");
    if (result.data.length > 1)
      throw fail("Multiple LibreSign requests need review", 409, "AMBIGUOUS");
    return result.data.length ? verifyWorkflow(result.data[0], expected) : null;
  }

  /** Call once under the persisted offer job's lock; uncertain outcomes must use reconcile. */
  async function requestSignature(expected) {
    if (
      !positive(expected.nodeId) ||
      !expected.name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expected.email || "")
    )
      throw fail(
        "Prepared offer and candidate email are required",
        422,
        "DOCUMENT",
      );
    const current = await reconcile(expected);
    if (current) return current;
    const row = await ocs("/request-signature", {
      method: "POST",
      uncertain: true,
      body: {
        name: expected.name,
        file: { nodeId: expected.nodeId },
        status: 1,
        signers: [
          {
            identifyMethods: [
              { method: "email", value: expected.email, mandatory: 1 },
            ],
            displayName: expected.displayName || "Candidate",
            // LibreSign delivers the private signer UUID only to the verified mailbox.
            notify: 1,
          },
        ],
      },
    });
    try {
      return verifyWorkflow(row, expected);
    } catch (error) {
      error.uncertain = true;
      throw error;
    }
  }

  async function downloadSigned(expected) {
    const current = await reconcile(expected);
    if (!current || current.status !== 3)
      throw fail("Offer signature is not complete", 409, "INCOMPLETE");
    const result = await request(
      "/index.php/apps/libresign/p/pdf/" + current.fileUuid,
      { maximum: MAX_PDF },
    );
    if (result.bytes.subarray(0, 5).toString() !== "%PDF-")
      throw fail("LibreSign did not return a signed PDF");
    return {
      bytes: result.bytes,
      sha256: digest(result.bytes),
      workflow: current,
    };
  }

  async function cancel(expected) {
    const current = await reconcile(expected);
    if (!current || current.status === 4) return { cancelled: true };
    if (current.status === 3)
      throw fail("A completed signature cannot be cancelled", 409, "FINALIZED");
    await ocs("/file/file_id/" + current.fileId + "?deleteFile=false", {
      method: "DELETE",
    });
    return { cancelled: true };
  }

  async function erase(expected, document) {
    const identity = documentIdentity(document);
    // The deterministic DAV path also cleans a timed-out upload with no recorded nodeId.
    if (expected.nodeId) {
      const current = await reconcile(expected);
      if (current)
        await ocs("/file/file_id/" + current.fileId + "?deleteFile=true", {
          method: "DELETE",
        });
    }
    await request(identity.path, { method: "DELETE", accepted: [204, 404] });
    const remaining = await request(identity.path, {
      method: "HEAD",
      accepted: [200, 404],
    });
    if (remaining.status !== 404)
      throw fail("LibreSign document erasure is pending", 503, "ERASURE");
    if (expected.nodeId && (await reconcile(expected)))
      throw fail("LibreSign workflow erasure is pending", 503, "ERASURE");
    return { erased: true };
  }
  return Object.freeze({
    prepareDocument,
    reconcile,
    requestSignature,
    downloadSigned,
    cancel,
    erase,
  });
}
