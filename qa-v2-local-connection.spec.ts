import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createPostgresAuthModule} from './server/auth/index';

// Opt-in local integration only. No mocked routes or production credentials.
test.skip(process.env.YPBI_LOCAL_INTEGRATION !== 'true','需要独立本地账号库');
test.use({channel:'chrome',viewport:{width:1280,height:950}});
let auth:Awaited<ReturnType<typeof createPostgresAuthModule>>;
let username:string;
const initial=randomBytes(24).toString('base64url'),replacement=randomBytes(24).toString('base64url');
const base='http://127.0.0.1:5173';
test.beforeAll(async()=>{
  const settings=Object.fromEntries(readFileSync('.env.backend-local','utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const target=new URL(settings.BI_AUTH_DATABASE_URL);
  if(target.hostname!=='127.0.0.1'||target.port!=='55432'||target.pathname!=='/ypbi_local_auth')throw new Error('只允许独立本地账号库');
  auth=await createPostgresAuthModule(settings.BI_AUTH_DATABASE_URL,{csrfSecret:settings.BI_AUTH_CSRF_SECRET});
  username=`qa.reader.${Date.now()}`;
  await auth.accountAdminService.createAccount({username,role:'reader',password:initial});
});
test.afterAll(async()=>{if(auth){try{if(username)await auth.accountAdminService.disableAccount(username);}finally{await auth.close();}}});
test('真实本地账号库：预览到登录、首次改密、普通阅读者进入维护及刷新',async({page})=>{
  await page.goto(base+'/dashboards/public?design=dashboard-center');
  await page.getByRole('link',{name:'连接真实数据',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登录 YPBI',exact:true})).toBeVisible();
  await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(initial);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'首次登录，请设置新密码'})).toBeVisible();
  await page.getByLabel('当前密码',{exact:true}).fill(initial);
  await page.getByRole('textbox',{name:/^新密码/}).fill(replacement);await page.getByLabel('确认新密码',{exact:true}).fill(replacement);
  await page.getByRole('button',{name:'设置新密码并继续'}).click();
  await expect(page.getByRole('heading',{name:'数据源维护',exact:true})).toBeVisible();
  await expect(page.getByLabel('维护密码',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByLabel('维护密码',{exact:true})).toBeVisible();
  // The maintenance secret is supplied by the caller, never copied into fixtures or logs.
  if(process.env.YPBI_LOCAL_MAINTENANCE_PASSWORD){
    await page.getByLabel('维护密码',{exact:true}).fill(process.env.YPBI_LOCAL_MAINTENANCE_PASSWORD);
    await page.getByRole('button',{name:'进入维护页面',exact:true}).click();
    await expect(page.locator('.v2-source-card')).toHaveCount(2);
    await page.screenshot({path:'/private/tmp/ypbi-sept12-real-maintenance.png'});
    await page.reload();await expect(page.locator('.v2-source-card')).toHaveCount(2);
  }
  expect(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('password')||v.includes('Token')))).toBe(false);
  expect(await auth.accountAdminService.disableAccount(username)).toMatchObject({changed:true});
  await page.reload();
  await expect(page.getByRole('heading',{name:'登录 YPBI',exact:true})).toBeVisible();
  expect(await auth.accountAdminService.enableAccount(username)).toMatchObject({changed:true});
  await page.getByLabel('账号',{exact:true}).fill(username);
  await page.getByLabel('密码',{exact:true}).fill(replacement);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByLabel('维护密码',{exact:true})).toBeVisible();
});
