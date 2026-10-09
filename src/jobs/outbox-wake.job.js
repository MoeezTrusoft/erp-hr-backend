import { Client } from 'pg';
import logger from '../lib/logger.js';

// LISTEN is only a wake signal. Durable rows and the existing claim lease are
// authoritative; recovery scans cover reconnects and process crashes.
export function startOutboxWake(wake){
    let client,connecting=false,stopped=false;
    async function connect(){
        if(client||connecting||stopped)return;connecting=true;
        const next=new Client({connectionString:process.env.DIRECT_DATABASE_URL||process.env.DATABASE_URL,connectionTimeoutMillis:10000});
        next.on('error',()=>{if(client===next)client=null;next.end().catch(()=>{});});
        next.on('end',()=>{if(client===next)client=null;});
        try{await next.connect();await next.query('LISTEN hr_outbox');next.on('notification',wake);client=next;wake();}
        catch{await next.end().catch(()=>{});logger.warn('Immediate outbox wake unavailable; recovery scan active');}
        finally{connecting=false;}
    }
    const timer=setInterval(connect,5000);timer.unref();connect();
    return ()=>{stopped=true;clearInterval(timer);return client?.end();};
}
