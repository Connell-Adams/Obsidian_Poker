/**
 * Durable storage behind a small interface. The browser uses IndexedDB; tests and
 * browsers with storage disabled use the in-memory version. All bankroll changes go
 * through `commit`, which writes every record in one atomic transaction.
 */
export type StoreName = 'hands' | 'ledger' | 'sessions' | 'tournaments' | 'reviews' | 'meta';

export const STORE_NAMES: readonly StoreName[] = ['hands', 'ledger', 'sessions', 'tournaments', 'reviews', 'meta'];

export interface WriteOp {
  store: StoreName;
  key: string;
  /** Undefined deletes the key. */
  value?: unknown;
}

export interface DataStore {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: StoreName): Promise<T[]>;
  count(store: StoreName): Promise<number>;
  /** Atomically applies every operation or none of them. */
  commit(ops: readonly WriteOp[]): Promise<void>;
  /** Removes all stored data. */
  clear(): Promise<void>;
  readonly durable: boolean;
}

export class MemoryStore implements DataStore {
  readonly durable = false;
  private readonly data = new Map<StoreName, Map<string, string>>();

  private bucket(store: StoreName): Map<string, string> {
    let b = this.data.get(store);
    if (!b) {
      b = new Map();
      this.data.set(store, b);
    }
    return b;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const raw = this.bucket(store).get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return [...this.bucket(store).values()].map((raw) => JSON.parse(raw) as T);
  }

  async count(store: StoreName): Promise<number> {
    return this.bucket(store).size;
  }

  async commit(ops: readonly WriteOp[]): Promise<void> {
    // Serialise first so a bad value aborts the whole batch, matching a real transaction.
    const prepared = ops.map((op) => ({ op, raw: op.value === undefined ? undefined : JSON.stringify(op.value) }));
    for (const { op, raw } of prepared) {
      if (raw === undefined) this.bucket(op.store).delete(op.key);
      else this.bucket(op.store).set(op.key, raw);
    }
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

const DB_NAME = 'obsidian-room';
/** Bump when object stores change; add the migration step to `onupgradeneeded` below. */
export const DB_VERSION = 1;

export class IndexedDbStore implements DataStore {
  readonly durable = true;
  private constructor(private readonly db: IDBDatabase) {}

  static open(factory: IDBFactory = globalThis.indexedDB): Promise<IndexedDbStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORE_NAMES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(new IndexedDbStore(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    });
  }

  private request<T>(store: StoreName, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = run(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.request(store, (s) => s.get(key) as IDBRequest<T | undefined>);
  }

  getAll<T>(store: StoreName): Promise<T[]> {
    return this.request(store, (s) => s.getAll() as IDBRequest<T[]>);
  }

  count(store: StoreName): Promise<number> {
    return this.request(store, (s) => s.count());
  }

  commit(ops: readonly WriteOp[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    const stores = [...new Set(ops.map((op) => op.store))];
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
      try {
        for (const op of ops) {
          const store = tx.objectStore(op.store);
          if (op.value === undefined) store.delete(op.key);
          else store.put(op.value, op.key);
        }
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([...STORE_NAMES], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const name of STORE_NAMES) tx.objectStore(name).clear();
    });
  }
}

/** Opens the best available store. Private-mode browsers can refuse IndexedDB entirely. */
export async function openDataStore(): Promise<DataStore> {
  try {
    if (globalThis.indexedDB) return await IndexedDbStore.open();
  } catch (error) {
    console.warn('IndexedDB unavailable, this session will not persist', error);
  }
  return new MemoryStore();
}
