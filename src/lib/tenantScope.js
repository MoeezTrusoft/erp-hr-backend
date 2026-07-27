// src/lib/tenantScope.js — deny-by-default tenant scoping for the HR service.
//
// A companion to rlsTenant.js (DB-level RLS on 3 pilot tables). This extension
// makes tenant scoping STRUCTURAL at the ORM layer for EVERY tenant-owned model:
// per query it either auto-scopes to the request's verified tenant or, when no
// context has been established, throws HR-4030 so an unscoped path fails loudly
// instead of leaking across tenants.
//
// Tenant provenance is the SAME async-local context the MCP facade and the REST
// context middleware set (mcpCtx: { user: { tenantId } }). The tenant column is
// `tenantId` on the C.2 tables and `tenant_id` on Employee (REQ-007) — resolved
// per model from the schema (DMMF). Interactive contexts require a UUID tenant;
// nullable rows remain available only to explicit migration/backfill SYSTEM
// contexts via mcpCtx.run({ system:true }).
import { Prisma } from '@prisma/client';
import { NIL as NIL_UUID, validate as isUuid } from 'uuid';
import { mcpCtx } from '../mcp/context.js';

// model -> tenant column ('tenantId' | 'tenant_id'), derived from the schema.
const TENANT_COLUMN = new Map();
for (const m of Prisma.dmmf.datamodel.models) {
    const f = m.fields.find((x) => x.name === 'tenantId' || x.name === 'tenant_id');
    if (f) TENANT_COLUMN.set(m.name, f.name);
}

const WHERE_OPS = new Set([
    'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
    'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany',
    'update', 'delete', 'updateManyAndReturn',
]);
const CREATE_MANY_OPS = new Set(['createMany', 'createManyAndReturn']);

export const tenantScopeExtension = (client) =>
    client.$extends({
        name: 'tenant-scope-deny-default',
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    const col = TENANT_COLUMN.get(model);
                    if (!col) return query(args);

                    const store = mcpCtx.getStore();
                    if (store?.system) return query(args);
                    if (!store) {
                        throw new Error(
                            `HR-4030: ${model}.${operation} ran without a tenant context (deny-by-default). ` +
                            `Wrap the caller in the REST/MCP context or mcpCtx.run({ system: true }).`,
                        );
                    }

                    const rawTenant = store.user?.tenantId;
                    const tenantId = typeof rawTenant === 'string' ? rawTenant.trim() : '';
                    if (!isUuid(tenantId) || tenantId === NIL_UUID) {
                        throw new Error(
                            `HR-4031: ${model}.${operation} requires a valid interactive tenant UUID. ` +
                            `Use mcpCtx.run({ system: true }) only for explicit jobs or migration/backfill work.`,
                        );
                    }
                    const a = args ? { ...args } : {};
                    if (WHERE_OPS.has(operation)) {
                        a.where = { ...(a.where ?? {}), [col]: tenantId };
                    } else if (operation === 'create') {
                        a.data = { ...(a.data ?? {}), [col]: tenantId };
                    } else if (CREATE_MANY_OPS.has(operation)) {
                        const rows = Array.isArray(a.data) ? a.data : [a.data];
                        a.data = rows.map((r) => ({ ...r, [col]: tenantId }));
                    } else if (operation === 'upsert') {
                        a.where = { ...(a.where ?? {}), [col]: tenantId };
                        a.create = { ...(a.create ?? {}), [col]: tenantId };
                    }
                    return query(a);
                },
            },
        },
    });
