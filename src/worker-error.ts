/**
 * A worker's `error` event as an Error that names the worker. An exception thrown in the worker arrives as an
 * ErrorEvent with its message and place; a worker that failed to load (its script's fetch or a module import) or was
 * killed gets a plain Event with neither, which became `new Error(undefined)`: "Error at onerror", no clue which.
 */
export function workerError(name: string, e: Event): Error {
  const ev = e as Partial<ErrorEvent>;
  const what = ev.message || `failed to load or was stopped (${e.constructor.name} with no message)`;
  const where = ev.filename ? ` at ${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : '';
  return new Error(`${name}: ${what}${where}`);
}
