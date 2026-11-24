/**
 * --header "Name: value" for `wb source add`. A secret shouldn't be typed into a command line (shell history,
 * ps), so the value can say {env:VAR} or {stdin}; stdin is asked without echo on a terminal, else read a line each.
 * They're filled in here, on the computer `wb` runs on, before the command runs (on this board or the cloud one).
 */
export async function resolveHeaderSpecs(specs: string[]): Promise<string[]> {
	const out: string[] = [];
	let piped: string[] | undefined;
	const fromStdin = async (name: string) => {
		if (process.stdin.isTTY) {
			Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
			try {
				return prompt(`${name} (typing is hidden):`) ?? "";
			} finally {
				Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
				process.stdout.write("\n");
			}
		}
		piped ??= (await Bun.stdin.text()).split(/\r?\n/);
		const line = piped.shift();
		if (line === undefined || line === "") throw new Error(`stdin ran out of lines for ${name}`);
		return line;
	};
	for (const spec of specs) {
		const at = spec.indexOf(":");
		if (at < 1) throw new Error(`--header "Name: value", got "${spec}"`);
		const name = spec.slice(0, at).trim();
		let value = spec.slice(at + 1).trim();
		for (const m of value.match(/\{env:[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []) {
			const v = process.env[m.slice(5, -1)];
			if (!v) throw new Error(`${m.slice(5, -1)} is not set (for ${name})`);
			value = value.replace(m, () => v);
		}
		if (value.includes("{stdin}")) {
			const v = await fromStdin(name);
			value = value.replace("{stdin}", () => v);
		}
		out.push(`${name}: ${value}`);
	}
	return out;
}
