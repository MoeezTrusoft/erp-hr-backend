export function portalPolicy(tenantId) {
  let policies = {};
  try {
    policies = JSON.parse(process.env.HR_PORTAL_POLICIES || "{}");
  } catch {
    /* Fail closed below. */
  }
  const policy = policies[tenantId] ?? {
    version: process.env.HR_PORTAL_PRIVACY_POLICY_VERSION,
    url: process.env.HR_PORTAL_PRIVACY_POLICY_URL,
  };
  if (
    !policy?.version ||
    typeof policy.version !== "string" ||
    policy.version.length > 100 ||
    !/^https:\/\//.test(policy.url ?? "")
  ) {
    throw Object.assign(
      new Error(
        "Applications are temporarily unavailable. Please try again later.",
      ),
      { status: 503, code: "HR-5802" },
    );
  }
  return { version: policy.version, url: policy.url };
}
