// Isolated loopback fixture. All tool handlers below are production code.
import http from 'node:http';
import { z } from 'zod';
import { setup, db, people, company, prisma } from '../approval/fixtures.mjs';
import { mcpCtx } from '../../src/mcp/context.js';
import { applyEvaluatedShifts } from '../../src/services/attendanceWriter.service.js';
import { registerAllTools } from '../../src/mcp/toolRegistry.js';
import { startAttendanceExportWorker } from '../../src/jobs/attendance-export.loop.js';
await setup();
const exportWorker=startAttendanceExportWorker({enabled:true,intervalMs:500});
const date = '2026-02-12';
await db(tx => applyEvaluatedShifts({ tenantId: company, employeeIds: [people.EMPLOYEE.id], from: date, to: date, db: tx, dryRun: false }));
const handlers = new Map();
const resources = new Map();
registerAllTools({
  resource(name, uri, ...parts) { if(typeof uri === 'string') resources.set(uri,parts.at(-1)); return {}; },
  tool(name, ...parts) {
    const raw = parts.find(part => part && typeof part === 'object' && Object.values(part).some(v => v?.safeParse));
    const schema = raw ? z.object(raw) : z.object({});
    handlers.set(name, { schema, callback: parts.at(-1) });
    return {};
  },
  registerTool(name, config, callback) { handlers.set(name, { schema: z.object(config.inputSchema || {}), callback }); return {}; },
});
const grants = { EMPLOYEE: ['self'], MANAGER: ['self','manager'], HR: ['self','verify','read'], MANAGEMENT: ['self','approve','read'], OTHER: ['self'], ADMIN: [] };
const roles = { EMPLOYEE:'Employee', MANAGER:'Line Manager', HR:'HR Manager', MANAGEMENT:'Management', OTHER:'Employee', ADMIN:'Admin' };
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type','application/json');
  try {
    const url = new URL(req.url,'http://127.0.0.1:5397');
    if (url.pathname === '/health') { res.end('{"ready":true}'); return; }
    if (url.pathname === '/fixture') { res.end(JSON.stringify({ company, date, employeeId: people.EMPLOYEE.id, employeeCode: people.EMPLOYEE.employee_code, people: Object.fromEntries(Object.entries(people).map(([key,p]) => [key,{ id:p.id,code:p.employee_code }])) })); return; }
    if(req.method==='POST'&&url.pathname==='/fixture/punch') {
      const direction=url.searchParams.get('direction');
      if(!['IN','OUT'].includes(direction))throw new Error('Invalid fixture direction');
      const day='2026-02-16',clock=direction==='IN'?'09:00:01':'17:00:00';
      await db(async tx=>{await tx.attendanceDevicePunch.create({data:{tenantId:company,employeeId:people.EMPLOYEE.id,sn:'TEST-DEVICE',siteId:'HO',deviceUserId:'101',punchedAt:new Date(`${day}T${clock}Z`),status:direction==='IN'?0:1,directionVerified:true}});await applyEvaluatedShifts({tenantId:company,employeeIds:[people.EMPLOYEE.id],from:day,to:day,db:tx,dryRun:false});});
      res.end(JSON.stringify({recorded:true}));return;
    }
    if (req.method !== 'POST' || url.pathname !== '/mcp') { res.statusCode=404; res.end('{}'); return; }
    const role = String(req.headers.authorization || '').replace('Bearer ','');
    if (!people[role]) throw Object.assign(new Error('Choose a fixture actor'),{status:403});
    let body=''; for await (const chunk of req) { body+=chunk; if(body.length>1048576) throw new Error('Request too large'); }
    const rpc = JSON.parse(body), name = rpc.params?.name;
    if (rpc.method?.startsWith('notifications/')) {res.statusCode=202;res.end();return;}
    if (rpc.method === 'initialize') { res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'local-attendance-test',version:'1'}}})); return; }
    const tool = rpc.method === 'resources/read' ? {schema:z.object({}),callback:() => resources.get(rpc.params.uri)?.(new URL(rpc.params.uri))} : handlers.get(name);
    if (!tool) throw new Error('Unknown fixture tool: ' + name);
    const permissions = ['hr.attendance.read', ...grants[role].map(k=>'hr.approvals.'+k)];
    if (['HR','MANAGEMENT'].includes(role)) for (const resource of ['attendance','employee','payroll','holiday','leave']) for (const action of ['read','create','update','delete','export']) permissions.push('hr.'+resource+'.'+action);
    const result = await mcpCtx.run({ actorVerified:true, user:{tenantId:company,userId:people[role].userId,employeeId:people[role].id,roles:[roles[role]]}, permissions }, () => tool.callback(tool.schema.parse(rpc.params.arguments || {})));
    res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  } catch(e) { res.statusCode=e.status || 500; res.end(JSON.stringify({error:{message:e.message}})); }
});
server.listen(5397,'127.0.0.1');
process.on('SIGTERM',()=>server.close(async()=>{await exportWorker.stop();await prisma.$disconnect();process.exit(0);}));
