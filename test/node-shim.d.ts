// The tests run on Node but the project carries no @types/node. These are the
// only Node APIs the tests use.
declare const process: {
  env: Record<string, string | undefined>
  cpuUsage(previous?: { user: number; system: number }): { user: number; system: number }
}

declare const console: { log(...args: unknown[]): void }

declare const performance: { now(): number }

// Vite's ?raw imports, used by the field regression test to read the committed benchmark data.
declare module '*?raw' {
  const text: string
  export default text
}
