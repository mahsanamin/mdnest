// Real REST/browser/CLI/MCP integration for an isolated, two-mount fixture.
// This file never logs credentials or calls a real model/provider.
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const [mode, dir, ...args] = process.argv.slice(2);
const secret = () => randomBytes(24).toString('hex');
const privateWrite = (path, content) => writeFile(path, content, { mode: 0o600 });
if (mode === 'init') {
  await mkdir(join(dir, 'logs'), { recursive: true, mode: 0o700 });
  // The mounted notes may live apart from the private fixture (args[1]).
  const notes = args[1] || dir;
  for (const ns of ['team-alpha', 'team-beta']) {
    await mkdir(join(notes, ns), { recursive: true });
    await writeFile(join(notes, ns, 'Welcome.md'), `# ${ns}\n\nSynthetic read-only inspection baseline.\n`);
  }
  const pgPassword = secret(), password = secret();
  await privateWrite(join(dir, 'postgres.env'), `POSTGRES_USER=mdnest\nPOSTGRES_DB=mdnest\nPOSTGRES_PASSWORD=${pgPassword}\n`);
  await privateWrite(join(dir, 'backend.env'), `AUTH_MODE=multi\nPOSTGRES_HOST=${args[0]}\nPOSTGRES_PASSWORD=${pgPassword}\nMDNEST_USER=admin\nMDNEST_PASSWORD=${password}\nMDNEST_JWT_SECRET=${secret()}\nNOTES_DIR=/notes\nFRONTEND_ORIGIN=http://localhost\nENABLE_CHAT=true\nENABLE_LIVE_COLLAB=false\n`);
  await privateWrite(join(dir, 'bootstrap.json'), JSON.stringify({ password }));
} else if (mode === 'configure') {
  const [base, backendURL, backend, frontend, postgres, network, backendImage, frontendImage] = args;
  const { password } = JSON.parse(await readFile(join(dir, 'bootstrap.json'), 'utf8'));
  await privateWrite(join(dir, 'fixture.json'), JSON.stringify({ base, backendURL, backend, frontend, postgres, network, backendImage, frontendImage, dir, root, accounts: { admin: { password } } }));
} else if (mode === 'manifest') {
  const f=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8'));
  const inspect=await new Promise((resolve,reject)=>{const p=spawn('docker',['inspect',f.backend,f.frontend],{stdio:['ignore','pipe','ignore']});let out='';p.stdout.on('data',c=>out+=c);p.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error('fixture inspect failed')));});
  await privateWrite(join(dir,'manifest.json'),JSON.stringify({head:process.env.GIT_HEAD,sourceTree:process.env.GIT_TREE,base:f.base,namespaces:['team-alpha','team-beta'],images:inspect.map(c=>({name:c.Name,image:c.Image,configuredImage:c.Config.Image})),mounts:inspect[0].Mounts.map(m=>({source:m.Source,destination:m.Destination})),roles:{admin:'write both namespaces','alpha-admin':'namespace admin team-alpha','alpha-writer':'write team-alpha','alpha-reader':'read team-alpha','beta-writer':'write team-beta'}},null,2));
} else if (mode === 'run') {
  const f = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
  const results = [];
  const check = (name, condition) => { results.push({ name, passed: !!condition }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); assert.ok(condition, name); };
  const query = (ns, path, extra = {}) => new URLSearchParams({ ns, path, ...extra });
  async function api(method, path, token, body) {
    const response = await fetch(f.base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'object' && body !== null ? JSON.stringify(body) : body, signal: AbortSignal.timeout(15000) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text };
  }
  const expect = async (method, path, token, body, status) => { const r = await api(method, path, token, body); assert.equal(r.status, status, `${method} ${path.split('?')[0]} status ${r.status}`); return r.data; };
  async function login(name, password, final = password) {
    let r = await api('POST', '/api/auth/login', undefined, { username: name, password });
    if (r.data?.status === 'change_password_required') r = await api('POST', '/api/auth/change-password-forced', undefined, { tempToken: r.data.tempToken, newPassword: final });
    assert.equal(r.status, 200, `login ${name}`); assert.ok(r.data.token); return r.data.token;
  }
  async function run(command, argv, options = {}) {
    const child = spawn(command, argv, { cwd: root, env: { PATH:process.env.PATH, HOME:dir, LANG:'C.UTF-8', ...options.env }, detached:true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    let escalation;
    const timer = setTimeout(() => { try {process.kill(-child.pid,'SIGTERM');}catch{} escalation=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000); }, options.timeout || 30000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timer);if(escalation){clearTimeout(escalation);try{process.kill(-child.pid,'SIGKILL');}catch{}}
    return { code, stdout, stderr };
  }
  const cli = (name, argv, options = {}) => run(join(root, 'mdnest'), argv, { ...options, env: { ...options.env, HOME: f.accounts[name].profileHome } });
  try {
    f.accounts.admin.browserToken = await login('admin', f.accounts.admin.password);
    for (const name of ['alpha-writer', 'alpha-reader', 'beta-writer', 'alpha-admin']) {
      const password = secret();
      await expect('POST', '/api/admin/invite', f.accounts.admin.browserToken, { username: name, email: `${name}@example.com`, password, role: 'collaborator' }, 201);
      f.accounts[name] = { password };
    }
    const users = await expect('GET', '/api/admin/users', f.accounts.admin.browserToken, undefined, 200);
    const ids = Object.fromEntries(users.map(u => [u.username, u.id]));
    for (const [name, ns, permission] of [['admin', 'team-alpha', 'write'], ['admin', 'team-beta', 'write'], ['alpha-writer', 'team-alpha', 'write'], ['alpha-reader', 'team-alpha', 'read'], ['beta-writer', 'team-beta', 'write']]) {
      await expect('POST', '/api/admin/grants', f.accounts.admin.browserToken, { user_id: ids[name], namespace: ns, path: '/', permission }, 201);
    }
    await expect('POST', '/api/admin/namespace-admins', f.accounts.admin.browserToken, { user_id: ids['alpha-admin'], namespace: 'team-alpha' }, 201);
    for (const [name, a] of Object.entries(f.accounts)) {
      a.browserToken ||= await login(name, a.password, a.password + 'X');
      if (name !== 'admin') a.password += 'X';
      const t = await expect('POST', '/api/auth/tokens', a.browserToken, { name: 'isolated-agentic-fixture' }, 201);
      a.apiToken = t.token; a.profileHome = join(dir, 'homes', name);
      await mkdir(join(a.profileHome, '.config/mdnest/servers'), { recursive: true, mode: 0o700 });
      await privateWrite(join(a.profileHome, '.config/mdnest/servers/fixture'), `url=${f.base}\ntoken=${a.apiToken}\n`);
    }
    await privateWrite(join(dir, 'fixture.json'), JSON.stringify(f));
    await privateWrite(join(dir, 'login-details.txt'), `Local isolated test site: ${f.base}\nNamespaces: team-alpha, team-beta\n\n${Object.entries(f.accounts).map(([name,a]) => `${name}\nPassword: ${a.password}\n`).join('\n')}`);
    check('fixture credential files are private', (await stat(join(dir, 'fixture.json'))).mode % 512 === 0o600 && (await stat(join(dir, 'login-details.txt'))).mode % 512 === 0o600);
    const alpha = f.accounts['alpha-writer'], reader = f.accounts['alpha-reader'], beta = f.accounts['beta-writer'], admin = f.accounts.admin;
    await expect('GET', '/api/note?' + query('team-alpha', 'Welcome.md'), alpha.apiToken, undefined, 200);
    await expect('GET', '/api/note?' + query('team-beta', 'Welcome.md'), alpha.apiToken, undefined, 403);
    await expect('POST', '/api/note?' + query('team-beta', 'denied.md'), alpha.apiToken, 'denied', 403);
    await expect('POST', '/api/note?' + query('team-alpha', 'denied.md'), reader.apiToken, 'denied', 403);
    await expect('POST', '/api/note?' + query('team-beta', 'beta.md'), beta.apiToken, '# Beta collaborator', 201);
    await expect('POST', '/api/note?' + query('team-alpha', 'admin.md'), f.accounts['alpha-admin'].apiToken, '# Namespace admin', 201);
    await expect('GET', '/api/note?' + query('team-beta', 'Welcome.md'), f.accounts['alpha-admin'].apiToken, undefined, 403);
    check('real API-token namespace and read-only permissions', true);
    let r = await cli('alpha-writer', ['read', '@fixture/team-beta/Welcome.md']); check('restricted CLI read is refused', r.code !== 0);
    const target = 'team-alpha/Chat.md', q = query('team-alpha', 'Chat.md');
    await expect('POST', '/api/chat/convert?' + q, alpha.apiToken, '', 201);
    await expect('POST', '/api/chat/room?' + q, alpha.apiToken, { max_agent_turns: 1, human_handle: 'alpha-writer', agents: [{ handle: 'builder', trait: 'Build' }], goal: 'Start' }, 200);
    await expect('POST', '/api/chat?' + query('team-alpha', 'Chat.md', { as: 'builder' }), alpha.apiToken, 'Threshold post', 201);
    await expect('POST', '/api/chat?' + q, alpha.apiToken, 'Token cannot resume', 409);
    await expect('POST', '/api/chat?' + q, alpha.browserToken, 'Browser human resumes', 201);
    check('API token cannot reset while browser human can', true);
    const post = await expect('POST', '/api/chat?' + query('team-alpha', 'Chat.md', { as: 'builder', type: 'task',meta:JSON.stringify({literal:'quoted " value',nested:{approved:false}}) }), alpha.apiToken, '@reviewer. durable task', 201);
    const unseenURL = '/api/chat?' + query('team-alpha', 'Chat.md', { as: 'reviewer', unseen_only: 'true', type: 'task' });
    const unseen = await expect('GET', unseenURL, alpha.apiToken, undefined, 200);
    await expect('POST', '/api/chat/ack?' + query('team-alpha', 'Chat.md', { as: 'reviewer' }), alpha.apiToken, unseen.messages.map(m => m.id), 200);
    const invalidRead=await api('GET','/api/chat?'+query('team-alpha','Chat.md',{as:'reviewer',unseen_only:'true',type:'task'}),reader.apiToken);
    check('acknowledgment is scoped to the authenticated account',invalidRead.status===200&&invalidRead.data.messages.some(m=>m.id===post.msg_id));
    const races = await Promise.all(Array.from({ length: 20 }, (_, i) => api('POST', '/api/chat/claim?' + query('team-alpha', 'Chat.md', { as: 'reviewer', worker: 'worker' + i, msg_id: post.msg_id }), alpha.apiToken, '')));
    check('20 real REST claim racers have exactly one winner', races.filter(r => r.status === 200).length === 1 && races.filter(r => r.status === 409).length === 19);
    await expect('POST', '/api/chat/claim?' + query('team-alpha', 'Chat.md', { as: 'reader', msg_id: post.msg_id }), reader.apiToken, '', 403);
    const persistedPrompt='Durable "prompt"\nSecond line';
    await expect('POST','/api/chat/agents?'+query('team-alpha','Chat.md',{name:'persisted'}),alpha.apiToken,persistedPrompt,200);
    const claimWinner=races.find(r=>r.status===200).data;
    const restarted = await run('docker', ['restart', f.backend]); assert.equal(restarted.code, 0);
    for (let i = 0; i < 60; i++) { try { if ((await api('GET', '/api/config')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const mapped=await run('docker',['port',f.backend,'8080/tcp']);assert.equal(mapped.code,0);
    f.backendURL='http://127.0.0.1:'+mapped.stdout.trim().split(':').at(-1);
    await privateWrite(join(dir,'fixture.json'),JSON.stringify(f));
    const after = await expect('GET', unseenURL, alpha.apiToken, undefined, 200);
    check('durable unseen ack survives backend restart', after.messages.length === 0);
    const restored=await expect('GET','/api/chat?'+q,alpha.apiToken,undefined,200);
    const restoredMessage=restored.messages.find(m=>m.id===post.msg_id);
    check('prompt metadata lease and pause survive real backend restart',restored.prompts.persisted===persistedPrompt&&restoredMessage.meta.literal==='quoted " value'&&restored.room.claims[post.msg_id].lease_id===claimWinner.lease_id&&restored.room.crew_status==='paused');
    const requireBrowser = createRequire(join(root, 'tests/browser/package.json'));
    const { chromium } = requireBrowser('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ colorScheme: 'dark' });
      await page.goto(f.base); await page.fill('input[name=username]', 'alpha-writer'); await page.fill('input[name=password]', alpha.password); await page.click('button:has-text("Sign in")');
      await page.goto(`${f.base}/#!chats/team-alpha/Chat.md`);
      await page.locator('.chat-room-title h2').waitFor({ timeout: 20000 });
      await page.locator('.chat-btn', { hasText: /Connect an agent|Agents/ }).first().click();
      const panel = page.locator('.chat-agent');
      r = await cli('alpha-writer', ['chat', 'post', '@fixture/' + target, '/role Review inputs', '--as', 'reviewer']); assert.equal(r.code, 0);
      await panel.getByTestId('chat-agent-saved').getByText('reviewer', { exact: true }).waitFor({ timeout: 10000 });
      await panel.getByRole('button', { name: "Edit reviewer's prompt" }).click();
      const prompt = 'Review "quotes".\nThen check permissions.';
      await panel.getByRole('textbox', { name: 'What this agent should do' }).fill(prompt);
      await panel.getByRole('button', { name: 'Save prompt', exact: true }).click();
      let saved;
      for(let i=0;i<40;i++){saved=await expect('GET','/api/chat?'+q,alpha.apiToken,undefined,200);if(saved.prompts.reviewer===prompt)break;await new Promise(r=>setTimeout(r,100));}
      check('multi-user browser edits CLI-added multiline prompt', saved.prompts.reviewer === prompt);
      await page.screenshot({ path: join(dir, 'logs', 'agent-prompt-multi.png'), fullPage: true });
    } finally { await browser.close(); }
    const worker = join(dir, 'fake-worker.sh');
    await privateWrite(worker, '#!/bin/sh\nset -eu\ncat >/dev/null\nif [ "$MDNEST_AGENT_HANDLE" = builder ]; then\n  "$MDNEST_TEST_CLI" chat post "$MDNEST_NOTE" "@reviewer. Please verify" --as builder --type review\nelse\n  "$MDNEST_TEST_CLI" chat post "$MDNEST_NOTE" "Verified by fake reviewer" --as reviewer --type ack --done\nfi\n');
    r = await cli('alpha-writer', ['chat', 'crew', 'Run fake workflow', '--note', '@fixture/team-alpha/Crew.md', '--agent', 'builder:Build:/bin/sh ' + worker, '--agent', 'reviewer:Review:/bin/sh ' + worker, '--max-turns', '8', '--timeout', '20s', '--pass-env', 'MDNEST_TEST_CLI'], { env: { MDNEST_TEST_CLI: join(root, 'mdnest') }, timeout: 30000 });
    await privateWrite(join(dir, 'logs', 'crew-output.log'), r.stdout + r.stderr);
    check('real multi-user backend two-worker CLI crew posts handoff and done', r.code === 0);
    const crew = await expect('GET', '/api/chat?' + query('team-alpha', 'Crew.md'), alpha.apiToken, undefined, 200);
    check('real crew completion and both fake worker authors persisted', crew.room.crew_status === 'completed' && crew.messages.some(m => m.author === 'builder') && crew.messages.some(m => m.author === 'reviewer'));
    const pauseWorker=join(dir,'pause-worker.sh'),hangWorker=join(dir,'hang-worker.sh'),pidFile=join(dir,'worker.pid');
    await privateWrite(pauseWorker,'#!/bin/sh\nset -eu\ncat >/dev/null\n"$MDNEST_TEST_CLI" chat post "$MDNEST_NOTE" "Turn cap reached" --as builder\n');
    await privateWrite(hangWorker,'#!/bin/sh\nset -eu\ncat >/dev/null\nprintf "%s" "$$" >"$MDNEST_TEST_PID"\nsleep 60\n');
    r=await cli('alpha-writer',['chat','crew','Pause workflow','--note','@fixture/team-alpha/Pause.md','--agent','builder:Build:/bin/sh '+pauseWorker,'--max-turns','1','--timeout','10s','--pass-env','MDNEST_TEST_CLI'],{env:{MDNEST_TEST_CLI:join(root,'mdnest')},timeout:20000});
    const paused=await expect('GET','/api/chat/room?'+query('team-alpha','Pause.md'),alpha.apiToken,undefined,200);
    check('real crew turn cap stops and persists pause',r.code===2&&paused.crew_status==='paused'&&paused.consecutive_agent_turns===1);
    r=await cli('alpha-writer',['chat','crew','Timeout workflow','--note','@fixture/team-alpha/Timeout.md','--agent','builder:Build:/bin/sh '+hangWorker,'--timeout','2s','--pass-env','MDNEST_TEST_PID'],{env:{MDNEST_TEST_PID:pidFile},timeout:10000});
    const timeoutRoom=await expect('GET','/api/chat/room?'+query('team-alpha','Timeout.md'),alpha.apiToken,undefined,200);
    let alive=false;const pid=Number(await readFile(pidFile,'utf8'));try{process.kill(pid,0);alive=true;}catch{}
    check('real crew timeout kills local worker and pauses without completion',r.code===2&&!alive&&timeoutRoom.crew_status==='paused');
    const requireMCP = createRequire(join(root, 'mcp-server/package.json'));
    const { Client } = await import(requireMCP.resolve('@modelcontextprotocol/sdk/client/index.js'));
    const { StdioClientTransport } = await import(requireMCP.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'mcp-server/index.js')], env: { PATH: process.env.PATH, HOME: alpha.profileHome, MDNEST_URL: f.base, MDNEST_TOKEN: alpha.apiToken, MCP_TRANSPORT: 'stdio' }, stderr: 'pipe' });
    const client = new Client({ name: 'real-multi-fixture', version: '1' });
    try {
      await client.connect(transport);
      const m = await client.callTool({ name: 'mdnest_chat_read', arguments: { namespace: 'team-alpha', path: 'Crew.md', last: 6 } });
      check('MCP structured tool uses real multi-user REST', !m.isError && JSON.parse(m.content[0].text).messages.length >= 3);
      const resource = await client.readResource({ uri: 'mdnest://chat/team-alpha/Crew.md/transcript' });
      check('MCP transcript resource uses real multi-user REST', JSON.parse(resource.contents[0].text).room.crew_status === 'completed');
      const denied = await client.callTool({ name: 'mdnest_chat_read', arguments: { namespace: 'team-beta', path: 'Welcome.md', last: 1 } });
      check('MCP cross-namespace error is surfaced', denied.isError && denied.content[0].text.includes('403'));
    } finally { await client.close(); await transport.close(); }
    check('both mounted files remain present and namespace denial wrote nothing', (await readFile(join(dir, 'team-alpha', 'Welcome.md'), 'utf8')).includes('team-alpha') && (await readFile(join(dir, 'team-beta', 'Welcome.md'), 'utf8')).includes('team-beta') && !(await stat(join(dir, 'team-beta', 'denied.md')).catch(() => null)));
    console.log(`RESULT ${results.length} passed, 0 failed`);
  } catch (e) {
    console.error(`FAIL ${e.message.replace(/mdnest_[A-Za-z0-9_-]+/g, '[redacted]')}`); process.exitCode = 1;
  } finally { await privateWrite(join(dir, 'logs', 'results.json'), JSON.stringify(results, null, 2)); }
} else throw Error('Expected init, configure or run');
