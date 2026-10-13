#!/usr/bin/env python3
"""
ERP-grade AI pull-request reviewer.

Model-agnostic: talks to ANY OpenAI-compatible chat-completions endpoint, so it
runs on DeepSeek (default, low cost), or a free tier (Google Gemini via its
OpenAI-compat endpoint, Groq, OpenRouter), or a self-hosted model — by changing
env vars only, never this code.

It reviews the PR DIFF against the ERP rubric (ci-cd/ai-review-rubric.md) and
focuses on the classes static tools (eslint/tests/build) CANNOT catch:
multi-tenant isolation, authz gaps, cross-service contract drift, secret/PII
leakage, architecture-rule violations, correctness/data-safety, incomplete
refactors. Findings are posted as a single PR review comment grouped by severity.

Env (all provided by the reusable workflow):
  AI_REVIEW_API_KEY     - key for the model provider              (secret, required)
  AI_REVIEW_BASE_URL    - default https://api.deepseek.com/v1
  AI_REVIEW_MODEL       - default deepseek-chat
  AI_REVIEW_BLOCKING    - "true" -> exit 1 when a blocking-severity finding exists
  GITHUB_TOKEN          - to fetch the diff and post the comment  (built-in)
  GITHUB_REPOSITORY     - owner/repo
  PR_NUMBER             - pull-request number
  RUBRIC_PATH           - default ci-cd/ai-review-rubric.md
  MAX_DIFF_CHARS        - default 180000 (truncate very large diffs)
"""
import json
import os
import sys
import urllib.request
import urllib.error

API_KEY = os.environ.get("AI_REVIEW_API_KEY", "").strip()
BASE_URL = os.environ.get("AI_REVIEW_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
MODEL = os.environ.get("AI_REVIEW_MODEL", "deepseek-chat")
BLOCKING = os.environ.get("AI_REVIEW_BLOCKING", "false").lower() == "true"
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
PR = os.environ.get("PR_NUMBER", "")
RUBRIC_PATH = os.environ.get("RUBRIC_PATH", "ci-cd/ai-review-rubric.md")
MAX_DIFF = int(os.environ.get("MAX_DIFF_CHARS", "180000"))
BLOCKING_SEVERITIES = {"critical", "high"}


def http(method, url, headers, data=None, raw=False):
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read().decode()


def gh(method, path, data=None, accept="application/vnd.github+json"):
    return http(
        method,
        f"https://api.github.com{path}",
        {"Authorization": f"Bearer {GH_TOKEN}", "Accept": accept,
         "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "erp-ai-review"},
        data,
    )


def get_diff():
    # The unified diff of the whole PR, straight from GitHub.
    return gh("GET", f"/repos/{REPO}/pulls/{PR}", accept="application/vnd.github.v3.diff")


def call_model(system, user):
    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0.1,
        "max_tokens": 4000,
        # Ask for strict JSON where the provider supports it (DeepSeek/OpenAI do).
        "response_format": {"type": "json_object"},
    }
    try:
        out = http("POST", f"{BASE_URL}/chat/completions",
                   {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
                   payload)
    except urllib.error.HTTPError as e:
        # Retry once without response_format for providers that reject it.
        payload.pop("response_format", None)
        out = http("POST", f"{BASE_URL}/chat/completions",
                   {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
                   payload)
    return json.loads(out)["choices"][0]["message"]["content"]


def parse_findings(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text else text
    try:
        obj = json.loads(text)
    except Exception:
        return None, text  # non-JSON: post raw
    return obj.get("findings", []), obj.get("summary", "")


SEV_ORDER = ["critical", "high", "medium", "low", "info"]
SEV_ICON = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🔵", "info": "⚪"}


def render(findings, summary):
    lines = ["## 🤖 ERP AI review",
             "",
             f"_Model: `{MODEL}` · rubric: `{RUBRIC_PATH}` · advisory of the classes lint/tests/build can't catch._",
             ""]
    if summary:
        lines += [f"**Summary:** {summary}", ""]
    if not findings:
        lines += ["✅ No tenant-isolation, authz, contract, secret, or architecture issues found in this diff."]
        return "\n".join(lines), False
    by_sev = {s: [] for s in SEV_ORDER}
    for f in findings:
        by_sev.get(f.get("severity", "info").lower(), by_sev["info"]).append(f)
    has_block = False
    for s in SEV_ORDER:
        fs = by_sev[s]
        if not fs:
            continue
        if s in BLOCKING_SEVERITIES:
            has_block = True
        lines.append(f"### {SEV_ICON[s]} {s.capitalize()} ({len(fs)})")
        for f in fs:
            loc = f.get("file", "")
            if f.get("line"):
                loc += f":{f['line']}"
            cat = f.get("category", "")
            lines.append(f"- **{f.get('title','(finding)')}** — `{loc}` _{cat}_")
            if f.get("detail"):
                lines.append(f"  - {f['detail']}")
            if f.get("suggestion"):
                lines.append(f"  - 💡 {f['suggestion']}")
        lines.append("")
    lines.append("<sub>Advisory unless a required 'AI review (blocking)' check is configured. "
                 "Reply to discuss or dismiss individual findings.</sub>")
    return "\n".join(lines), has_block


def main():
    if not API_KEY:
        print("AI_REVIEW_API_KEY not set — skipping AI review (add the secret to enable).")
        return 0
    diff = get_diff()
    truncated = ""
    if len(diff) > MAX_DIFF:
        diff = diff[:MAX_DIFF]
        truncated = "\n\n[diff truncated for length — review the largest hunks manually]"
    rubric = open(RUBRIC_PATH).read() if os.path.exists(RUBRIC_PATH) else ""
    system = (
        "You are a senior staff engineer doing an ERP-grade code review. Review ONLY the "
        "provided unified diff. Concentrate on issues that linters, unit tests and a build "
        "CANNOT catch. Use this rubric:\n\n" + rubric + "\n\n"
        "Return STRICT JSON: {\"summary\": string, \"findings\": [{\"file\": string, "
        "\"line\": number|null, \"severity\": \"critical|high|medium|low|info\", "
        "\"category\": string, \"title\": string, \"detail\": string, \"suggestion\": string}]}. "
        "Only report real, high-confidence issues grounded in the diff — no style nitpicks, "
        "no praise, no speculation. Empty findings is a valid and good result."
    )
    content = parse_findings(call_model(system, "PR unified diff:\n\n" + diff + truncated))
    findings, summary = content
    if findings is None:
        body = "## 🤖 ERP AI review\n\n" + summary
        block = False
    else:
        body, block = render(findings, summary)
    gh("POST", f"/repos/{REPO}/issues/{PR}/comments", {"body": body})
    print(f"Posted AI review ({len(findings or [])} findings). blocking={block and BLOCKING}")
    return 1 if (block and BLOCKING) else 0


if __name__ == "__main__":
    sys.exit(main())
