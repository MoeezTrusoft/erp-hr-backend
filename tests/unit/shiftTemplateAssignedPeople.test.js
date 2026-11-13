import { describe, it, expect, jest } from "@jest/globals";
import { assignedPeopleByTemplate } from "../../src/services/shiftTemplateSwap.service.js";

describe("assignedPeopleByTemplate", () => {
  it("counts distinct employees per template, not assignment rows", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { templateId: 1, employeeId: 10 },
      { templateId: 1, employeeId: 11 },
      { templateId: 2, employeeId: 10 },
    ]);
    const counts = await assignedPeopleByTemplate({ shiftAssignment: { findMany } }, "t1", [1, 2, 3]);
    expect(findMany.mock.calls[0][0].distinct).toEqual(["templateId", "employeeId"]);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
    expect(counts.get(3)).toBeUndefined();
  });

  it("does not query when there are no templates", async () => {
    const findMany = jest.fn();
    const counts = await assignedPeopleByTemplate({ shiftAssignment: { findMany } }, "t1", []);
    expect(findMany).not.toHaveBeenCalled();
    expect(counts.size).toBe(0);
  });
});
