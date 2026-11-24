/**
 * `wb` over the network (POST /api/sync/cli): the command runs here, on the cloud board's own database, by the same
 * code `wb` runs on a computer (src/cli.ts). The computer sends what the command line said, the folder it ran in
 * and the contents of the files the command names (src/cliargs.ts); this sends back what the command printed, in
 * order, its exit code, and any file it wrote (`wb image save`).
 */
import type { Db } from "../../src/db";
import { CLI_BODY_MAX, needsComputer, type CliReply, type CliRequest } from "../../src/cliargs";
import { runCli, type CliCtx } from "../../src/cli";

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

export async function runCloudCli(db: Db, req: Request, origin: string): Promise<Response> {
	const text = await req.text();
	if (text.length > CLI_BODY_MAX)
		return Response.json({ error: `the request is over ${CLI_BODY_MAX / 1024 / 1024} MB` }, { status: 413 });
	let body: Partial<CliRequest> | null = null;
	try {
		body = JSON.parse(text);
	} catch {}
	if (
		!body ||
		!Array.isArray(body.args) ||
		!body.args.every((a) => typeof a === "string") ||
		typeof body.options !== "object" ||
		!body.options
	)
		return Response.json({ error: "send the command's args and options" }, { status: 400 });
	const files = body.files && typeof body.files === "object" ? body.files : {};
	const lines: CliReply["lines"] = [];
	const writes: CliReply["writes"] = {};
	const cmd = body.args[0];
	// `wb source add` comes with its headers filled in by wb on the computer (src/cloudcli.ts); cli.ts seals them here.
	if (needsComputer(cmd) && cmd !== "source") {
		lines.push(["err", `wb: wb ${cmd} needs a computer, which the cloud board doesn't have`]);
		return Response.json({ lines, code: 1, writes } satisfies CliReply, { headers: { "cache-control": "no-store" } });
	}
	const ctx: CliCtx = {
		db,
		args: body.args,
		o: body.options as CliCtx["o"],
		cwd: typeof body.cwd === "string" ? body.cwd : "/",
		author: typeof body.author === "string" && body.author.trim() ? body.author.trim().slice(0, 40) : "kostas",
		session: typeof body.session === "string" && body.session ? body.session : undefined,
		tty: !!body.tty,
		base: origin,
		port: Number(body.port) || 4400,
		out: (line) => lines.push(["out", line]),
		err: (line) => lines.push(["err", line]),
		read: async (path, as) => {
			const f = Object.hasOwn(files, path) ? files[path] : undefined;
			if (f?.error) throw new Error(f.error);
			if (!f || f.b64 === undefined) throw new Error(as === "image" ? `no file at ${path}` : `no file ${path}`);
			return { bytes: decode(f.b64), label: f.label ?? path };
		},
		write: async (path, bytes) => {
			writes[path] = Buffer.from(bytes).toString("base64");
		},
	};
	const code = await runCli(ctx);
	return Response.json({ lines, code, writes } satisfies CliReply, { headers: { "cache-control": "no-store" } });
}
