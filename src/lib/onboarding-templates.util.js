// src/lib/onboarding-templates.util.js — FR-13 residue — the PURE template rules.
//
// A tenant-authored onboarding checklist template is a list of task DEFINITIONS
// `{ title, description?, stage, category, assigneeType, dueInDays }`. No DB and
// no I/O here: the service stores templates, the handoff materializes them, and
// THIS module owns what a valid template is — so the write path, the MCP tool
// and any future frontend cannot disagree about it.
//
// Validation is deliberately strict-but-not-inventive:
//   * `title` is required and trimmed; a blank task is not a task
//   * `stage` / `assigneeType` must be in the closed vocabularies the onboarding
//     screen and the task table already use — an unknown value would render as
//     an unlabelled column, so it is refused instead of stored
//   * `category` must be one of the categories the onboarding module defines
//     (imported from the same constant the task table validates against, when
//     available; otherwise the value is accepted as a non-empty string)
//   * `dueInDays` is an integer offset from the hire date; negative = before day
//     one. A non-integer is refused rather than coerced (a silently-floored
//     offset is how a "day one" task lands on the wrong day)
//   * an EMPTY task list is refused: "use the default" is expressed by NOT
//     configuring a template, not by storing an empty one
import { DEFAULT_ONBOARDING_TASKS, ONBOARDING_TASK_ASSIGNEES, ONBOARDING_TASK_STAGES } from "./onboarding-defaults.util.js";

const MAX_TASKS = 100;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

/**
 * Validate a template's task list.
 *
 * @returns {{ ok: true, tasks: object[] } | { ok: false, error: string }}
 */
export function validateTemplateTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return { ok: false, error: "A template needs at least one task" };
    }
    if (tasks.length > MAX_TASKS) {
        return { ok: false, error: `A template allows at most ${MAX_TASKS} tasks` };
    }

    const out = [];
    for (const [i, raw] of tasks.entries()) {
        const where = `Task ${i + 1}`;
        const title = typeof raw?.title === "string" ? raw.title.trim() : "";
        if (!title) return { ok: false, error: `${where}: title is required` };
        if (title.length > MAX_TITLE) return { ok: false, error: `${where}: title is too long` };

        const description = typeof raw?.description === "string" && raw.description.trim() ? raw.description.trim() : null;
        if (description && description.length > MAX_DESCRIPTION) {
            return { ok: false, error: `${where}: description is too long` };
        }

        const stage = typeof raw?.stage === "string" ? raw.stage.trim() : "";
        if (!ONBOARDING_TASK_STAGES.includes(stage)) {
            return { ok: false, error: `${where}: stage must be one of ${ONBOARDING_TASK_STAGES.join(", ")}` };
        }

        const assigneeType = typeof raw?.assigneeType === "string" ? raw.assigneeType.trim() : "";
        if (!ONBOARDING_TASK_ASSIGNEES.includes(assigneeType)) {
            return { ok: false, error: `${where}: assigneeType must be one of ${ONBOARDING_TASK_ASSIGNEES.join(", ")}` };
        }

        const category = typeof raw?.category === "string" ? raw.category.trim() : "";
        if (!category) return { ok: false, error: `${where}: category is required` };

        const dueInDays = Number(raw?.dueInDays);
        if (!Number.isInteger(dueInDays)) {
            return { ok: false, error: `${where}: dueInDays must be an integer (negative = before the hire date)` };
        }

        out.push({ title, description, stage, category, assigneeType, dueInDays });
    }
    return { ok: true, tasks: out };
}

/**
 * Resolve which task definitions a provisioned hire should be seeded with.
 *
 * TENANT-FIRST, BASELINE-FALLBACK: an active default template's validated tasks
 * win; anything else (no template, an inactive one, a malformed stored list)
 * falls back to the documented baseline. Falling back rather than throwing is
 * deliberate — a hire must never fail to be provisioned because an operator
 * deactivated the template, and the baseline is a working checklist.
 *
 * @param {object|null} template the tenant's active default template row (or null)
 * @returns {{ tasks: object[], source: 'TEMPLATE'|'DEFAULT', templateId: number|null }}
 */
export function resolveChecklistTasks(template) {
    if (!template) return { tasks: DEFAULT_ONBOARDING_TASKS, source: "DEFAULT", templateId: null };
    const verdict = validateTemplateTasks(template.tasks);
    if (!verdict.ok) {
        // Stored-but-invalid: the write path validates, so this means the row
        // predates a rule change. Baseline beats a broken checklist.
        return { tasks: DEFAULT_ONBOARDING_TASKS, source: "DEFAULT", templateId: null };
    }
    return { tasks: verdict.tasks, source: "TEMPLATE", templateId: template.id ?? null };
}
