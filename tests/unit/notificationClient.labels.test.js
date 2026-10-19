// tests/unit/notificationClient.labels.test.js
//
// D-14 — portal candidate emails were all counted as "other": the label was
// derived from the last dot segment of the template id, which never matched.
// Each template now maps to an allowlisted label, counted once by the transport.
import { describe, it, expect } from "@jest/globals";
import { templateEventLabel } from "../../src/lib/notificationClient.js";

describe("candidate email metric labels", () => {
  it.each([
    ["hr.recruitment.portal_email_verification", "email_verification"],
    ["hr.recruitment.portal_status_link", "status_link"],
    ["hr.recruitment.portal_application_confirmed", "application_confirmation"],
    ["hr.recruitment.portal_application_confirmed_existing", "application_confirmation"],
    ["hr.recruitment.portal_mailbox_notice", "mailbox_notice"],
    ["hr.recruitment.portal_draft_link", "draft_link"],
  ])("labels %s as %s", (templateId, label) => {
    expect(templateEventLabel(templateId)).toBe(label);
  });

  it("labels an unknown template as other", () => {
    expect(templateEventLabel("hr.recruitment.something_new")).toBe("other");
    expect(templateEventLabel(undefined)).toBe("other");
  });
});
