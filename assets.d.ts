// `import x from "./icon.svg" with { type: "file" }` gives the file's path (embedded when compiled).
declare module "*.svg" {
	const path: string;
	export default path;
}
