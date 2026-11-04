/**
 * /api/v1/me/resolvers routes against a real Postgres, with the ENS worker and auth stubbed.
 * Skipped unless RESOLVER_TEST_DATABASE_URL points at a local database whose name ends in
 * _test; its public schema is wiped and rebuilt from migrations 0011 and 0909.
 *
 *   RESOLVER_TEST_DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55440/grails_resolver_test \
 *     npx vitest run src/__tests__/me-resolvers.db.test.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { config } from '../../../shared/src/config';

const URL_ = process.env.RESOLVER_TEST_DATABASE_URL;
const safe = !!URL_ && /@(127\.0\.0\.1|localhost)(:\d+)?\/[a-z0-9_]+_test$/.test(URL_);

const { testPool } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pg = require('pg');
  const url = process.env.RESOLVER_TEST_DATABASE_URL;
  return { testPool: url ? new pg.Pool({ connectionString: url, max: 2 }) : null };
});

vi.mock('../../../shared/src', () => ({ getPostgresPool: () => testPool }));
vi.mock('../middleware/auth', () => ({
  requireAuth: async (request: any, reply: any) => {
    const id = request.headers['x-test-user'];
    if (!id) return reply.status(401).send({ success: false });
    request.user = { sub: String(id), address: String(request.headers['x-test-address']) };
  },
}));

import { meResolversRoutes } from '../routes/me-resolvers';

const ALICE = '0xc9c3a4337a1bba75d0860a1a81f7b990dc607334';
const R1 = '0x72d374ff9f8600cd386e1fd4c853564836de45b1';
const R2 = '0x8ff0b7968c04c3fb189b721363754c07be3ebfee';
const R3 = '0x41edc64aa5405884d9ffe00ce74f0577b09f7f10'; // only the namer role
const UNKNOWN = '0x0000000000000000000000000000000000000c00';
const KNOWN: Record<string, number> = { [R1]: 3, [R2]: 1, [R3]: 0 };
const R1_CHECKSUM = '0x72D374Ff9f8600cd386E1Fd4C853564836De45B1';

const record = (id: string) => ({ record_id: id, is_default: id === '3', names: [], records: [] });

/** Fake worker answering the /v2/resolvers routes from fixed data. */
function workerFetch(input: string) {
  const url = new URL(input);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/v2/resolvers') {
    const mine = url.searchParams.get('account') === ALICE;
    return json(200, {
      resolvers: mine
        ? [
            { address: R1, manages_records: true, record_count: 3 },
            { address: R2, manages_records: true, record_count: 1 },
            { address: R3, manages_records: false, record_count: 0 },
          ]
        : [],
    });
  }
  const m = url.pathname.match(/^\/v2\/resolvers\/(0x[0-9a-f]{40})(\/records)?$/);
  const count = m ? KNOWN[m[1]!] : undefined;
  if (!m || count === undefined) return json(404, { status: 404, error: 'Not Found' });
  const defaultId = m[1] === R1 ? '3' : null;
  if (!m[2]) return json(200, { address: m[1], record_count: count, default_record_id: defaultId });
  const limit = Number(url.searchParams.get('limit'));
  const offset = Number(url.searchParams.get('offset'));
  const ids = Array.from({ length: count }, (_, i) => String(i + 1)).slice(offset, offset + limit);
  return json(200, { resolver: m[1], record_count: count, default_record_id: defaultId, limit, offset, records: ids.map(record) });
}

describe.skipIf(!safe)('/api/v1/me/resolvers', () => {
  let app: FastifyInstance;
  let alice: number;
  let bob: number;
  const originalWorker = config.ensWorker.url;

  const call = (method: string, url: string, user: number | null, body?: unknown) =>
    app.inject({
      method: method as any,
      url: `/api/v1/me/resolvers${url}`,
      headers: user ? { 'x-test-user': String(user), 'x-test-address': user === alice ? ALICE : '0x00000000000000000000000000000000000000b0' } : {},
      ...(body === undefined ? {} : { payload: body as any }),
    });

  beforeAll(async () => {
    const dir = join(__dirname, '../../migrations/seq');
    await testPool!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await testPool!.query(readFileSync(join(dir, '0011_create_users_table.sql'), 'utf8'));
    await testPool!.query(readFileSync(join(dir, '0909_resolver_preferences.sql'), 'utf8'));
    app = Fastify();
    await app.register(meResolversRoutes, { prefix: '/api/v1/me/resolvers' });
  });
  afterAll(async () => {
    await app?.close();
    await testPool?.end();
  });
  beforeEach(async () => {
    await testPool!.query('TRUNCATE users RESTART IDENTITY CASCADE');
    const r = await testPool!.query(`INSERT INTO users (address) VALUES ($1), ('0x00000000000000000000000000000000000000b0') RETURNING id`, [ALICE]);
    [alice, bob] = r.rows.map((row: { id: number }) => row.id);
    config.ensWorker.url = 'https://worker.test';
    vi.stubGlobal('fetch', vi.fn(async (input: string) => workerFetch(input)));
  });
  afterEach(() => {
    config.ensWorker.url = originalWorker;
    vi.unstubAllGlobals();
  });

  it('requires auth', async () => {
    expect((await call('GET', '/', null)).statusCode).toBe(401);
  });

  it('labels resolvers, lists the preferred one first, and searches by label', async () => {
    expect((await call('PUT', `/${R2}/label`, alice, { label: '  Work  ' })).json().data).toEqual({ resolver: R2.toLowerCase(), label: 'Work' });
    expect((await call('PUT', `/${R1_CHECKSUM}/label`, alice, { label: 'Personal' })).statusCode).toBe(200);
    expect((await call('PUT', `/${R1}/label`, alice, { label: 'Personal names' })).statusCode).toBe(200); // rename

    expect((await call('PUT', '/preferred', alice, { address: R2 })).json().data).toEqual({ preferredResolver: R2 });
    const list = (await call('GET', '/', alice)).json().data;
    expect(list.resolvers.map((r: any) => [r.address, r.label, r.isPreferred])).toEqual([
      [R2, 'Work', true],
      [R1, 'Personal names', false],
      [R3, null, false],
    ]);
    expect(list.preferred).toEqual({ address: R2, label: 'Work', hasRoles: true });

    const search = (await call('GET', '/?q=PERSONAL', alice)).json().data;
    expect(search.resolvers.map((r: any) => r.address)).toEqual([R1]);

    // labels are private: bob sees none of alice's
    expect((await call('GET', '/', bob)).json().data).toEqual({ preferred: null, total: 0, resolvers: [] });

    expect((await call('DELETE', `/${R2}/label`, alice)).statusCode).toBe(200);
    expect((await call('DELETE', `/${R2}/label`, alice)).statusCode).toBe(404);
  });

  it('only accepts a preferred resolver the user can manage, and clears it with null', async () => {
    expect((await call('PUT', '/preferred', alice, { address: R3 })).json().error.code).toBe('NO_RESOLVER_ROLES');
    expect((await call('PUT', '/preferred', bob, { address: R1 })).statusCode).toBe(400);
    expect((await call('PUT', '/preferred', alice, { address: 'nope' })).statusCode).toBe(400);
    expect((await call('PUT', '/preferred', alice, { address: R1_CHECKSUM })).json().data.preferredResolver).toBe(R1);
    expect((await call('PUT', '/preferred', alice, { address: null })).json().data.preferredResolver).toBeNull();
    const row = await testPool!.query('SELECT preferred_resolver FROM users WHERE id = $1', [alice]);
    expect(row.rows[0].preferred_resolver).toBeNull();
  });

  it('labels records and searches them by label', async () => {
    expect((await call('PUT', `/${R1}/records/3/label`, alice, { label: 'Default profile' })).statusCode).toBe(200);
    expect((await call('PUT', `/${R1}/records/1/label`, alice, { label: '50%_off' })).statusCode).toBe(200);
    expect((await call('PUT', `/${R1}/records/4/label`, alice, { label: 'x' })).json().error.code).toBe('RECORD_NOT_FOUND');
    expect((await call('PUT', `/${UNKNOWN}/records/1/label`, alice, { label: 'x' })).json().error.code).toBe('RESOLVER_NOT_FOUND');
    expect((await call('PUT', `/${UNKNOWN}/label`, alice, { label: 'x' })).json().error.code).toBe('RESOLVER_NOT_FOUND');
    expect((await call('PUT', `/${R1}/records/0/label`, alice, { label: 'x' })).statusCode).toBe(400);
    expect((await call('PUT', `/${R1}/records/1/label`, alice, { label: '' })).statusCode).toBe(400);
    expect((await call('PUT', `/${R1}/records/1/label`, alice, { label: 'x'.repeat(65) })).statusCode).toBe(400);

    const page = (await call('GET', `/${R1}/records?limit=2&offset=1`, alice)).json().data;
    expect(page).toMatchObject({ resolver: R1, recordCount: 3, defaultRecordId: '3', total: 3, limit: 2, offset: 1 });
    expect(page.records.map((r: any) => [r.recordId, r.label, r.record.record_id])).toEqual([
      ['2', null, '2'],
      ['3', 'Default profile', '3'],
    ]);

    const found = (await call('GET', `/${R1}/records?q=default`, alice)).json().data;
    expect([found.total, found.records.map((r: any) => [r.recordId, r.label, r.record.record_id])]).toEqual([1, [['3', 'Default profile', '3']]]);
    expect((await call('GET', `/${R1}/records?q=%25`, alice)).json().data.total).toBe(1); // '%' matches literally
    expect((await call('GET', `/${R1}/records?q=default`, bob)).json().data.total).toBe(0);
    expect((await call('GET', `/${UNKNOWN}/records`, alice)).statusCode).toBe(404);

    expect((await call('DELETE', `/${R1}/records/3/label`, alice)).statusCode).toBe(200);
    expect((await call('GET', `/${R1}/records?q=default`, alice)).json().data.total).toBe(0);
  });

  it('answers 503 when the worker is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    const r = await call('GET', '/', alice);
    expect([r.statusCode, r.json().error.code]).toEqual([503, 'ENS_WORKER_UNAVAILABLE']);
  });
});
