/**
 * `smol()` against a mocked `smolmachines` and a stubbed `fetch` standing in
 * for Chromium's DevTools and smol cloud: the warm machine an attempt-scope
 * run boots once per slot and branches per attempt, `prepare` and `setup`,
 * the host-port relays, the app in the machine, worker scope, cleanup after
 * a failed boot, `sweep`, downloads, and the cloud target with its connect
 * token.
 */

import path from 'node:path';
import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smol } from '../../src/index.ts';

const sdk = vi.hoisted(() => {
  const state = {
    created: [] as { config: Record<string, unknown>; conn: Record<string, unknown> }[],
    scripts: [] as { machine: string; script: string }[],
    branches: [] as { source: string; name: string; options: unknown }[],
    deleted: [] as string[],
    files: [] as { machine: string; path: string }[],
    written: [] as { machine: string; path: string; bytes: number }[],
    machines: [] as { name: string; id: string }[],
    exitCode: 0,
    deleteFailures: new Map<string, Error>(),
    nextHostPort: 41_000,
  };
  class Machine {
    readonly id: string;
    constructor(
      readonly name: string,
      readonly conn: Record<string, unknown>,
      readonly hostPort: number,
    ) {
      this.id = conn.target === 'cloud' ? `mach-${name}` : name;
      state.machines.push({ name, id: this.id });
    }
    static async create(config: Record<string, unknown>, conn: Record<string, unknown>): Promise<Machine> {
      state.created.push({ config, conn });
      return new Machine(config.name as string, conn, (config.ports as { host: number }[])[0]!.host);
    }
    static async connect(id: string, conn: Record<string, unknown>): Promise<Machine> {
      const known = state.machines.find((machine) => machine.id === id);
      if (known === undefined) throw new Error(`machine not found: ${id}`);
      const machine = Object.create(Machine.prototype) as Machine;
      Object.assign(machine, { name: known.name, id, conn, hostPort: 0 });
      return machine;
    }
    static async list(): Promise<{ name: string; id: string }[]> {
      return state.machines.map((machine) => ({ ...machine }));
    }
    endpoint(port: number, sub = ''): { httpUrl: string; wsUrl: string; headers: Record<string, string> } {
      const rest = sub.replace(/^\/+/, '');
      if (this.conn.target === 'cloud') {
        const httpUrl = `https://cloud.test/v1/machines/${this.id}/connect/${port}${rest === '' ? '' : `/${rest}`}`;
        return { httpUrl, wsUrl: httpUrl.replace('https://', 'wss://'), headers: { authorization: `Bearer ${String(this.conn.apiKey)}` } };
      }
      const httpUrl = `http://127.0.0.1:${this.hostPort}/${rest}`;
      return { httpUrl, wsUrl: httpUrl.replace('http://', 'ws://'), headers: {} };
    }
    async exec(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      state.scripts.push({ machine: this.name, script: command[2] ?? '' });
      return { exitCode: state.exitCode, stdout: '', stderr: state.exitCode === 0 ? '' : 'chromium did not start:\nno display' };
    }
    async writeFile(file: string, bytes: Buffer): Promise<void> {
      state.written.push({ machine: this.name, path: file, bytes: bytes.length });
    }
    async branch(name: string, options?: unknown): Promise<Machine> {
      state.branches.push({ source: this.name, name, options });
      state.nextHostPort += 1;
      return new Machine(name, this.conn, state.nextHostPort);
    }
    async delete(): Promise<void> {
      const failure = state.deleteFailures.get(this.name);
      if (failure !== undefined) throw failure;
      state.deleted.push(this.id);
      state.machines = state.machines.filter((machine) => machine.id !== this.id);
    }
    async readFile(file: string): Promise<Buffer> {
      state.files.push({ machine: this.id, path: file });
      return Buffer.from('file bytes');
    }
  }
  return { state, Machine };
});

vi.mock('smolmachines', () => ({ Machine: sdk.Machine }));

const fetched: { url: string; method: string; headers: Record<string, string>; body: string | undefined }[] = [];

beforeEach(() => {
  Object.assign(sdk.state, {
    created: [],
    scripts: [],
    branches: [],
    deleted: [],
    files: [],
    written: [],
    machines: [],
    exitCode: 0,
    deleteFailures: new Map(),
    nextHostPort: 41_000,
  });
  fetched.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    fetched.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined });
    if (url.endsWith('/connect-token')) return Response.json({ token: 'smk_connect_1', expiresAt: '2026-10-07T12:00:00Z', machineId: 'x' }, { status: 201 });
    // Chromium names its endpoint by the Host nginx sends it, never the address the client used.
    return Response.json({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/b-1' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'run-1',
    targetName: 'web',
    slot: 0,
    slots: 2,
    env: {},
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

function releaseContext(overrides: Partial<BrowserReleaseContext> = {}): BrowserReleaseContext {
  return { runId: 'run-1', targetName: 'web', env: {}, signal: new AbortController().signal, log: () => undefined, ...overrides };
}

const cloudEnv = { SMOL_CLOUD_TOKEN: ' smk_account ' };

describe('smol()', () => {
  it('boots one warm browser per slot, prepares it once, and branches it for every attempt', async () => {
    const prepared: string[] = [];
    const provider = smol({ cpus: 4, memoryMb: 4096, prepare: async (endpoint) => void prepared.push(endpoint) });
    const first = request({ attemptId: 'a1' });
    const lease1 = await provider.acquire(first);
    const lease2 = await provider.acquire(request({ attemptId: 'a2' }));

    expect(sdk.state.created).toHaveLength(1);
    const { config, conn } = sdk.state.created[0]!;
    expect(conn).toEqual({ target: 'local', handleSignals: false });
    expect(config).toMatchObject({
      image: 'nginx:alpine',
      network: true,
      branchable: true,
      persistent: false,
      resources: { cpus: 4, memoryMb: 4096 },
      labels: { e2e_run: 'run-1', e2e_target: 'web' },
    });
    const [port] = config.ports as { host: number; guest: number }[];
    expect(port!.guest).toBe(80);
    const warm = config.name as string;
    expect(warm).toMatch(/^e2e-[0-9a-f]{8}-w0$/);
    // The DevTools endpoint is built from the machine's own address and Chromium's path, not Chromium's idea of its host.
    expect(prepared).toEqual([`ws://127.0.0.1:${port!.host}/devtools/browser/b-1`]);

    expect(sdk.state.branches.map(({ source }) => source)).toEqual([warm, warm]);
    // A branch keeps the source's published port, remapped by the engine, never pinned.
    expect(sdk.state.branches.map(({ options }) => options)).toEqual([undefined, undefined]);
    expect(lease1.id).not.toBe(lease2.id);
    expect(lease1).toEqual({ id: sdk.state.branches[0]!.name, cdpEndpoint: 'ws://127.0.0.1:41001/devtools/browser/b-1' });
    expect(lease2).toEqual({ id: sdk.state.branches[1]!.name, cdpEndpoint: 'ws://127.0.0.1:41002/devtools/browser/b-1' });
    expect(lease1.id.startsWith(`${warm}-`)).toBe(true);
    expect(fetched.map(({ url }) => url)).toContain('http://127.0.0.1:41001/json/version');
    expect(first.lines).toEqual([expect.stringMatching(new RegExp(`^browser ${lease1.id}, branched from ${warm} in \\d+ ms$`))]);
  });

  it('runs setup before Chromium starts, relays each host port to the machine’s loopback, and sends Chromium Host: localhost', async () => {
    await smol({ setup: 'apk add --no-cache font-noto-cjk', hostPorts: [3000, 4271] }).acquire(request({ attemptId: 'a1' }));
    const script = sdk.state.scripts[0]!.script;
    const order = ['apk add --no-cache chromium', 'font-noto-cjk', 'TCP-LISTEN:3000,fork,reuseaddr,bind=127.0.0.1 TCP:host.smolvm.internal:3000', 'TCP-LISTEN:4271', 'chromium --headless=new', 'nginx -s reload'];
    const positions = order.map((needle) => script.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(script).toContain('proxy_set_header Host localhost;');
  });

  it('copies the app in, sets it up, starts it, and waits for it before prepare, all inside the machine', async () => {
    const prepared: string[] = [];
    await smol({
      app: { source: 'web', setup: 'apk add --no-cache nodejs', start: "node server.mjs --name 'demo'", port: 3000, env: { DATABASE_URL: "file:/app/db.sqlite?x='1'" } },
      prepare: async (endpoint) => void prepared.push(endpoint),
    }).acquire(request({ attemptId: 'a1' }));
    const { config } = sdk.state.created[0]!;
    expect(config.mounts).toEqual([{ source: path.resolve('web'), target: '/e2e-source', readOnly: true }]);
    expect(sdk.state.written).toEqual([]);
    expect(sdk.state.scripts).toHaveLength(2);
    const script = sdk.state.scripts[1]!.script;
    const order = [
      String.raw`export DATABASE_URL='file:/app/db.sqlite?x='\''1'\'''`,
      'tar -C /e2e-source --exclude=./node_modules --exclude=./.git --exclude=./.e2e -cf - . | tar -C /app -xf -',
      'cd /app',
      'apk add --no-cache nodejs',
      String.raw`nohup setsid sh -c 'node server.mjs --name '\''demo'\''' </dev/null >/tmp/e2e-app.log 2>&1 &`,
      'http://127.0.0.1:3000/',
    ];
    const positions = order.map((needle) => script.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(prepared).toHaveLength(1);
  });

  it('refuses an app port the browser uses or that hostPorts also relays', () => {
    expect(() => smol({ app: { start: 'x', port: 80 } })).toThrow(/other than 80 and 9229/);
    expect(() => smol({ app: { start: 'x', port: 9229 } })).toThrow(/other than 80 and 9229/);
    expect(() => smol({ app: { start: 'x', port: 3000 }, hostPorts: [3000] })).toThrow(/both app.port and in hostPorts/);
  });

  it('refuses host ports the browser uses or that are not ports, before anything reaches a shell', () => {
    expect(() => smol({ hostPorts: [80] })).toThrow(/hostPorts entry must be a port from 1 to 65535 other than 80 and 9229, which the browser uses; got 80/);
    expect(() => smol({ hostPorts: ['3000; reboot' as unknown as number] })).toThrow(/hostPorts entry must be a port/);
    expect(() => smol({ hostPorts: [0] })).toThrow(/hostPorts entry must be a port/);
  });

  it('refuses an app.env name that is not a shell variable name', () => {
    expect(() => smol({ app: { start: 'x', port: 3000, env: { 'A B': '1' } } })).toThrow(/app.env name "A B" is not a shell variable name/);
    expect(() => smol({ app: { start: 'x', port: 3000, env: { '1X': '1' } } })).toThrow(/not a shell variable name/);
    expect(() => smol({ app: { start: 'x', port: 3000, env: { DATABASE_URL: 'x' } } })).not.toThrow();
  });

  it('boots a browser per slot without branching in worker scope, and deletes it on release', async () => {
    const provider = smol({ scope: 'worker' });
    const lease = await provider.acquire(request({ slot: 1 }));
    expect(lease.id).toMatch(/^e2e-[0-9a-f]{8}-s1$/);
    expect(sdk.state.created[0]!.config).toMatchObject({ persistent: true });
    expect(sdk.state.branches).toEqual([]);
    expect(provider.scope).toBe('worker');
    await provider.release(lease, releaseContext());
    expect(sdk.state.deleted).toEqual([lease.id]);
  });

  it('refuses prepare in worker scope, where every attempt gets a new browser context', () => {
    expect(() => smol({ scope: 'worker', prepare: async () => undefined })).toThrow(/prepare needs scope "attempt"/);
  });

  it('deletes only the branch when an attempt ends, keeping the warm browser for the next one', async () => {
    const provider = smol();
    const lease = await provider.acquire(request({ attemptId: 'a1' }));
    await provider.release(lease, releaseContext());
    expect(sdk.state.deleted).toEqual([lease.id]);
    await provider.acquire(request({ attemptId: 'a2' }));
    expect(sdk.state.created).toHaveLength(1);
  });

  it('deletes a machine whose browser does not start, and boots again on the next attempt', async () => {
    const provider = smol();
    sdk.state.exitCode = 1;
    await expect(provider.acquire(request({ attemptId: 'a1' }))).rejects.toThrow(/command exited 1: chromium did not start:; no display/);
    expect(sdk.state.deleted).toEqual([sdk.state.created[0]!.config.name]);
    sdk.state.exitCode = 0;
    await provider.acquire(request({ attemptId: 'a2' }));
    expect(sdk.state.created).toHaveLength(2);
  });

  it('sweeps the run and target’s machines, branches before their source, and names what it could not delete', async () => {
    const provider = smol();
    const lease = await provider.acquire(request({ attemptId: 'a1' }));
    const warm = sdk.state.created[0]!.config.name as string;
    sdk.state.machines.push({ name: 'e2e-ffffffff-w0', id: 'e2e-ffffffff-w0' }, { name: 'someone-elses', id: 'someone-elses' });
    expect(await provider.sweep!(releaseContext())).toEqual([lease.id, warm]);
    expect(sdk.state.machines.map(({ name }) => name)).toEqual(['e2e-ffffffff-w0', 'someone-elses']);

    await provider.acquire(request({ attemptId: 'a2', runId: 'run-2' }));
    const stuck = sdk.state.created[1]!.config.name as string;
    sdk.state.deleteFailures.set(stuck, new Error('busy'));
    vi.useFakeTimers();
    try {
      const sweep = expect(provider.sweep!(releaseContext({ runId: 'run-2' }))).rejects.toThrow(`could not delete ${stuck} (busy)`);
      await vi.runAllTimersAsync();
      await sweep;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a delete that fails while the engine is still stopping a machine', async () => {
    const provider = smol();
    await provider.acquire(request({ attemptId: 'a1' }));
    const warm = sdk.state.created[0]!.config.name as string;
    const branch = sdk.state.branches[0]!.name;
    sdk.state.deleteFailures.set(warm, new Error('guest did not confirm filesystem synchronization'));
    vi.useFakeTimers();
    try {
      const sweep = provider.sweep!(releaseContext());
      await vi.advanceTimersByTimeAsync(1);
      sdk.state.deleteFailures.delete(warm);
      await vi.runAllTimersAsync();
      expect(await sweep).toEqual([branch, warm]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a download off the leased browser’s disk', async () => {
    const provider = smol();
    const lease = await provider.acquire(request({ attemptId: 'a1' }));
    const bytes = await provider.downloads!.read(lease, '/tmp/e2e-downloads/report.csv', { runId: 'run-1', targetName: 'web', env: {}, signal: new AbortController().signal });
    expect(new TextDecoder().decode(bytes)).toBe('file bytes');
    expect(sdk.state.files).toEqual([{ machine: lease.id, path: '/tmp/e2e-downloads/report.csv' }]);
    expect(provider.downloads!.dir).toBe('/tmp/e2e-downloads');
  });
});

describe('smol({ target: "cloud" })', () => {
  it('runs on smol cloud with the run’s key, and reaches every browser through one connect token', async () => {
    const prepared: string[] = [];
    const provider = smol({ target: 'cloud', prepare: async (endpoint) => void prepared.push(endpoint) });
    const lease1 = await provider.acquire(request({ attemptId: 'a1', env: { ...cloudEnv, SMOL_CLOUD_URL: 'https://cloud.test' } }));
    const lease2 = await provider.acquire(request({ attemptId: 'a2', env: { ...cloudEnv, SMOL_CLOUD_URL: 'https://cloud.test' } }));

    const { config, conn } = sdk.state.created[0]!;
    expect(conn).toEqual({ target: 'cloud', apiKey: 'smk_account', baseUrl: 'https://cloud.test' });
    // Nothing local-only reaches the cloud.
    expect(config).not.toHaveProperty('labels');
    expect(config).not.toHaveProperty('persistent');
    expect(config).not.toHaveProperty('mounts');
    const warm = `mach-${String(config.name)}`;

    // One token, minted for the warm browser with the account key; it opens that browser's branches too.
    const mints = fetched.filter(({ method }) => method === 'POST');
    expect(mints).toEqual([
      {
        url: `https://cloud.test/v1/machines/${warm}/connect-token`,
        method: 'POST',
        headers: { authorization: 'Bearer smk_account', 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 43_200 }),
      },
    ]);
    expect(prepared).toEqual([`wss://cloud.test/v1/machines/${warm}/connect/80/devtools/browser/b-1?access_token=smk_connect_1`]);
    expect(lease1).toEqual({
      id: `mach-${sdk.state.branches[0]!.name}`,
      cdpEndpoint: `wss://cloud.test/v1/machines/mach-${sdk.state.branches[0]!.name}/connect/80/devtools/browser/b-1?access_token=smk_connect_1`,
    });
    expect(lease2.cdpEndpoint).toContain(`/v1/machines/mach-${sdk.state.branches[1]!.name}/connect/80/`);
    // The account key never appears in a lease, only the narrow token.
    expect(JSON.stringify([lease1, lease2, prepared])).not.toContain('smk_account');
  });

  it('uploads the app source as an archive, since a cloud machine cannot mount this computer', async () => {
    await smol({ target: 'cloud', app: { source: 'src', start: 'node server.mjs', port: 3000 } }).acquire(request({ attemptId: 'a1', env: cloudEnv }));
    expect(sdk.state.created[0]!.config).not.toHaveProperty('mounts');
    expect(sdk.state.written).toEqual([{ machine: sdk.state.created[0]!.config.name, path: '/tmp/e2e-source.tar', bytes: expect.any(Number) }]);
    expect(sdk.state.written[0]!.bytes).toBeGreaterThan(0);
    expect(sdk.state.scripts[1]!.script).toContain('tar -C /app -xf /tmp/e2e-source.tar && rm -f /tmp/e2e-source.tar');
  });

  it('needs SMOL_CLOUD_TOKEN from the run’s environment, never this process’s', async () => {
    vi.stubEnv('SMOL_CLOUD_TOKEN', 'smk_from_process');
    try {
      await expect(smol({ target: 'cloud' }).acquire(request({ attemptId: 'a1' }))).rejects.toThrow('SMOL_CLOUD_TOKEN is not set');
      expect(sdk.state.created).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails the boot with the cloud’s reason when a connect token is refused, and deletes the machine', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/connect-token') ? new Response('{"code":"forbidden"}', { status: 403 }) : Response.json({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/b-1' }),
    );
    await expect(smol({ target: 'cloud' }).acquire(request({ attemptId: 'a1', env: cloudEnv }))).rejects.toThrow(/refused a connect token for machine .*: HTTP 403 \{"code":"forbidden"\}/);
    expect(sdk.state.deleted).toEqual([`mach-${String(sdk.state.created[0]!.config.name)}`]);
  });

  it('refuses hostPorts and an unknown target, which a cloud machine cannot honor', () => {
    expect(() => smol({ target: 'cloud', hostPorts: [3000] })).toThrow(/a cloud machine cannot reach it/);
    expect(() => smol({ target: 'moon' as 'cloud' })).toThrow(/target must be "local" or "cloud"/);
  });
});
