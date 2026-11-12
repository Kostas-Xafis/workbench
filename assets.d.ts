// `import x from "./icon.svg" with { type: "file" }` gives the file's path (embedded when compiled). The board's
// style sheets and scripts (ui/*.css, ui/*.js) are imported that way in ui.ts.
declare module "*.svg" {
	const path: string;
	export default path;
}
declare module "*.css" {
	const path: string;
	export default path;
}
declare module "*.js" {
	const path: string;
	export default path;
}
declare module "*.png" {
	const path: string;
	export default path;
}
