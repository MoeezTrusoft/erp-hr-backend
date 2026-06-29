import { describe, expect, it } from "@jest/globals";
import {
  createEmployeeContractSchema,
  createEmployeeDocumentSchema,
  emergencyContactSchema,
  updateEmployeeContractSchema,
} from "../../src/validators/hrEmployeeContract.schema.js";

describe("HR employee contract validation", () => {
  // hr_employee_create defect — the advertised MCP inputSchema requires only
  // firstName + lastName, and the DB columns job_title / positionId /
  // employement_status / hire_date are all nullable. The service contract must
  // agree: a minimal {firstName, lastName} create has to pass validation.
  it("accepts a minimal {firstName, lastName} employee create payload", () => {
    const result = createEmployeeContractSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(result.success).toBe(true);
    expect(result.data.firstName).toBe("Ada");
    expect(result.data.lastName).toBe("Lovelace");
    // optional/nullable fields must not be forced to a value
    expect(result.data.jobTitle).toBeUndefined();
    expect(result.data.positionId).toBeUndefined();
    expect(result.data.employmentStatus).toBeUndefined();
    expect(result.data.hireDate).toBeUndefined();
  });

  it("accepts explicit null for the nullable employee create fields", () => {
    const result = createEmployeeContractSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: null,
      positionId: null,
      employmentStatus: null,
      hireDate: null,
    });

    expect(result.success).toBe(true);
  });

  it("still rejects a create missing the DB-required firstName / lastName", () => {
    expect(createEmployeeContractSchema.safeParse({ lastName: "Lovelace" }).success).toBe(false);
    expect(createEmployeeContractSchema.safeParse({ firstName: "Ada" }).success).toBe(false);
    expect(createEmployeeContractSchema.safeParse({}).success).toBe(false);
  });

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
