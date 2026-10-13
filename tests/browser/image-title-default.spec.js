// Full-app regression: valid untitled images must survive Live editing.
import { test, expect } from '@playwright/test';
const NS = 'testing_workspace';
const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfFcIYzpSH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBuiohHpao8xUAAAAASUVORK5CYII=', 'base64');
const cases = {
  inline: 'Before ![sample](sample.png) after.\n\nEnd marker.\n',
  block: '![sample](sample.png)\n\nEnd marker.\n',
  reference: 'Before ![sample][picture] after.\n\n[picture]: sample.png\n\nEnd marker.\n',
  titled: 'Before ![sample](sample.png "My image") after.\n\nEnd marker.\n',
  'block-titled': '![sample](sample.png "My image")\n\nEnd marker.\n',
  'spaced-path': 'Before ![sample](sample%20image.png) after.\n\nEnd marker.\n',
};
async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible();
}
async function auth(request) {
  const response = await request.post('/api/auth/login', {data:{username:USER,password:PASS}});
  expect(response.ok()).toBeTruthy();
  return {Authorization:'Bearer '+(await response.json()).token};
}
function noteURL(path) { return `/api/note?ns=${NS}&path=${encodeURIComponent(path)}`; }
async function open(page, path) {
  // Wait for namespace/tree initialisation before choosing the note.
  const row=page.locator('.tree-label', {hasText:path});
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.toolbar-path')).toContainText(path);
  await page.getByRole('button', {name:'Live',exact:true}).click();
}
if (process.env.MDNEST_IMAGE_BASELINE === '1') {
  test('image regression: stock frontend reproduces null-title failure', async ({page,request})=>{
    const headers=await auth(request);
    const path=`baseline-image-${Date.now()}.md`;
    expect((await request.post(noteURL(path),{headers,data:cases.inline})).ok()).toBeTruthy();
    const errors=[];
    page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
    page.on('pageerror',e=>errors.push(e.message));
    await login(page); await open(page,path);
    await expect.poll(()=>errors.join('\n')).toMatch(/Expected value of type string.*title.*null/);
  });
} else {
  for (const [kind,content] of Object.entries(cases)) {
    test(`image regression: ${kind} renders, saves and reopens`, async ({page,request})=>{
      const headers=await auth(request);
      const path=`image-${kind}-${Date.now()}.md`;
      expect((await request.post(noteURL(path),{headers,data:content})).ok()).toBeTruthy();
      const fileName=kind==='spaced-path'?'sample image.png':'sample.png';
      const upload=await request.post(`/api/upload?ns=${NS}&path=${path}`,{headers,multipart:{file:{name:fileName,mimeType:'image/png',buffer:PNG}}});
      expect(upload.ok()).toBeTruthy();
      const before=await (await request.get(noteURL(path),{headers})).text();
      const errors=[]; const writes=[];
      page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
      page.on('pageerror',e=>errors.push(e.message));
      page.on('request',r=>{if(r.method()==='PUT'&&r.url().includes('/api/note?')) writes.push(r.url())});
      await login(page); await open(page,path);
      const img=page.locator('.milkdown img');
      await expect(img).toHaveCount(1);
      await expect.poll(()=>img.evaluate(i=>i.complete&&i.naturalWidth===64)).toBe(true);
      expect(errors.join('\n')).not.toMatch(/RangeError|Expected value/);
      await page.waitForTimeout(1200); // Exceeds editor and app autosave debounce.
      expect(writes).toHaveLength(0);
      expect(await (await request.get(noteURL(path),{headers})).text()).toBe(before);
      const marker=`edited-${kind}`;
      const pm=page.locator('.ProseMirror').first();
      // Click text explicitly: clicking the editor's centre can select the
      // atomic block image, in which case typing correctly replaces it.
      const paragraph=pm.locator('p', {hasText:'End marker.'});
      await paragraph.click(); await pm.press('End'); await pm.type(' '+marker);
      await expect.poll(async()=>await (await request.get(noteURL(path),{headers})).text()).toContain(marker);
      const saved=await (await request.get(noteURL(path),{headers})).text();
      expect(saved).toMatch(/!\[[^\]]*\]/);
      // Crepe uses a block image's alt field for its existing size ratio.
      // Inline images retain their descriptive alt text.
      if(!kind.startsWith('block')) expect(saved).toContain('![sample]');
      expect(saved).toMatch(/sample\.png|sample(?:%20| )image\.png/);
      if(kind.includes('titled')) expect(saved).toContain('My image');
      await page.reload();
      await expect(page.locator('.toolbar-path')).toContainText(path);
      await expect(page.locator('.milkdown img')).toHaveCount(1);
      await expect.poll(()=>page.locator('.milkdown img').evaluate(i=>i.complete&&i.naturalWidth===64)).toBe(true);
      await expect(page.locator('.ProseMirror')).toContainText(marker);
      expect(errors.join('\n')).not.toMatch(/RangeError|Expected value/);
      const download=await request.get(`/api/files/${NS}/${encodeURIComponent(fileName)}`,{headers});
      expect(download.status()).toBe(200);
      expect(await download.body()).toEqual(PNG);
    });
  }
  test('image regression: attachments and notes still require authentication', async ({request})=>{
    expect((await request.get(noteURL('image-inline.md'))).status()).toBe(401);
    expect((await request.get(`/api/files/${NS}/sample.png`)).status()).toBe(401);
  });
}
