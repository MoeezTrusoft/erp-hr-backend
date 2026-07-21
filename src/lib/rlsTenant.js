// src/lib/rlsTenant.js — FORCE ROW LEVEL SECURITY tenant-context extension.
//
// The c2_rls_pilot migration puts FORCE RLS on Attendance / LeaveRequest /
// PerformanceReview with the policy
//     USING/CHECK (tenantId = public.hr_current_tenant())
// where hr_current_tenant() = current_setting('app.tenant_id', true)::uuid.
//
// So every read/write of those tables must run with the right GUC set:
//   • TENANT context  → app.tenant_id = the VERIFIED request tenant (RBAC Company
//     uuid on user.tenantId, never a spoofable header).
//   • SYSTEM context   → app.tenant_bypass = 'on', so trusted cross-tenant jobs
//     (mcpCtx.run({ system: true }) — reminder sweep, dispatchers) can scan every
//     tenant's rows. WITHOUT this, a SYSTEM job sets no GUC and FORCE-RLS hides
//     EVERY row (the review-reminder job was silently blind). The policy carries
//     the matching `OR app.tenant_bypass='on'` clause (hr_rls_bypass_guc migration).
// We wrap each such operation in a transaction that sets the GUC transaction-
// locally via set_config(..., true) and runs the operation in the SAME
// transaction (a batch $transaction shares one connection). Non-RLS models and
// no-context queries are passed straight through (the tenantScope extension
// denies genuinely context-less callers before they reach here).
import { mcpCtx } from '../mcp/context.js';

const RLS_MODELS = new Set(['Attendance', 'LeaveRequest', 'PerformanceReview']);
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rlsTenantExtension = (client) =>
    client.$extends({
        name: 'rls-tenant-guc',
        query: {
            $allModels: {
                async $allOperations({ model, args, query }) {
                    if (!RLS_MODELS.has(model)) return query(args);
                    const store = mcpCtx.getStore();

                    // SYSTEM context: set the bypass GUC so cross-tenant jobs can
                    // read/write pilot tables under FORCE RLS.
                    if (store?.system) {
                        const [, result] = await client.$transaction([
                            client.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true)`,
                            query(args),
                        ]);
                        return result;
                    }

                    const tenantId = store?.user?.tenantId;
                    if (!tenantId || !UUID_RE.test(String(tenantId))) {
                        return query(args);
                    }
                    const [, result] = await client.$transaction([
                        client.$executeRaw`SELECT set_config('app.tenant_id', ${String(
                            tenantId,
                        )}, true)`,
                        query(args),
                    ]);
                    return result;
                },
            },
        },
    });
