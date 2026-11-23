// The few Workers types the cloud board uses, by hand: @cloudflare/workers-types would redefine Request, Response
// and the rest next to bun's types, which the board's shared code (src/) is checked with.
declare module "cloudflare:workers" {
	export class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState;
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}
}

interface DurableObjectStorage {
	sql: import("./sqlite").SqlStorage;
	transactionSync<T>(fn: () => T): T;
	getAlarm(): Promise<number | null>;
	setAlarm(at: number | Date): Promise<void>;
}

interface DurableObjectState {
	storage: DurableObjectStorage;
	blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface DurableObjectId {}

interface DurableObjectStub {
	fetch(req: Request): Promise<Response>;
}

interface DurableObjectNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub;
}

/** A binding with a fetch, like ASSETS. */
interface Fetcher {
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}
