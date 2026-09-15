# Yupi subagents

Vendored from [TroopJostle/pi-subagents](https://github.com/TroopJostle/pi-subagents),
a fork of [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).
Upstream revision: `e955e29c51b7a6cce37e1108cd2d6c57a77e151c` (0.19.0).
The upstream MIT license is preserved in `LICENSE`.

Yupi ships these sources as package assets and loads them through its extension
loader. No download or separate installation is required at runtime.

Local adaptations:

- Yupi configuration and environment paths; no implicit Pi/shared directory discovery.
- Explicit model selections fail if unavailable instead of silently using another model/provider.
- Tool errors are signaled by throwing (the host extension contract); upstream `isError` result fields were translated to throws.
- TypeBox uses the host's `typebox` package, relative imports use `.ts`, and imports are static.

The source snapshot is maintained separately from Yupi's core TypeScript compilation;
the extension loader supplies the host SDK at runtime. Integration tests live in
`test/bundled-subagents.test.ts` and `test/suite/bundled-subagents.test.ts`.
