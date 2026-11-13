// Stamps the signed-in user on every payroll audit row so the audit can say who did what.
// The 21 call sites that write audit rows stay as they are: the actor comes from the request context.
import { mcpCtx } from './requestContext.js';

const actorOf = () => {
  const id = Number(mcpCtx.getStore()?.user?.userId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const stamp = (data) => {
  if (!data || data.actorUserId !== undefined) return data;
  const actorUserId = actorOf();
  return actorUserId == null ? data : { ...data, actorUserId };
};

export const auditActorExtension = (client) =>
  client.$extends({
    name: 'payroll-audit-actor',
    query: {
      payrollAuditLog: {
        create({ args, query }) {
          return query({ ...args, data: stamp(args.data) });
        },
        createMany({ args, query }) {
          const rows = Array.isArray(args.data) ? args.data.map(stamp) : stamp(args.data);
          return query({ ...args, data: rows });
        },
      },
    },
  });
