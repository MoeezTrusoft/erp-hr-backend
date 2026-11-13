import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire('/app/package.json');

test('production native modules load and execute on musl', async () => {
  assert.equal(process.platform,'linux');
  assert.equal(process.arch,'x64');
  const bcrypt=require('bcrypt');
  const hash=await bcrypt.hash('disposable-native-fixture',4);
  assert.equal(await bcrypt.compare('disposable-native-fixture',hash),true);
  assert.equal(await bcrypt.compare('wrong',hash),false);
  const {createCanvas}=require('@napi-rs/canvas');
  const canvas=createCanvas(16,16);const context=canvas.getContext('2d');
  context.fillStyle='#ff0000';context.fillRect(0,0,16,16);
  assert.deepEqual([...context.getImageData(0,0,1,1).data],[255,0,0,255]);
  assert.equal(canvas.toBuffer('image/png').subarray(1,4).toString(),'PNG');
  const {pack,unpack}=require('msgpackr');
  assert.deepEqual(unpack(pack({employee:'fixture',hours:8})),{employee:'fixture',hours:8});
});

test('Prisma performs parameterized SQL, serializable commit and rollback', async t => {
  const {PrismaClient}=require('@prisma/client');
  const {PrismaPg}=require('@prisma/adapter-pg');
  const connectionString=process.env.DEPENDENCY_DATABASE_URL;
  assert.equal(new URL(connectionString).hostname,'127.0.0.1');
  assert.equal(new URL(connectionString).pathname,'/dependency_fixture');
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString})});
  t.after(()=>prisma.$disconnect());
  await prisma.$executeRaw`CREATE TABLE dependency_runtime_fixture (id integer PRIMARY KEY, value text NOT NULL)`;
  await assert.rejects(prisma.$transaction(async tx=>{
    await tx.$executeRaw`INSERT INTO dependency_runtime_fixture VALUES (${1},${'rolled back'})`;
    throw new Error('intentional-rollback');
  },{isolationLevel:'Serializable'}),/intentional-rollback/);
  assert.deepEqual(await prisma.$queryRaw`SELECT id FROM dependency_runtime_fixture`,[]);
  const value="quoted ' fixture; SELECT 1";
  await prisma.$transaction(async tx=>{
    await tx.$executeRaw`INSERT INTO dependency_runtime_fixture VALUES (${2},${value})`;
  },{isolationLevel:'Serializable'});
  assert.deepEqual(await prisma.$queryRaw`SELECT id,value FROM dependency_runtime_fixture`,[{id:2,value}]);
  await prisma.$executeRaw`DROP TABLE dependency_runtime_fixture`;
});

test('deployment CLI and TLS primitives execute as the runtime user',()=>{
  assert.equal(process.getuid(),10001);
  assert.match(execFileSync('bash',['--version'],{encoding:'utf8',timeout:10000}),/GNU bash/);
  assert.match(execFileSync('openssl',['version'],{encoding:'utf8',timeout:10000}),/OpenSSL/);
  assert.match(execFileSync('node',['/app/node_modules/prisma/build/index.js','--version'],{encoding:'utf8',timeout:30000,env:{...process.env,HOME:'/tmp',PRISMA_HIDE_UPDATE_MESSAGE:'1'}}),/prisma\s*:/);
});
