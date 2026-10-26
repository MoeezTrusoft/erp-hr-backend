import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (in the
// create payload, or a trailing read/update/delete param); folded into cycle /
// template reads + stamped on creates, fail-closed so tenant B never reads or
// mutates tenant A's performance cycles.

export const createPerformanceCycle = async (data, createdBy) => {
  const { name, start_date, end_date , status,templateId, tenantId } = data;

  if (!name || !start_date || !end_date || !templateId ) throw new Error("Missing required fields");
  if(status&&status!=='DRAFT')throw Object.assign(new Error('New cycles must begin as drafts'),{status:422});
  if(!Number.isFinite(+new Date(start_date))||!Number.isFinite(+new Date(end_date))||new Date(start_date)>new Date(end_date))throw Object.assign(new Error('Valid ordered cycle dates are required'),{status:422});

  const template = await prisma.performanceTemplate.findFirst({
    where: scopedWhere(tenantId, { id: templateId }),
  });

  if (!template) {
    throw new Error(`Template with id ${templateId} does not exist`);
  }

  const create = await prisma.performanceCycle.create({
    data: scopedData(tenantId, {
         name,
         description:data.description,
         start_date: new Date(start_date),
          end_date : new Date(end_date ),
          status,

          template: {
        connect: { id: templateId },
      },
        }),
  });
    await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance Cycle "${create.id}" Created successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return create;
};

export const getAllPerformanceCycles = async (tenantId) => {
  return prisma.performanceCycle.findMany({
    where: scopedWhere(tenantId, {}),
    include: { template: true, reviews: true },
    orderBy: { id: "desc" },
  });
};

export const getPerformanceCycleById = async (id, tenantId) => {
  const cycle = await prisma.performanceCycle.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { template: true, reviews: true },
  });
  if (!cycle) throw new Error("Performance Cycle not found");
  return cycle;
};

export const updatePerformanceCycle = async (id, data,updatedBy, tenantId) => {
    const existing  = await prisma.performanceCycle.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) })
    if (!existing) throw new Error("Performnce cycle not found");
  if(Object.keys(data).some(k=>!["name","description","start_date","end_date","templateId"].includes(k)))throw Object.assign(new Error('Unsupported cycle field'),{status:422});
  if(await prisma.performanceReview.count({where:scopedWhere(tenantId,{cycleId:Number(id)})}))throw Object.assign(new Error('A launched legacy cycle cannot be edited'),{status:409});
  if(data.templateId&&!await prisma.performanceTemplate.findFirst({where:scopedWhere(tenantId,{id:Number(data.templateId)})}))throw Object.assign(new Error('Template not found'),{status:404});
  const start=new Date(data.start_date||existing.start_date),end=new Date(data.end_date||existing.end_date);
  if(!Number.isFinite(+start)||!Number.isFinite(+end)||start>end)throw Object.assign(new Error('Valid ordered cycle dates are required'),{status:422});
  data={...data,...(data.start_date?{start_date:start}:{}),...(data.end_date?{end_date:end}:{})};
  const update= await prisma.performanceCycle.update({
    where: { id: Number(id) },
    data: Object.fromEntries(Object.entries(data).filter(([key]) => ["name", "description", "start_date", "end_date", "templateId"].includes(key))),

  });
    await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance Cycle "${id}" Updated successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return update;
};

export const deletePerformanceCycle = async (id, deletedBy, tenantId) => {
    const existing  = await prisma.performanceCycle.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) })
    if (!existing) throw new Error("Performnce cycle not found");
    
  const deleted = await prisma.performanceCycle.delete({
    where: { id: Number(id) },
  });

 await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance Cycle "${id}" Deleted successfully`,
    tenantId: typeof tenantId !== "undefined" ? tenantId : null,
  });

  return deleted;

};
