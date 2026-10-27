/** AES-256-GCM archive envelope. Keys are separate protected DAM assets. */
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
const MAGIC=Buffer.from('HRLSBK01');
const [action,input,output,keyPath]=process.argv.slice(2);
if(!['encrypt','decrypt'].includes(action)||!input||!output||!keyPath)throw new Error('Usage: encrypt|decrypt input output key-file');
const key=await fs.readFile(keyPath);if(key.length!==32)throw new Error('Expected 256-bit key');
const temp=output+'.partial';
try{
 if(action==='encrypt'){
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
  const file=await fs.open(temp,'wx',0o600);await file.write(Buffer.concat([MAGIC,iv]));await file.close();
  await pipeline(createReadStream(input),cipher,createWriteStream(temp,{flags:'a',mode:0o600}));
  await fs.appendFile(temp,cipher.getAuthTag());
 }else{
  const file=await fs.open(input,'r');const {size}=await file.stat();if(size<36)throw new Error('Invalid envelope');
  const header=Buffer.alloc(20),tag=Buffer.alloc(16);await file.read(header,0,20,0);await file.read(tag,0,16,size-16);await file.close();
  if(!header.subarray(0,8).equals(MAGIC))throw new Error('Unsupported envelope');
  const cipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));cipher.setAAD(MAGIC);cipher.setAuthTag(tag);
  await pipeline(createReadStream(input,{start:20,end:size-17}),cipher,createWriteStream(temp,{flags:'wx',mode:0o600}));
 }
 // link is atomic and refuses to replace existing recovery evidence.
 await fs.link(temp,output);await fs.unlink(temp);
} catch(error){await fs.unlink(temp).catch(()=>{});throw error;}finally{key.fill(0);}
