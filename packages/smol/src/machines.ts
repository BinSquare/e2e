/** The slice of the smolmachines SDK the provider uses, loaded on first use so a config load never pays for it. */

import type { ConnectOptions, Machine } from 'smolmachines';

/** Where machines run: this computer's embedded engine, or smol cloud with an API key. */
export type SmolTarget =
  | { readonly kind: 'local' }
  | { readonly kind: 'cloud'; readonly apiKey: string; readonly baseUrl?: string | undefined };

/** What a new browser machine is created with. */
export interface SmolMachineParams {
  readonly name: string;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMb: number;
  /** The one guest port the machine publishes. */
  readonly guestPort: number;
  /** Local: the port on this computer's loopback `guestPort` is published on. The cloud picks its own. */
  readonly hostPort: number;
  /** Local only: caller metadata stored with the machine. */
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Local only: keep the machine's record when the process that made it
   * exits, so another process can attach to it; the engine stops the VM
   * either way. Without it the engine also deletes the machine.
   */
  readonly persistent: boolean;
  /** Local only: a directory on this computer the machine sees read-only, `source` at `target`. */
  readonly mount?: { readonly source: string; readonly target: string } | undefined;
}

/** A published guest port as a client reaches it: URLs plus the headers a request needs. */
export interface Endpoint {
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** One running machine. */
export interface SmolMachine {
  /** The handle every later call names it by: its name locally, its `mach-` id on the cloud. */
  readonly id: string;
  readonly name: string;
  /** Runs `sh -c script`, failing on a non-zero exit with its stderr. */
  shell(script: string): Promise<void>;
  /** Writes `bytes` to `path` on the machine's disk. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Where `guestPort` (with `path` below it) is reached from this computer. */
  endpoint(guestPort: number, path?: string): Endpoint;
  /** A copy-on-write child of the running machine; its published port moves to a port the engine picks. */
  branch(name: string): Promise<SmolMachine>;
}

export interface SmolMachines {
  readonly target: SmolTarget;
  create(params: SmolMachineParams): Promise<SmolMachine>;
  /** Deletes the machine; one the engine no longer knows counts as deleted. Resolves to whether it still knew it. */
  delete(id: string): Promise<boolean>;
  /** Every machine the target knows. */
  list(): Promise<{ readonly name: string; readonly id: string }[]>;
  /** The bytes of one file on the machine's own disk. */
  readFile(id: string, file: string): Promise<Uint8Array>;
}

/** Wraps an SDK machine, remembering its handle for a later delete or read from this process. */
function wrap(machine: Machine, handles: Map<string, Machine>): SmolMachine {
  handles.set(machine.id, machine);
  return {
    id: machine.id,
    name: machine.name,
    async shell(script) {
      const result = await machine.exec(['sh', '-c', script]);
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('; ');
        throw new Error(`machine ${machine.name}: command exited ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`);
      }
    },
    writeFile: async (path, bytes) => void (await machine.writeFile(path, Buffer.from(bytes))),
    endpoint: (guestPort, path) => machine.endpoint(guestPort, path),
    branch: async (name) => wrap(await machine.branch(name), handles),
  };
}

/** Whether an SDK error says the machine does not exist. */
function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && /not found|no such machine|does not exist|404/i.test(cause.message);
}

/** Machines on `target`, through the SDK. */
export function smolMachines(target: SmolTarget): SmolMachines {
  const sdk = import('smolmachines');
  // A library names its target instead of reading SMOL_CLOUD_TOKEN, and leaves signals to the runner.
  const connection: ConnectOptions =
    target.kind === 'local'
      ? { target: 'local', handleSignals: false }
      : { target: 'cloud', apiKey: target.apiKey, ...(target.baseUrl === undefined ? {} : { baseUrl: target.baseUrl }) };
  const handles = new Map<string, Machine>();
  /** This process's handle on the machine, else one attached by id: a lease may be released or read by another process than the one that made it. */
  const attach = async (id: string): Promise<Machine> => handles.get(id) ?? (await sdk).Machine.connect(id, connection);
  return {
    target,
    async create(params) {
      const { Machine } = await sdk;
      const local =
        target.kind === 'local'
          ? {
              labels: { ...params.labels },
              persistent: params.persistent,
              ...(params.mount === undefined ? {} : { mounts: [{ ...params.mount, readOnly: true }] }),
            }
          : {};
      return wrap(
        await Machine.create(
          {
            name: params.name,
            image: params.image,
            network: true,
            branchable: true,
            ports: [{ host: params.hostPort, guest: params.guestPort }],
            resources: { cpus: params.cpus, memoryMb: params.memoryMb },
            ...local,
          },
          connection,
        ),
        handles,
      );
    },
    async delete(id) {
      try {
        await (await attach(id)).delete();
        return true;
      } catch (cause) {
        if (isNotFound(cause)) return false;
        throw cause;
      } finally {
        handles.delete(id);
      }
    },
    list: async () => (await (await sdk).Machine.list(connection)).map(({ name, id }) => ({ name, id })),
    readFile: async (id, file) => new Uint8Array(await (await attach(id)).readFile(file)),
  };
}
