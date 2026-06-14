// Ambient declaration for turndown-plugin-gfm, which ships no type definitions.
//
// This MUST stay a standalone script file with NO top-level import or export.
// A `declare module 'x'` placed inside a file that is itself a module (one with
// top-level import/export, like types.d.ts) is treated as an augmentation of an
// already-typed module and is silently ignored for an untyped JS package, so it
// fails to suppress TS7016. Keeping this file script-scoped makes the block a
// real ambient module declaration. The TurndownService type is referenced via
// an inline `import('turndown')` so this file stays script-scoped.
declare module "turndown-plugin-gfm" {
	type GfmPlugin = (service: import("turndown")) => void;
	export const gfm: GfmPlugin;
	export const tables: GfmPlugin;
	export const strikethrough: GfmPlugin;
	export const taskListItems: GfmPlugin;
}
