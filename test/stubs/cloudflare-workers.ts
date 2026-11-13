// Node stand-in for the workerd-only module, so code that imports the OAuth library loads in vitest.
export class WorkerEntrypoint {}
export const env = {};
