import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dailyDashboardV2SuccessSchema, type DailyDashboardV2Success } from './contracts/daily-dashboard';

test.use({ channel: 'chrome', viewport: { width: 1440, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? 'http://127.0.0.1:5197';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('付费状态回归只允许本地隔离地址');
const bun = fileURLToPath(new URL('./data/local-runtime/node_modules/.bin/bun', import.meta.url));
const generated = JSON.parse(execFileSync(bun, ['--no-env-file', '-e', `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  const service = new DailyDashboardService({get:async()=>({code:200,msg:{pageData:[],totalData:[],totalCount:0},data:[]})},()=>new Date('2026-10-16T00:00:00Z'));
  const result = await service.execute({boardId:'5.10',pid:'PH',dateRange:['2026-09-02','2026-09-08']});
  process.stdout.write(JSON.stringify({result,catalog:dailyDashboardCatalog(true)}));
`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10000 })) as { result: DailyDashboardV2Success; catalog: unknown };

test('付费构成区保留真实来源状态及未接入分类，不用未产出归并', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const address = new URL(route.request().url()), path = address.pathname;
    if (address.origin !== new URL(base).origin) return route.abort('blockedbyclient');
    if (!path.startsWith('/api/')) return route.continue();
    if (path.endsWith('/auth/session')) return route.fulfill({ json: { success: true, data: {
      user: { subjectId: '00000000-0000-4000-8000-000000000001', username: 'qa.payment.states', displayName: '付费状态隔离验收', role: 'reader',
        permissions: ['bi:read', 'bi:export'], pidScope: 'all' }, expiresAt: '2099-01-01T00:00:00Z', csrfToken: 'a'.repeat(43), mustChangePassword: false
    } } });
    if (path.endsWith('/data-environment')) return route.fulfill({ json: { success: true, data: { mode: 'production', testAvailable: false, expiresAt: null, userName: null } } });
    if (path.endsWith('/catalog/readable-dashboards')) return route.fulfill({ json: generated.catalog });
    if (path.endsWith('/catalog/platforms')) return route.fulfill({ json: { success: true, data: { items: [{ id: 'qa-PH', pid: 'PH', name: 'Pornhub', order: 1 }] } } });
    if (!path.endsWith('/queries/dashboards/daily-reading')) return route.fulfill({ status: 404, json: { success: false, error: { code: 'NOT_FOUND', message: '隔离验收未配置此读取', requestId: 'qa-payment-state' } } });
    expect(route.request().postDataJSON()).toEqual({ boardId: '5.10', pid: 'PH', dateRange: ['2026-09-02', '2026-09-08'] });
    const result = structuredClone(generated.result);
    for (const id of ['M058', 'M058.new', 'M065', 'M066']) {
      const series = result.data.series.find(series => series.metric.id === id)!;
      series.metric.unit = '元';
      series.metric.inputs.forEach(input => { input.unit = '元'; });
      series.points.forEach(point => Object.assign(point, { value: null, state: 'no_value', sourceStatus: 'SOURCE_INCOMPLETE',
        inputs: series.metric.inputs.map(input => ({ key: input.key, value: null })) }));
    }
    dailyDashboardV2SuccessSchema.parse(result);
    return route.fulfill({ json: result });
  });
  await page.goto(`${base}/dashboards/public?board=5.10&pid=PH&start=2026-09-02&end=2026-09-08`);
  const composition = page.locator('section.composition-chart[aria-label="充值金额构成"]');
  await expect(composition.getByRole('listitem').filter({ hasText: '新用户' })).toContainText('来源不完整');
  await expect(composition.getByRole('listitem').filter({ hasText: '老用户' })).toContainText('切片待接入');
  await expect(composition).not.toContainText('未产出');
  await expect(composition.locator('.composition-chart__center')).toHaveCount(0);
  await expect(composition.getByRole('status')).toContainText('总充值金额：来源不完整');
  await composition.getByRole('listitem').filter({ hasText: '新用户' }).click();
  const detail = page.getByRole('dialog', { name: '充值金额构成 · 新用户', exact: true });
  await expect(detail).toContainText('来源不完整');
  await expect(detail).not.toContainText('未产出');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await composition.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('payment-composition-source-states.png') });
  expect(errors).toEqual([]);
});
