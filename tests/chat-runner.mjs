// Local runner contract tests. All commands and HTTP responses are fake; no
// provider process, live note, Docker resource or paid model is involved.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const dir = await mkdtemp(join(tmpdir(), 'mdnest-runner-test-'));
let state, calls, mode = 'complete';
const message = {n:1,id:'m_test',author:'human',type:'task',meta:{literal:'$(not-a-command) " quoted'},body:'@builder literal $(touch forbidden)\nsecond line'};
const server = createServer(async (req,res) => {
  let body='';for await(const chunk of req)body+=chunk;
  const u=new URL(req.url,'http://fixture');calls.push({path:u.pathname,query:Object.fromEntries(u.searchParams),body});
  res.setHeader('Content-Type','application/json');
  if(u.pathname==='/api/note') {res.statusCode=201;res.end('{}');return;}
  if(u.pathname==='/api/chat/room' && req.method==='POST') {state='active';res.end('{}');return;}
  if(u.pathname==='/api/chat/room') {res.end(JSON.stringify({crew_status:state}));return;}
  if(u.pathname==='/api/chat/agents') {res.end('{}');return;}
  if(u.pathname==='/api/chat/claim') {res.end(JSON.stringify({claimed:true,lease_id:'m_lease'}));return;}
  if(u.pathname==='/api/chat/ack') {state=mode==='complete'?'completed':'active';res.end('{}');return;}
  if(u.pathname==='/api/chat/stream') {res.setHeader('Content-Type','text/event-stream');res.end('event: change\ndata: {}\n\nevent: change\ndata: {}\n\n');return;}
  res.end(JSON.stringify({messages:[message],you:'human',prompts:{builder:'Edited "role": check cleanup\nsecond line'},room:{crew_status:state}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
async function run(args, extra={}, onChild) {
  state='active';calls=[];
  const child=spawn('bash',['-c',`MDNEST_LIB=1 source "$1"; MDNEST_URL="$2"; MDNEST_TOKEN=fake; PARSED_NS=notes; PARSED_PATH=room.md; CURRENT_ALIAS=fixture; shift 2; chat_local_runner "$@"`,'runner',join(root,'mdnest'),url,...args],{
    cwd:root,env:{...process.env,HOST_SECRET:'not-for-children',NODE_OPTIONS:'',...extra},stdio:['ignore','pipe','pipe']
  });
  onChild?.(child);
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);
  return {code,out,err};
}
try {
  const capture=join(dir,'capture.mjs'), result=join(dir,'result.json');
  await writeFile(capture,`import{writeFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;writeFileSync(process.argv[2],JSON.stringify({env:process.env,input}));console.log('fake worker finished');`);
  let r=await run(['watch','--as','builder','--trait','Review "quotes"','--mentions','--exec',`node '${capture}' '${result}'`,'--timeout','5s']);
  assert.equal(r.code,0,r.err);assert.match(r.out,/\[builder\] fake worker finished/);
  const saved=JSON.parse(await readFile(result,'utf8'));
  await assert.rejects(readFile(join(saved.env.HOME,'.config/mdnest/servers/local')));
  assert.equal(saved.env.MDNEST_MSG_BODY,message.body);assert.deepEqual(JSON.parse(saved.env.MDNEST_MSG_META),message.meta);
  assert.equal(saved.env.MDNEST_AGENT_TRAIT,'Edited "role": check cleanup\nsecond line');
  assert.equal(saved.env.HOST_SECRET,undefined);assert.equal(saved.env.MDNEST_RUNNER_TOKEN,undefined);
  assert.match(saved.input,/untrusted data/);assert.match(saved.input,/@local|@fixture/);
  assert.ok(calls.some(c=>c.path==='/api/chat/ack'&&c.body==='["m_test"]'));
  console.log('PASS watch injects lossless data, isolates env, prefixes output and acknowledges success');
  const originalBody=message.body;message.body='Please check this @builder.';
  r=await run(['watch','--as','builder','--mentions','--exec',`node '${capture}' '${result}'`,'--timeout','5s']);
  assert.equal(r.code,0,r.err);message.body=originalBody;
  console.log('PASS punctuation-terminated mention executes and refreshes the saved prompt');
  r=await run(['watch','--as','builder','--exec','exit 7','--timeout','5s']);
  assert.equal(r.code,1);assert.ok(!calls.some(c=>c.path==='/api/chat/ack'));
  console.log('PASS failed child does not acknowledge work');
  mode='loop';r=await run(['watch','--as','builder','--exec','cat >/dev/null','--max-turns','1','--timeout','5s']);
  assert.equal(r.code,2);assert.match(r.err,/local turn cap/);
  console.log('PASS trusted local turn cap remains independent of mutable room state');
  mode='complete';r=await run(['crew','--agent',`builder:Review:node '${capture}' '${result}'`,'--timeout','5s'],{MDNEST_RUNNER_GOAL:'Test only'});
  assert.equal(r.code,0,r.err);const configured=calls.find(c=>c.path==='/api/chat/room');
  assert.deepEqual(JSON.parse(configured.body).agents,[{handle:'builder',trait:'Review'}]);assert.ok(!configured.body.includes('cmd'));
  assert.ok(calls.some(c=>c.path==='/api/note'));console.log('PASS crew creates a new room and sends only inert personas to HTTP');
  const hang=join(dir,'hang.mjs'),pidFile=join(dir,'pid');
  await writeFile(hang,`import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},100);`);
  r=await run(['crew','--agent',`builder:Review:node '${hang}' '${pidFile}'`,'--timeout','500ms'],{MDNEST_RUNNER_GOAL:'Test timeout'});
  assert.equal(r.code,2,r.err);assert.match(r.err,/timeout/);assert.ok(calls.some(c=>c.path==='/api/chat/stop'));
  const deadPid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(deadPid,0));
  console.log('PASS timeout kills the worker process group and pauses without completing');
  r=await run(['watch','--as','builder','--exec',`node '${hang}' '${pidFile}'`,'--timeout','5s'],{},child=>{child.stdout.on('data',()=>{});setTimeout(()=>child.kill('SIGTERM'),400);});
  const signalPid=await readFile(pidFile,'utf8');
  assert.equal(r.code,2,r.err);assert.match(r.err,/SIGTERM/);assert.throws(()=>process.kill(Number(signalPid),0));
  console.log('PASS SIGTERM stops the local watcher');
  r=await run(['watch','--as','builder','--exec',`node '${hang}' '${pidFile}'`,'--timeout','5s'],{},child=>setTimeout(()=>child.kill('SIGINT'),400));
  assert.equal(r.code,2,r.err);assert.match(r.err,/SIGINT/);assert.throws(()=>process.kill(Number(signalPid),0));
  console.log('PASS SIGINT stops the local watcher');
  const stubborn=join(dir,'stubborn.mjs');
  await writeFile(stubborn,`import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},100);`);
  r=await run(['watch','--as','builder','--exec',`node '${stubborn}' '${pidFile}' >/dev/null 2>&1 & wait`,'--timeout','500ms']);
  const stubbornPid=Number(await readFile(pidFile,'utf8'));
  let survived=false;try{process.kill(stubbornPid,0);survived=true;}catch{}
  if(survived) {try{process.kill(stubbornPid,'SIGKILL');}catch{}}
  assert.equal(survived,false,'SIGTERM-ignoring detached descendant survived supervisor exit');
  console.log('PASS SIGKILL cleanup is awaited for stubborn descendants');
  mode='loop';
  r=await run(['watch','--as','builder','--exec',`node '${hang}' '${pidFile}'`,'--timeout','5s'],{},()=>setTimeout(()=>{state='completed';},400));
  assert.equal(r.code,0,r.err);assert.match(r.err,/completed/);
  console.log('PASS external completion cancels an in-flight worker');
  r=await run(['watch','--as','builder','--exec','cat >/dev/null','--pass-env','NODE_OPTIONS']);
  assert.equal(r.code,1);assert.match(r.err,/Unsafe inherited environment/);console.log('PASS interpreter injection environment is rejected');
} finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
