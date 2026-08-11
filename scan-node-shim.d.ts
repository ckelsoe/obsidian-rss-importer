// Scan-only Node ambient shims. Consumed ONLY by tsconfig.scan.json (the
// marketplace-scan reproduction), never by the normal build.
//
// The scan reproduction strips @types/node (via `types: []`) so a lib-version
// gap is exposed instead of masked. That also removes the Node globals the
// desktop-only media code relies on (`require`, `Buffer`, and the `fs`/`path`
// modules behind Platform.isDesktop). The hosted developer-dashboard scan
// resolves those from its Node/Electron runtime, so they are NOT what the guard
// exists to catch; these minimal shims reproduce that so the guard does not
// false-fail on them while still surfacing any lib gap (the shims declare no
// String/Array members). The normal `tsc` build excludes this file (see
// tsconfig.json `exclude`) and uses @types/node, so there is no clash. This
// file is in eslint's globalIgnores, so its `any` shims are not linted.
declare function require(id: string): any;
declare const Buffer: {
	from(data: ArrayBuffer | Uint8Array | readonly number[]): unknown;
};
declare module 'fs' {
	const fsModule: any;
	export = fsModule;
}
declare module 'path' {
	const pathModule: any;
	export = pathModule;
}
