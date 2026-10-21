/** Serializes async SQLite write transactions while allowing callers to receive their result. */
export function createLocalWriteQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function runWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
