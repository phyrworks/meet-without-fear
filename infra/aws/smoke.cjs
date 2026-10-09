// Run locally with MWF_TEST_TOKEN_FILE and NODE_PATH pointing to installed dependencies.
// Creates an unshared test session. No invitation is sent and no other user is added.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const Ably = require('ably');
const WebSocket = require('ws');
const base = process.env.MWF_TEST_BASE || 'http://127.0.0.1:18080';
const token = fs.readFileSync(process.env.MWF_TEST_TOKEN_FILE, 'utf8').trim();
const headers = {Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
async function api(path, body) {
  const r=await fetch(base+'/api'+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  const data=await r.json();assert.ok(r.ok,`${path}: HTTP ${r.status} ${JSON.stringify(data)}`);return data.data;
}
(async()=>{
  const noauth=await fetch(base+'/api/auth/me');assert.equal(noauth.status,401);
  const bypass=await fetch(base+'/api/auth/me',{headers:{'x-e2e-user-id':'fake','x-e2e-user-email':'fake@example.invalid'}});assert.equal(bypass.status,401);
  const me=await api('/auth/me');
  const sessions=await api('/sessions');
  console.log(JSON.stringify({auth:'passed',existingSessionsReadable:!!sessions}));
  const created=await api('/sessions',{inviteName:'AWS Migration Verification (unshared)',forceCreate:true});
  const id=created.session.id;
  const auth=await api('/auth/ably-token');
  const realtime=new Ably.Realtime({token:auth.token.token,autoConnect:true});
  const events=[];
  const channel=realtime.channels.get(`meetwithoutfear:session:${id}`);
  await channel.subscribe(m=>events.push(m.name));
  const content='This is a technical migration test with no real partner. I feel a little nervous about changing a familiar routine and would like to reflect on it.';
  const start=Date.now();let firstChunk=null;let body='';let chunks=0;
  const r=await fetch(base+`/api/sessions/${id}/messages/stream`,{method:'POST',headers,body:JSON.stringify({content}),signal:AbortSignal.timeout(120000)});
  assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/event-stream/);
  for await (const chunk of r.body){firstChunk??=Date.now()-start;chunks++;body+=Buffer.from(chunk).toString();}
  const elapsed=Date.now()-start;
  const types=[...body.matchAll(/^event:\s*(.+)$/gm)].map(m=>m[1]);
  assert.ok(chunks>1,'SSE should arrive incrementally');
  assert.ok(firstChunk<elapsed,'First event should precede completion');
  assert.ok(!types.includes('error'), 'SSE error event');
  const history=await api(`/sessions/${id}/messages`);
  assert.ok(JSON.stringify(history).includes(content),'User message must persist');
  const historyText=JSON.stringify(history);
  assert.ok(historyText.includes('AI'),'AI response must persist');
  // Await any queued realtime delivery without publishing to other users.
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.ok(events.length>0,'Expected real Ably delivery for the unshared test session');
  realtime.close();
  const wsResult=await new Promise((resolve,reject)=>{
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/realtime');
    const timer=setTimeout(()=>{ws.terminate();reject(new Error('WS timeout'));},10000);
    ws.on('open',()=>ws.send(JSON.stringify({type:'auth',token:'invalid'})));
    ws.on('close',(code)=>{clearTimeout(timer);resolve(code);});ws.on('error',reject);
  });
  assert.equal(wsResult,1008,'WebSocket upgrade should succeed and invalid auth should be rejected');
  console.log(JSON.stringify({sessionId:id,sse:{chunks,firstChunkMs:firstChunk,totalMs:elapsed,events:types},ablyEvents:events,persistence:'passed',websocketInvalidAuthClose:wsResult}));
})().catch(e=>{console.error(e.message);process.exit(1);});
