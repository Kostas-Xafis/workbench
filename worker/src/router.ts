/**
 * Bun.serve's routing, for the route table in src/routes.ts: "/a/b" exact, "/a/:id" with params, and a value
 * that is a handler, a Response, or an object of handlers by method. An exact path wins over one with params;
 * among those with params, the one with more fixed parts wins ("/api/runs/test" before "/api/runs/:id").
 */
type Handler = (req: Request, srv: unknown) => Response | Promise<Response>;
type Value = Handler | Response | Record<string, Handler | Response>;

export type Match = { pattern: string; params: Record<string, string>; value: Value };

export function compile(routes: Record<string, unknown>) {
	const exact = new Map<string, Value>();
	const withParams: { pattern: string; parts: string[]; fixed: number; value: Value }[] = [];
	for (const [pattern, value] of Object.entries(routes)) {
		if (!pattern.includes(":")) exact.set(pattern, value as Value);
		else {
			const parts = pattern.split("/");
			withParams.push({ pattern, parts, fixed: parts.filter((p) => !p.startsWith(":")).length, value: value as Value });
		}
	}
	withParams.sort((a, b) => b.fixed - a.fixed);

	return (path: string): Match | null => {
		const hit = exact.get(path);
		if (hit) return { pattern: path, params: {}, value: hit };
		const segs = path.split("/");
		for (const r of withParams) {
			if (r.parts.length !== segs.length) continue;
			const params: Record<string, string> = {};
			let ok = true;
			for (let i = 0; i < segs.length && ok; i++) {
				const part = r.parts[i];
				if (part.startsWith(":")) {
					if (!segs[i]) ok = false;
					else
						try {
							params[part.slice(1)] = decodeURIComponent(segs[i]);
						} catch {
							ok = false;
						}
				} else if (part !== segs[i]) ok = false;
			}
			if (ok) return { pattern: r.pattern, params, value: r.value };
		}
		return null;
	};
}

/** Runs the matched route: the method's handler with req.params set, as Bun does. */
export function dispatch(m: Match, req: Request, srv: unknown): Response | Promise<Response> {
	let v = m.value;
	if (typeof v === "object" && !(v instanceof Response)) {
		const byMethod = v as Record<string, Handler | Response>;
		const h = byMethod[req.method] ?? (req.method === "HEAD" ? byMethod.GET : undefined);
		if (!h) return new Response("method not allowed", { status: 405, headers: { allow: Object.keys(byMethod).join(", ") } });
		v = h;
	}
	if (v instanceof Response) return v.clone();
	Object.defineProperty(req, "params", { value: m.params, configurable: true });
	return (v as Handler)(req, srv);
}
