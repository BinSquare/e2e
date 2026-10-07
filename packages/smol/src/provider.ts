/** Chromium in smol machines as a `BrowserProvider` for the web engine. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { ConfigurationError } from 'e2e/engine';
import { smolMachines, type SmolMachine, type SmolMachines, type SmolTarget } from './machines.ts';

/**
 * The machine boots nginx, which listens on this port from the first moment:
 * a machine counts as started only once its published port answers, and a
 * branch's published port reaches its guest only when its source published
 * that port too. Once Chromium is up, nginx is reloaded to relay DevTools,
 * keeping the same listening socket.
 */
const IMAGE = 'nginx:alpine';
const GUEST_PORT = 80;
/** Chromium's new headless mode binds DevTools to loopback whatever it is told, hence the relay. */
const CHROMIUM_CDP_PORT = 9229;

/** Where each browser saves downloads on its machine's own disk, read back through the SDK. */
const DOWNLOADS_DIR = '/tmp/e2e-downloads';

const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

/** How long a new browser has to answer on its DevTools endpoint. */
const CDP_READY_MS = 60_000;

/** How often, and how far apart, `sweep` tries to delete one machine. */
const SWEEP_ATTEMPTS = 5;
const SWEEP_RETRY_MS = 2_000;

/** Where the app's source is mounted (local) or uploaded (cloud), and where the copy it runs from lives. */
const APP_SOURCE_MOUNT = '/e2e-source';
const APP_SOURCE_ARCHIVE = '/tmp/e2e-source.tar';
const APP_DIR = '/app';
const APP_LOG = '/tmp/e2e-app.log';
/** How long the app has to answer after `start`, in seconds. */
const APP_READY_SECONDS = 180;
/** What the copy of `app.source` leaves out, so dependencies install for the machine's Linux. */
const SOURCE_EXCLUDES = ['./node_modules', './.git', './.e2e'];

/** The smol cloud API key, read from the run's environment for `target: 'cloud'`. */
const SMOL_CLOUD_TOKEN = 'SMOL_CLOUD_TOKEN';
/** Optional smol cloud base URL, read from the run's environment; the SDK's default otherwise. */
const SMOL_CLOUD_URL = 'SMOL_CLOUD_URL';
/**
 * How long a cloud browser's connect token lasts: the token in every lease's
 * DevTools URL, which opens only that browser and its branches. Longer than
 * a run, within the cloud's one-day cap.
 */
const CONNECT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * An app that runs inside each browser machine, beside the browser, instead
 * of on this computer. In `attempt` scope every attempt's branch then holds
 * its own copy of the running app and everything it wrote to disk, a
 * database included.
 */
export interface SmolApp {
  /**
   * Directory on this computer copied into the machine at `/app`, resolved
   * against the directory the run starts in; `.` by default. `node_modules`,
   * `.git`, and `.e2e` are left out, so dependencies install for the
   * machine's Linux in `setup`.
   */
  readonly source?: string | undefined;
  /**
   * Shell script run as root in `/app` once per browser machine, before
   * `start`: install a runtime and dependencies, create and seed a
   * database. The image is Alpine Linux (`apk add --no-cache nodejs npm`).
   */
  readonly setup?: string | undefined;
  /** Shell command that serves the app, run in `/app` in the background: `node server.mjs`, `npm start`. */
  readonly start: string;
  /** Port the app listens on inside the machine; the browser opens it as `http://localhost:<port>`. */
  readonly port: number;
  /** Environment for `setup` and `start`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface SmolOptions {
  /**
   * `local` (default): machines run on this computer's smol engine. `cloud`:
   * machines run on smol cloud, with the API key in `SMOL_CLOUD_TOKEN` (and
   * an optional `SMOL_CLOUD_URL`) from the run's environment; each browser is
   * reached through a connect token that opens only that browser and its
   * branches.
   */
  readonly target?: 'local' | 'cloud' | undefined;
  /**
   * `attempt` (default): every test attempt gets its own branch of a warm
   * browser machine, a copy-on-write clone of the running Chromium made in
   * under a second, deleted when the attempt ends. `worker`: one browser
   * machine per worker slot for the run, no branching.
   */
  readonly scope?: BrowserProviderScope | undefined;
  /**
   * Shell script run as root once per browser machine, before Chromium
   * starts, in an Alpine `nginx:alpine` image: `apk add --no-cache
   * font-noto-cjk` for more fonts, a CA certificate, a hosts entry.
   */
  readonly setup?: string | undefined;
  /** vCPUs per browser machine, 2 by default. */
  readonly cpus?: number | undefined;
  /** Memory per browser machine in MiB, 2048 by default. Unused memory goes back to the host. */
  readonly memoryMb?: number | undefined;
  /**
   * Local only: ports on this computer's loopback the browser reaches as its
   * own `localhost`, so an app the run serves at `http://localhost:3000`
   * opens unchanged inside the machine.
   */
  readonly hostPorts?: readonly number[] | undefined;
  /**
   * Drives the warm browser once before any attempt branches it: sign in,
   * seed storage, open the app. Every attempt then starts from that state.
   * It gets the browser's DevTools WebSocket endpoint and must disconnect,
   * not close the browser, before it resolves. Runs once per worker slot.
   * `attempt` scope only: in `worker` scope every attempt gets a new browser
   * context, which would never see it.
   */
  readonly prepare?: ((cdpEndpoint: string) => Promise<void>) | undefined;
  /**
   * Runs the app under test inside each browser machine instead of on this
   * computer: its code never runs on the host, and every attempt gets its
   * own copy of the running app and its data. Point the target's `app.url`
   * at `http://localhost:<port>` and declare no `app.command`.
   */
  readonly app?: SmolApp | undefined;
}

/** A browser machine, the path of its DevTools endpoint, and the connect token a cloud browser is reached with. */
interface Browser {
  readonly machine: SmolMachine;
  readonly devtoolsPath: string;
  readonly connectToken: string | undefined;
}

/** A short stable digest, for machine names the engine's socket paths can hold. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** A port on this computer's loopback that nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * Waits until the machine's browser answers on DevTools and resolves to the
 * path of its browser endpoint (`/devtools/browser/<id>`), the same in every
 * branch of it. Rejects after `CDP_READY_MS` or on `signal`.
 */
async function devtoolsPath(machine: SmolMachine, signal: AbortSignal): Promise<string> {
  const { httpUrl, headers } = machine.endpoint(GUEST_PORT, 'json/version');
  const deadline = Date.now() + CDP_READY_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(httpUrl, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
      if (response.ok) {
        const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: unknown };
        if (typeof webSocketDebuggerUrl === 'string') return new URL(webSocketDebuggerUrl).pathname;
        last = 'no webSocketDebuggerUrl in /json/version';
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (cause) {
      signal.throwIfAborted();
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`browser in machine ${machine.name} did not answer on DevTools within ${CDP_READY_MS / 1000}s (${last})`);
}

/** The DevTools WebSocket URL a client attaches to: the machine's own endpoint, with the connect token a cloud browser needs. */
function cdpEndpoint(browser: Browser, machine: SmolMachine = browser.machine): string {
  const { wsUrl } = machine.endpoint(GUEST_PORT, browser.devtoolsPath);
  if (browser.connectToken === undefined) return wsUrl;
  // A WebSocket client cannot send the bridge an Authorization header; the cloud takes the token in the query instead.
  return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(browser.connectToken)}`;
}

/** Mints a cloud connect token that opens only `machine`'s connect bridge and its branches'. */
async function mintConnectToken(machine: SmolMachine, signal: AbortSignal): Promise<string> {
  const { httpUrl, headers } = machine.endpoint(GUEST_PORT);
  const base = httpUrl.slice(0, httpUrl.indexOf('/v1/machines/'));
  const response = await fetch(`${base}/v1/machines/${encodeURIComponent(machine.id)}/connect-token`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ttlSeconds: CONNECT_TOKEN_TTL_SECONDS }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
    throw new Error(`smol cloud refused a connect token for machine ${machine.name}: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`);
  }
  const { token } = (await response.json()) as { token?: unknown };
  if (typeof token !== 'string' || token === '') throw new Error(`smol cloud answered a connect token request for machine ${machine.name} without a token`);
  return token;
}

/** Runs `command` in the background, past the end of the exec that starts it. */
function detached(command: string, log = '/dev/null'): string {
  return `nohup setsid ${command} </dev/null >${log} 2>&1 &`;
}

/**
 * nginx relaying DevTools, WebSocket upgrades included. It sends Chromium
 * `Host: localhost`, which Chromium's DevTools host check accepts whatever
 * address the client reached the machine at; clients get their endpoint
 * from the SDK, never from Chromium.
 */
const NGINX_CONF = `map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen ${GUEST_PORT};
  location / {
    proxy_pass http://127.0.0.1:${CHROMIUM_CDP_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host localhost;
    proxy_buffering off;
    proxy_read_timeout 1d;
  }
}`;

/** The script that installs Chromium, runs `setup`, starts Chromium and the relays to the host's ports, and points nginx at it. */
function startScript(setup: string | undefined, hostPorts: readonly number[]): string {
  return [
    'set -e',
    'apk add --no-cache chromium socat ttf-freefont >/dev/null',
    ...(setup === undefined ? [] : [setup]),
    `mkdir -p ${DOWNLOADS_DIR}`,
    // The machine's loopback is its own; the host's is behind host.smolvm.internal.
    ...hostPorts.map((port) => detached(`socat TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1 TCP:host.smolvm.internal:${port}`)),
    detached(
      `chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --remote-debugging-port=${CHROMIUM_CDP_PORT} --user-data-dir=/tmp/e2e-chromium about:blank`,
      '/tmp/e2e-chromium.log',
    ),
    `ready=; for i in $(seq 300); do if wget -qO- -T 1 http://127.0.0.1:${CHROMIUM_CDP_PORT}/json/version >/dev/null 2>&1; then ready=1; break; fi; sleep 0.1; done`,
    '[ -n "$ready" ] || { echo "chromium did not start:" >&2; tail -5 /tmp/e2e-chromium.log >&2; exit 1; }',
    `cat > /etc/nginx/conf.d/default.conf <<'EOF'\n${NGINX_CONF}\nEOF`,
    'nginx -s reload',
  ].join('\n');
}

/** A shell variable name, the only form `app.env` names are exported under. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuses a port the machine cannot give the browser's `localhost`: out of range, or one the browser itself uses. */
function checkPort(what: string, port: unknown): void {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535 || port === GUEST_PORT || port === CHROMIUM_CDP_PORT) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `smol: ${what} must be a port from 1 to 65535 other than ${GUEST_PORT} and ${CHROMIUM_CDP_PORT}, which the browser uses; got ${JSON.stringify(port)}`,
    );
  }
}

/** `value` as one single-quoted shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** `app.source` as a tar archive, for a cloud machine that cannot mount this computer's disk. */
async function archiveSource(source: string): Promise<Uint8Array> {
  const { stdout } = await promisify(execFile)('tar', ['-C', source, ...SOURCE_EXCLUDES.map((e) => `--exclude=${e}`), '-cf', '-', '.'], {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  });
  return stdout;
}

/**
 * The script that copies the app in, from the mounted source (local) or the
 * uploaded archive (cloud), runs its `setup`, starts it, and waits until it
 * answers.
 */
function appScript(app: SmolApp, from: 'mount' | 'archive'): string {
  const exports = Object.entries(app.env ?? {}).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  const copy =
    from === 'mount'
      ? `tar -C ${APP_SOURCE_MOUNT} ${SOURCE_EXCLUDES.map((e) => `--exclude=${e}`).join(' ')} -cf - . | tar -C ${APP_DIR} -xf -`
      : `tar -C ${APP_DIR} -xf ${APP_SOURCE_ARCHIVE} && rm -f ${APP_SOURCE_ARCHIVE}`;
  return [
    'set -e',
    ...exports,
    `mkdir -p ${APP_DIR}`,
    copy,
    `cd ${APP_DIR}`,
    ...(app.setup === undefined ? [] : [app.setup]),
    detached(`sh -c ${shellQuote(app.start)}`, APP_LOG),
    // Any HTTP answer counts, as for app.command's readyUrl: wget exits 8 on a 4xx or 5xx.
    `ready=; for i in $(seq ${APP_READY_SECONDS * 4}); do rc=0; wget -q -O /dev/null -T 1 http://127.0.0.1:${app.port}/ >/dev/null 2>&1 || rc=$?; if [ $rc -eq 0 ] || [ $rc -eq 8 ]; then ready=1; break; fi; sleep 0.25; done`,
    `[ -n "$ready" ] || { echo "the app did not answer on port ${app.port} within ${APP_READY_SECONDS}s:" >&2; tail -20 ${APP_LOG} >&2; exit 1; }`,
  ].join('\n');
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Chromium in smol machines for `web({ browser: smol() })`. Each worker slot
 * boots one browser machine, on this computer's smol engine or on smol cloud,
 * and, with `prepare`, drives it into the state tests start from. In
 * `attempt` scope (the default) every attempt then gets a live copy-on-write
 * branch of that running browser, cookies, storage, and open pages included,
 * and the branch is deleted when the attempt ends. Machines are named after
 * the run and target, so `sweep` deletes what a dead worker left.
 */
export function smol(options: SmolOptions = {}): BrowserProvider {
  const { target = 'local', scope = 'attempt', setup, cpus = DEFAULT_CPUS, memoryMb = DEFAULT_MEMORY_MB, hostPorts = [], prepare, app } = options;
  if (target !== 'local' && target !== 'cloud') {
    throw new ConfigurationError('INVALID_CONFIG', `smol: target must be "local" or "cloud"; got ${JSON.stringify(target)}`);
  }
  for (const port of hostPorts) checkPort(`hostPorts entry`, port);
  if (target === 'cloud' && hostPorts.length > 0) {
    throw new ConfigurationError('INVALID_CONFIG', "smol: hostPorts relays this computer's loopback into a local machine; a cloud machine cannot reach it, so run the app in the machine with app, or serve it at a public URL");
  }
  if (app !== undefined) {
    checkPort('app.port', app.port);
    for (const name of Object.keys(app.env ?? {})) {
      if (!ENV_NAME.test(name)) {
        throw new ConfigurationError('INVALID_CONFIG', `smol: app.env name ${JSON.stringify(name)} is not a shell variable name (letters, digits, and _, not starting with a digit)`);
      }
    }
    if (hostPorts.includes(app.port)) {
      throw new ConfigurationError('INVALID_CONFIG', `smol: port ${app.port} is both app.port and in hostPorts; the browser's localhost:${app.port} can be only one of them`);
    }
  }
  const appSource = app === undefined ? undefined : path.resolve(app.source ?? '.');
  if (prepare !== undefined && scope === 'worker') {
    // A worker-scope browser gives every attempt a new context, which never sees what prepare left in the default one.
    throw new ConfigurationError('INVALID_CONFIG', 'smol: prepare needs scope "attempt"; with scope "worker" every attempt gets a new browser context, so use sessions there');
  }

  /** One SDK binding per target and key: the run's environment names the cloud key, and every hook gets it. */
  const bindings = new Map<string, SmolMachines>();
  const machinesFor = (env: Readonly<Record<string, string | undefined>>): SmolMachines => {
    let resolved: SmolTarget = { kind: 'local' };
    if (target === 'cloud') {
      const apiKey = envValue(env, SMOL_CLOUD_TOKEN);
      if (apiKey === undefined) throw new Error(`${SMOL_CLOUD_TOKEN} is not set`);
      resolved = { kind: 'cloud', apiKey, baseUrl: envValue(env, SMOL_CLOUD_URL) };
    }
    const key = resolved.kind === 'local' ? 'local' : `${resolved.apiKey}\n${resolved.baseUrl ?? ''}`;
    let machines = bindings.get(key);
    if (machines === undefined) {
      machines = smolMachines(resolved);
      bindings.set(key, machines);
    }
    return machines;
  };
  const prefixFor = (runId: string, targetName: string) => `e2e-${digest(`${runId}\n${targetName}`)}`;

  /** Boots one browser machine, starts Chromium and the app in it, and runs `prepare` on it. */
  const boot = async (request: BrowserRequest, name: string): Promise<Browser> => {
    const machines = machinesFor(request.env);
    const cloud = machines.target.kind === 'cloud';
    const machine = await machines.create({
      name,
      image: IMAGE,
      cpus,
      memoryMb,
      guestPort: GUEST_PORT,
      // The cloud publishes on a port of its own choosing.
      hostPort: cloud ? 0 : await freePort(),
      labels: { e2e_run: request.runId, e2e_target: request.targetName },
      // A worker-scope browser is made in the runner and read from a worker; an attempt-scope one lives and dies with its worker, so the engine deletes it when the worker exits however it exits.
      persistent: scope === 'worker',
      ...(appSource === undefined || cloud ? {} : { mount: { source: appSource, target: APP_SOURCE_MOUNT } }),
    });
    try {
      if (appSource !== undefined && cloud) await machine.writeFile(APP_SOURCE_ARCHIVE, await archiveSource(appSource));
      await machine.shell(startScript(setup, hostPorts));
      if (app !== undefined) await machine.shell(appScript(app, cloud ? 'archive' : 'mount'));
      const browser: Browser = {
        machine,
        devtoolsPath: await devtoolsPath(machine, request.signal),
        connectToken: cloud ? await mintConnectToken(machine, request.signal) : undefined,
      };
      if (prepare !== undefined) await prepare(cdpEndpoint(browser));
      return browser;
    } catch (cause) {
      await machines.delete(machine.id).catch(() => false);
      throw cause;
    }
  };

  /** Each slot's warm browser in this process, booted by the first attempt that needs it. */
  const warm = new Map<string, Promise<Browser>>();
  const warmFor = (request: BrowserRequest): Promise<Browser> => {
    const name = `${prefixFor(request.runId, request.targetName)}-w${request.slot}`;
    let browser = warm.get(name);
    if (browser === undefined) {
      browser = boot(request, name);
      warm.set(name, browser);
      // A failed boot is retried by the next attempt rather than cached.
      browser.catch(() => warm.delete(name));
    }
    return browser;
  };

  return {
    name: 'smol',
    scope,
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      if (scope === 'worker') {
        const name = `${prefixFor(request.runId, request.targetName)}-s${request.slot}`;
        const browser = await boot(request, name);
        request.log(`browser machine ${name}`);
        return { id: browser.machine.id, cdpEndpoint: cdpEndpoint(browser) };
      }
      const source = await warmFor(request);
      const name = `${source.machine.name}-${digest(request.attemptId ?? String(Date.now()))}`;
      const started = Date.now();
      // A branch keeps the source's published port, moved to a port the engine picks, and its connect token's reach.
      const branch = await source.machine.branch(name);
      try {
        await devtoolsPath(branch, request.signal);
      } catch (cause) {
        await machinesFor(request.env).delete(branch.id).catch(() => false);
        throw cause;
      }
      request.log(`browser ${name}, branched from ${source.machine.name} in ${Date.now() - started} ms`);
      return { id: branch.id, cdpEndpoint: cdpEndpoint(source, branch) };
    },
    async release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
      await machinesFor(context.env).delete(lease.id);
    },
    async sweep(context: BrowserReleaseContext): Promise<readonly string[]> {
      const machines = machinesFor(context.env);
      const prefix = `${prefixFor(context.runId, context.targetName)}-`;
      // Longest name first, so a branch goes before the warm browser it came from.
      const open = (await machines.list()).filter(({ name }) => name.startsWith(prefix)).toSorted((a, b) => b.name.length - a.name.length);
      const deleted: string[] = [];
      const failed: string[] = [];
      for (const { name, id } of open) {
        // A worker that just exited may still have the engine stopping its machines; a delete then fails until the stop settles.
        for (let attempt = 1; ; attempt += 1) {
          try {
            if (await machines.delete(id)) deleted.push(name);
            break;
          } catch (cause) {
            if (attempt < SWEEP_ATTEMPTS && !context.signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, SWEEP_RETRY_MS));
              continue;
            }
            failed.push(`${name} (${cause instanceof Error ? cause.message : String(cause)})`);
            break;
          }
        }
      }
      if (failed.length > 0) throw new Error(`deleted ${deleted.length === 0 ? 'none' : deleted.join(', ')}; could not delete ${failed.join(', ')}`);
      return deleted;
    },
    downloads: {
      dir: DOWNLOADS_DIR,
      read: async (lease, file, context) => machinesFor(context.env).readFile(lease.id, file),
    },
  };
}
