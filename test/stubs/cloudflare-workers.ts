// Node stand-in for the workerd-only module, so code that imports the OAuth library loads in vitest.
export class WorkerEntrypoint<E = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: E,
  ) {}
}
export const env = {};
