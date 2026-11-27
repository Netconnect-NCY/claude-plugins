// Build/test entry: the public contract (plugin.d.ts, the file .claude-plugin/plugin.json names), self-contained:
// no external type references or ambient globals, which the host refuses in a contract. Tests reach host timers through globalThis.
export * from './plugin'
