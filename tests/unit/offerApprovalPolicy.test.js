// tests/unit/offerApprovalPolicy.test.js
//
// FR-09 residue — the PURE offer approval policy:
//
//   * no rules ⇒ the pre-policy triple verbatim (an unconfigured tenant must be
//     byte-identical to the previous build)
//   * a compensation WINDOW routes by amount — that is the exception routing
//   * a rule naming another CURRENCY does not apply
//   * an UNKNOWN amount applies every amount-bearing rule (fail-closed: the
//     chain gets longer, never shorter)
//   * validation refuses the shapes that would make "is this approved"
//     ambiguous (duplicate stage, inverted window, empty list)
import { describe, it, expect } from "@jest/globals";
import {
    DEFAULT_OFFER_APPROVAL_RULES,
    OFFER_APPROVAL_STAGES,
    resolveOfferApprovalChain,
    validateOfferApprovalRules,
} from "../../src/lib/offerApprovalPolicy.js";

const stages = (result) => result.steps.map((s) => s.stage);

describe("resolveOfferApprovalChain — default posture", () => {
    it("returns the pre-policy triple when no rules are configured", () => {
        const result = resolveOfferApprovalChain({ rules: undefined, amount: 90_000 });
        expect(result.source).toBe("DEFAULT");
        expect(stages(result)).toEqual(["hiringManager", "hrHead", "finance"]);
    });

    it("returns the default triple for an empty rule list", () => {
        expect(stages(resolveOfferApprovalChain({ rules: [] }))).toEqual(OFFER_APPROVAL_STAGES);
    });

    it("returns a COPY of the defaults (a caller cannot mutate the frozen constant)", () => {
        const first = resolveOfferApprovalChain({ rules: [] });
        first.steps[0].stage = "finance";
        expect(DEFAULT_OFFER_APPROVAL_RULES[0].stage).toBe("hiringManager");
    });
});

describe("resolveOfferApprovalChain — compensation exception routing", () => {
    const RULES = [
        { stepOrder: 1, stage: "hiringManager", role: null, minAmount: null, maxAmount: null, currency: null },
        { stepOrder: 2, stage: "finance", role: null, minAmount: 150_000, maxAmount: null, currency: null },
    ];

    it("omits a minAmount rule for an offer below the threshold", () => {
        const result = resolveOfferApprovalChain({ rules: RULES, amount: 90_000 });
        expect(result.source).toBe("TEMPLATE");
        expect(stages(result)).toEqual(["hiringManager"]);
    });

    it("includes it at exactly the threshold (>= is inclusive)", () => {
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: 150_000 }))).toEqual([
            "hiringManager",
            "finance",
        ]);
    });

    it("includes it above the threshold", () => {
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: 400_000 }))).toEqual([
            "hiringManager",
            "finance",
        ]);
    });

    it("respects a maxAmount ceiling", () => {
        const rules = [
            { stepOrder: 1, stage: "hiringManager", minAmount: null, maxAmount: 50_000, currency: null },
            { stepOrder: 2, stage: "hrHead", minAmount: null, maxAmount: null, currency: null },
        ];
        expect(stages(resolveOfferApprovalChain({ rules, amount: 60_000 }))).toEqual(["hrHead"]);
    });

    it("orders by stepOrder regardless of input order", () => {
        const rules = [
            { stepOrder: 3, stage: "finance", minAmount: null, maxAmount: null, currency: null },
            { stepOrder: 1, stage: "hiringManager", minAmount: null, maxAmount: null, currency: null },
            { stepOrder: 2, stage: "hrHead", minAmount: null, maxAmount: null, currency: null },
        ];
        expect(stages(resolveOfferApprovalChain({ rules, amount: 1 }))).toEqual([
            "hiringManager",
            "hrHead",
            "finance",
        ]);
    });
});

describe("resolveOfferApprovalChain — fail-closed on an unknown amount", () => {
    const RULES = [
        { stepOrder: 1, stage: "hiringManager", minAmount: null, maxAmount: null, currency: null },
        { stepOrder: 2, stage: "finance", minAmount: 150_000, maxAmount: null, currency: null },
    ];

    it.each([
        ["null", null],
        ["undefined", undefined],
        ["empty string", ""],
        ["non-numeric", "not-a-number"],
    ])("keeps the amount-bearing rule when the amount is %s", (_label, amount) => {
        const result = resolveOfferApprovalChain({ rules: RULES, amount });
        expect(stages(result)).toEqual(["hiringManager", "finance"]);
    });

    it("an unknown amount is never treated as zero (which would skip the rule)", () => {
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: null }))).toContain("finance");
    });
});

describe("resolveOfferApprovalChain — currency", () => {
    const RULES = [
        { stepOrder: 1, stage: "hiringManager", minAmount: null, maxAmount: null, currency: null },
        { stepOrder: 2, stage: "finance", minAmount: 150_000, maxAmount: null, currency: "USD" },
    ];

    it("applies a USD threshold to a USD offer", () => {
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: 200_000, currency: "USD" }))).toEqual([
            "hiringManager",
            "finance",
        ]);
    });

    it("skips it for a PKR offer of the same numeric size", () => {
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: 200_000, currency: "PKR" }))).toEqual([
            "hiringManager",
        ]);
    });

    it("matches the currency case-insensitively", () => {
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: 200_000, currency: "usd" }))).toEqual([
            "hiringManager",
            "finance",
        ]);
    });

    it("applies a currency-scoped rule when the offer names no currency", () => {
        // Otherwise a currency-less offer would silently drop its Finance step.
        expect(stages(resolveOfferApprovalChain({ rules: RULES, amount: 200_000, currency: null }))).toEqual([
            "hiringManager",
            "finance",
        ]);
    });
});

describe("resolveOfferApprovalChain — never resolves to no approver", () => {
    it("falls back to the default triple when a policy filters every rule away", () => {
        const rules = [
            { stepOrder: 1, stage: "finance", minAmount: 10_000_000, maxAmount: null, currency: null },
        ];
        const result = resolveOfferApprovalChain({ rules, amount: 1_000 });
        expect(result.source).toBe("DEFAULT");
        expect(stages(result)).toEqual(["hiringManager", "hrHead", "finance"]);
    });
});

describe("validateOfferApprovalRules", () => {
    const valid = [
        { stepOrder: 1, stage: "hiringManager", minAmount: null, maxAmount: null, currency: null },
        { stepOrder: 2, stage: "finance", minAmount: 150_000, maxAmount: null, currency: "USD" },
    ];

    it("accepts a well-formed policy and normalizes currency to upper case", () => {
        const result = validateOfferApprovalRules([{ ...valid[1], currency: "usd" }]);
        expect(result.ok).toBe(true);
        expect(result.rules[0].currency).toBe("USD");
    });

    it("sorts the returned rules by stepOrder", () => {
        const result = validateOfferApprovalRules([valid[1], valid[0]]);
        expect(result.rules.map((r) => r.stage)).toEqual(["hiringManager", "finance"]);
    });

    it("refuses an empty list (\"no rules\" must stay distinguishable from \"unconfigured\")", () => {
        expect(validateOfferApprovalRules([]).ok).toBe(false);
        expect(validateOfferApprovalRules(null).ok).toBe(false);
    });

    it("refuses a stage outside the closed vocabulary", () => {
        const result = validateOfferApprovalRules([{ stepOrder: 1, stage: "ceo" }]);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/stage/);
    });

    it("refuses the same stage twice (two windows would make the chain order-dependent)", () => {
        const result = validateOfferApprovalRules([
            { stepOrder: 1, stage: "finance", minAmount: null, maxAmount: 100 },
            { stepOrder: 2, stage: "finance", minAmount: 100, maxAmount: null },
        ]);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already covered/);
    });

    it("refuses a non-positive stepOrder", () => {
        expect(validateOfferApprovalRules([{ stepOrder: 0, stage: "finance" }]).ok).toBe(false);
        expect(validateOfferApprovalRules([{ stepOrder: 1.5, stage: "finance" }]).ok).toBe(false);
    });

    it("refuses an inverted window", () => {
        const result = validateOfferApprovalRules([
            { stepOrder: 1, stage: "finance", minAmount: 200, maxAmount: 100 },
        ]);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/must not exceed/);
    });

    it("refuses a negative amount", () => {
        expect(validateOfferApprovalRules([{ stepOrder: 1, stage: "finance", minAmount: -1 }]).ok).toBe(false);
    });

    it("allows an open-ended window on either side", () => {
        expect(validateOfferApprovalRules([{ stepOrder: 1, stage: "finance", minAmount: 100 }]).ok).toBe(true);
        expect(validateOfferApprovalRules([{ stepOrder: 1, stage: "finance", maxAmount: 100 }]).ok).toBe(true);
    });
});
