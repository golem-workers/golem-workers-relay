import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage<boolean>();
/** Set only by fingerprint-validated explicit durable reconciliation admission. */
export function withAuthorizationReadbackOnly<T>(operation: () => Promise<T>): Promise<T> { return scope.run(true, operation); }
export function isAuthorizationReadbackOnly(): boolean { return scope.getStore() === true; }
