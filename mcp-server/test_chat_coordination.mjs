import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir=await mkdtemp(join(tmpdir(),'mdnest-mcp-test-'));

const requests=[];
const backend=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  const u=new URL(req.url,'http://fixture');requests.push({url:u,method:req.method,body});
  res.setHeader('Content-Type','application/json');
  if(u.pathname==='/api/config'){res.end(JSON.stringify({chat:true}));return;}
  if(u.pathname==='/api/chat/stream'){res.setHeader('Content-Type','text/event-stream');res.write('event: change\ndata: {}\n\n');req.on('close',()=>res.end());return;}
  if(u.pathname==='/api/chat/room'){res.end(JSON.stringify({agents:[{handle:'builder',trait:'Build safely'}],crew_status:'active'}));return;}
  if(u.pathname==='/api/chat/claim'){res.end(JSON.stringify({claimed:true,held_by:'builder',expires:'2030-01-01T00:00:00Z',lease_id:'m_lease'}));return;}
  if(req.method==='POST'){res.end(JSON.stringify({status:'posted',msg_id:'m_one',consecutive_agent_turns:1,max_agent_turns:8}));return;}
  const messages=u.searchParams.get('last')==='1001'?Array.from({length:1001},(_,i)=>({id:'m_'+i,n:i+1,body:'task'})):[{id:'m_one',n:1,type:'task',reply_to:'',meta:{quote:'"'},claimed_by:'',body:'hello'}];
  res.end(JSON.stringify({messages}));
});
await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const transport=new StdioClientTransport({command:process.execPath,args:['index.js'],cwd:import.meta.dirname,env:{...process.env,MCP_TRANSPORT:'stdio',MDNEST_TOKEN:'fake-fixture',MDNEST_URL:`http://127.0.0.1:${backend.address().port}`,MDNEST_MCP_LOCAL_CREW:'false'},stderr:'pipe'});
const client=new Client({name:'chat-fixture',version:'1'});
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  for(const name of ['mdnest_chat_read','mdnest_chat_post','mdnest_chat_claim','mdnest_chat_roster','mdnest_chat_crew_spawn','mdnest_chat_agent_prompt'])assert.ok(tools.some(t=>t.name===name),name);
  let r=await client.callTool({name:'mdnest_chat_read',arguments:{namespace:'notes',path:'room.md',as:'builder',unseen_only:true,last:2,ack:true,type:'task'}});
  assert.ok(!r.isError);assert.equal(requests.at(-1).url.pathname,'/api/chat/ack');assert.equal(requests.at(-1).body,'["m_one"]');
  const before=requests.length;
  r=await client.callTool({name:'mdnest_chat_read',arguments:{namespace:'notes',path:'room.md',as:'builder',last:1001,ack:true}});
  assert.ok(!r.isError);assert.deepEqual(requests.slice(before).filter(r=>r.url.pathname==='/api/chat/ack').map(r=>JSON.parse(r.body).length),[1000,1]);
  r=await client.callTool({name:'mdnest_chat_post',arguments:{namespace:'notes',path:'room.md',as:'builder',text:'reply',type:'review',reply_to:'m_one',meta:{literal:'"'},done:true}});
  assert.equal(JSON.parse(r.content[0].text).msg_id,'m_one');assert.equal(requests.at(-1).url.searchParams.get('done'),'true');
  r=await client.callTool({name:'mdnest_chat_claim',arguments:{namespace:'notes',path:'room.md',as:'builder',msg_id:'m_one',worker:'host1'}});assert.equal(JSON.parse(r.content[0].text).claimed,true);
  r=await client.callTool({name:'mdnest_chat_crew_spawn',arguments:{namespace:'notes',path:'new.md',goal:'test',agents:[{handle:'builder',trait:'build'}]}});assert.ok(r.isError);assert.match(r.content[0].text,/disabled/);
  r=await client.getPrompt({name:'agent_handoff_protocol',arguments:{namespace:'notes',path:'room.md',handle:'builder'}});assert.match(r.messages[0].content.text,/untrusted/);
  const uri='mdnest://chat/notes/room.md/transcript';r=await client.readResource({uri});assert.equal(JSON.parse(r.contents[0].text).messages[0].id,'m_one');
  let notify;const notified=new Promise(resolve=>notify=resolve);
  const {ResourceUpdatedNotificationSchema}=await import('@modelcontextprotocol/sdk/types.js');
  client.setNotificationHandler(ResourceUpdatedNotificationSchema,n=>notify(n));
  await client.subscribeResource({uri});
  const n=await Promise.race([notified,new Promise((_,reject)=>setTimeout(()=>reject(Error('resource notification missing')),3000))]);assert.equal(n.params.uri,uri);
  await client.unsubscribeResource({uri});
  console.log('PASS MCP structured read/post, ack, claim, roster schema, denied spawn, transcript, prompt and stdio subscription');
  const launcher=join(dir,'launcher'),captured=join(dir,'args.json'),configPath=join(dir,'crew.json');
  await writeFile(launcher,`#!${process.execPath}\nimport('node:fs').then(fs=>{const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({args,config:JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1],'utf8'))}));});`,{mode:0o700});
  await writeFile(configPath,JSON.stringify({cli:launcher,cwd:dir,agents:{builder:'trusted-command-only'},max_turns:2,timeout:'1s'}));
  const enabledTransport=new StdioClientTransport({command:process.execPath,args:['index.js'],cwd:import.meta.dirname,env:{...process.env,MCP_TRANSPORT:'stdio',MDNEST_TOKEN:'fake-fixture',MDNEST_URL:`http://127.0.0.1:${backend.address().port}`,MDNEST_MCP_LOCAL_CREW:'true',MDNEST_MCP_CREW_CONFIG:configPath},stderr:'pipe'});
  const enabledClient=new Client({name:'launch-fixture',version:'1'});
  try {
    await enabledClient.connect(enabledTransport);
    r=await enabledClient.callTool({name:'mdnest_chat_crew_spawn',arguments:{namespace:'notes',path:'new.md',goal:'test',agents:[{handle:'builder',trait:'Build'}],max_turns:999,timeout:'1h'}});
    assert.ok(!r.isError,r.content[0].text);
    const launch=JSON.parse(r.content[0].text);let status;
    for(let i=0;i<30;i++){status=JSON.parse((await enabledClient.callTool({name:'mdnest_chat_crew_status',arguments:{launch_id:launch.launch_id}})).content[0].text);if(status.exit_code!==undefined)break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(status.exit_code,0);
    const {config}=JSON.parse(await readFile(captured,'utf8'));
    assert.equal(config.max_turns,2);assert.equal(config.timeout,'1000ms');
    assert.deepEqual(config.agents,[{handle:'builder',trait:'Build',cmd:'trusted-command-only'}]);console.log('PASS opted-in MCP spawn uses only trusted launchers and clamps local budgets');
    const pidLog=join(dir,'pids.jsonl');
    await writeFile(launcher,`#!${process.execPath}\nimport('node:fs').then(fs=>{fs.appendFileSync(${JSON.stringify(pidLog)},JSON.stringify({pid:process.pid,profileHome:process.env.HOME})+'\\n');setInterval(()=>{},100);});`,{mode:0o700});
    const launched=await Promise.all(Array.from({length:6},(_,i)=>enabledClient.callTool({name:'mdnest_chat_crew_spawn',arguments:{namespace:'notes',path:'concurrent'+i+'.md',goal:'test',agents:[{handle:'builder',trait:'Build: quotes\\nand lines'}]}})));
    assert.equal(launched.filter(r=>!r.isError).length,4,'concurrent local crew limit');
    for(let i=0;i<30;i++){try{if((await readFile(pidLog,'utf8')).trim().split('\n').length===4)break;}catch{}await new Promise(r=>setTimeout(r,20));}
    const owned=(await readFile(pidLog,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(owned.length,4);
    process.kill(enabledTransport.pid,'SIGTERM');
    for(let i=0;i<100;i++){let alive=0;for(const p of owned){try{process.kill(p.pid,0);alive++;}catch{}}if(!alive)break;await new Promise(r=>setTimeout(r,30));}
    for(const p of owned){assert.throws(()=>process.kill(p.pid,0));await assert.rejects(readFile(join(p.profileHome,'.config/mdnest/servers/local')));}
    console.log('PASS concurrent MCP spawn limit and SIGTERM cleanup remove owned processes and credential homes');
  }finally{await enabledClient.close();await enabledTransport.close();}
}finally{await client.close();await transport.close();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));await rm(dir,{recursive:true,force:true});}
