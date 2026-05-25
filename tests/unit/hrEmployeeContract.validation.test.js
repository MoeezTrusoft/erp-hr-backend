import { describe, expect, it } from "@jest/globals";
import {
  createEmployeeContractSchema,
  createEmployeeDocumentSchema,
  emergencyContactSchema,
  updateEmployeeContractSchema,
} from "../../src/validators/hrEmployeeContract.schema.js";

describe("HR employee contract validation", () => {
  it("accepts the minimum frontend employee create payload", () => {
    const result = createEmployeeContractSchema.safeParse({
      firstName: "Ayesha",
      lastName: "Khan",
      jobTitle: "Frontend Developer",
      hireDate: "2026-01-15",
      employmentStatus: "Active",
      positionId: 1,
      mobilePhone: "+92 300 1234567",
    });

    expect(result.success).toBe(true);
    expect(result.data.mobilePhone).toBe("+92 300 1234567");
  });

  it("rejects duplicate primary emergency contacts", () => {
    const result = createEmployeeContractSchema.safeParse({
      firstName: "Ayesha",
      lastName: "Khan",
      jobTitle: "Frontend Developer",
      hireDate: "2026-01-15",
      employmentStatus: "Active",
      positionId: 1,
      emergencyContacts: [
        { contactName: "One", phone: "+92 300 1111111", isPrimary: true },
        { contactName: "Two", phone: "+92 300 2222222", isPrimary: true },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("allows partial employee updates", () => {
    const result = updateEmployeeContractSchema.safeParse({
      workEmail: "employee@trusoft.com",
      managerId: 2,
    });

    expect(result.success).toBe(true);
  });

  it("validates document and emergency contact payloads", () => {
    expect(
      createEmployeeDocumentSchema.safeParse({
        title: "CNIC",
        mediaId: 10,
        visibility: "hr_only",
      }).success
    ).toBe(true);

    expect(
      emergencyContactSchema.safeParse({
        contactName: "Sara Malik",
        phone: "+92 300 5555555",
        email: "sara@example.com",
        isPrimary: true,
      }).success
    ).toBe(true);
  });
});
