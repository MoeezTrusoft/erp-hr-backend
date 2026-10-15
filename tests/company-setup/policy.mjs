import { SeparationType } from "@trusoft/contracts/employment";
export function samplePolicy(hr, manager) {
  return {
    policy: {
      timeZone: "Asia/Karachi",
      typeRules: SeparationType.options.map((type) => ({
        type,
        initiators: type === "RESIGNATION" ? ["SELF", "HR"] : ["HR"],
        requiredDocumentKinds: [],
        noticeTreatment: "CONTRACT_OR_GRADE",
        allowPostApprovalWithdrawal: false,
      })),
      noticeByGrade: ["EMPLOYEE", "MANAGEMENT"].map((category) => ({
        category,
        gradeCode: "G1",
        days: 30,
      })),
      authority: ["EMPLOYEE", "MANAGEMENT"].map((category) => ({
        category,
        gradeCode: "G1",
        approverCodes: [manager],
      })),
      clearanceDepartments: [
        { departmentCode: "HR", ownerCode: hr, signerCodes: [hr] },
      ],
      hrCodes: [hr],
      itOwnerCode: hr,
      payrollOwnerCode: hr,
      templates: ["ACCEPTANCE", "TERMINATION", "CLEARANCE", "EXPERIENCE"].map(
        (kind) => ({
          kind,
          approvedRef: "fixture:template",
          body: "Fictional controlled letter for {{employeeCode}}. Only an isolated test.",
        }),
      ),
      settlement: {
        currency: "PKR",
        minorUnits: 2,
        leaveEncashment: false,
        noticeRecovery: false,
        noticePay: false,
      },
      reminderDays: 5,
    },
    jurisdictionRef: "fixture:reviewed-jurisdiction",
    employerInitiationRef: "fixture:reviewed-controls",
    retentionRef: "fixture:records-retention",
    integrationEvidenceRef: "fixture:integration-results",
  };
}
