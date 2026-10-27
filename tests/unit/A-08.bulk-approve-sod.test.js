import { jest, describe, it, expect, beforeAll } from '@jest/globals';

const payslipRows = [
  { id: 11, payrollRunId: 3, status: 'APPROVED' },
  { id: 12, payrollRunId: 3, status: 'APPROVED' },
  { id: 13, payrollRunId: 4, status: 'APPROVED' },
];
const runRows = [
  { id: 3, processedBy: 501, status: 'APPROVED', approvedBy: 777 }, // processed by the offending actor
  { id: 4, processedBy: null, status: 'APPROVED', approvedBy: 777 }, // legacy: no processor recorded
];
const updates = [];
const audits = [];
const approvals = new Map();

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    payrollPayslip: {
      findMany: jest.fn(async ({ where }) => payslipRows.filter((p) => where.id.in.includes(p.id))),
      updateMany: jest.fn(async ({ where, data }) => { updates.push(data); return { count: where.id.in.length }; }),
    },
    payrollAuditLog:{create:jest.fn(async ({data})=>audits.push(data))},
    hrApprovalRequest:{findUnique:jest.fn(async ({where})=>approvals.get(where.tenantId_kind_sourceRef.sourceRef) ?? null)},
    payrollRun: {
      findFirst: jest.fn(async ({where})=>runRows.find(r=>r.id===where.id)),
      findMany: jest.fn(async ({ where }) => runRows.filter((r) => where.id.in.includes(r.id))),
    },
  },
}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: async (prisma, fn) => fn(prisma),
}));

let bulkPayslipAction;
beforeAll(async () => {
  ({ bulkPayslipAction } = await import('../../src/services/payrollDashboard.service.js'));
});

describe('[A-08] staged payroll approval and distribution controls', () => {
  it.each([501,777])('blocks direct approval for actor %s, including independent reviewers',async actorId=>{
    updates.length=0;
    await expect(bulkPayslipAction({tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',payslipIds:[11,12,13],action:'approve',actorId})).rejects.toThrow('HR Approval Centre');
    expect(updates).toHaveLength(0);
  });
  it('does not let a legacy run bypass staged approval',async()=>{
    await expect(bulkPayslipAction({tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',payslipIds:[13],action:'approve',actorId:501})).rejects.toMatchObject({status:409});
  });
  it('blocks holds on reviewed payslips and distribution before finalization',async()=>{
    for(const action of ['hold','disburse']) await expect(bulkPayslipAction({tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',payslipIds:[11],action,reason:'dispute',actorId:501})).rejects.toMatchObject({status:409});
  });
  it('holds draft payslips with an audited reason and distributes finalized payslips without marking them paid',async()=>{
    payslipRows[0].status='DRAFT';runRows[0].status='COMPLETED';updates.length=0;
    await expect(bulkPayslipAction({tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',payslipIds:[11],action:'hold',reason:'',actorId:501})).rejects.toMatchObject({status:400});
    await bulkPayslipAction({tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',payslipIds:[11],action:'hold',reason:'Evidence discrepancy',actorId:501});
    expect(updates[0]).toEqual({status:'HOLD',holdReason:'Evidence discrepancy'});
    payslipRows[0].status='FINALIZED';runRows[0].status='FINALIZED';
    await bulkPayslipAction({tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',payslipIds:[11],action:'disburse',actorId:501});
    expect(updates[1].status).toBe('DISTRIBUTED');expect(updates[1].paidAt).toBeUndefined();
  });
  describe('[D-06] holds cannot strand a submitted or approved run', () => {
    const T='40314ef4-0a81-4390-b631-b3ad3f21f523';
    const reset=(runStatus,stage,slipStatus)=>{
      runRows[0].status=runStatus;payslipRows[0].status=slipStatus;approvals.clear();
      if(stage)approvals.set('3',{stage});updates.length=0;audits.length=0;
    };
    it.each([
      ['COMPLETED','LINE_MANAGER'],['COMPLETED','HR'],['COMPLETED','MANAGEMENT'],['APPROVED','APPROVED'],['FINALIZED','APPROVED'],['PROCESSING',null],
    ])('refuses a hold on a %s run at stage %s',async(runStatus,stage)=>{
      reset(runStatus,stage,'DRAFT');
      await expect(bulkPayslipAction({tenantId:T,payslipIds:[11],action:'hold',reason:'Evidence discrepancy',actorId:501})).rejects.toMatchObject({status:409});
      expect(updates).toHaveLength(0);
    });
    it.each([[null],['INITIATOR'],['REJECTED']])('allows a hold while the run is with its initiator (stage %s)',async(stage)=>{
      reset(stage==='REJECTED'?'REJECTED':'COMPLETED',stage,'DRAFT');
      await bulkPayslipAction({tenantId:T,payslipIds:[11],action:'hold',reason:'Evidence discrepancy',actorId:501});
      expect(updates[0]).toEqual({status:'HOLD',holdReason:'Evidence discrepancy'});
    });
    it('releases a hold on an approved run with an audited reason so finalization can proceed',async()=>{
      reset('APPROVED','APPROVED','HOLD');
      await expect(bulkPayslipAction({tenantId:T,payslipIds:[11],action:'release',reason:' ',actorId:501})).rejects.toMatchObject({status:400});
      await bulkPayslipAction({tenantId:T,payslipIds:[11],action:'release',reason:'Discrepancy resolved',actorId:501});
      expect(updates[0]).toEqual({status:'DRAFT',holdReason:null});
      expect(audits[0]).toMatchObject({action:'PAYSLIP_HOLD_RELEASED',details:'Discrepancy resolved',payslipId:11});
    });
    it('refuses release of a slip that is not held or of a finalized run',async()=>{
      reset('APPROVED','APPROVED','DRAFT');
      await expect(bulkPayslipAction({tenantId:T,payslipIds:[11],action:'release',reason:'x',actorId:501})).rejects.toMatchObject({status:409});
      reset('FINALIZED','APPROVED','HOLD');
      await expect(bulkPayslipAction({tenantId:T,payslipIds:[11],action:'release',reason:'x',actorId:501})).rejects.toMatchObject({status:409});
      expect(updates).toHaveLength(0);
    });
  });
});
