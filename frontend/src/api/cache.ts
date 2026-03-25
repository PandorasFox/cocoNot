import type { Product } from './client'

export interface CachedSKU {
  sku: string
  status: 'coconut' | 'clean' | 'not_found'
  name?: string
  cachedAt: number
}

const DB_NAME = 'coconot'
const STORE_NAME = 'skus'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'sku' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(
  mode: IDBTransactionMode,
): Promise<{ store: IDBObjectStore; done: Promise<void> }> {
  return openDB().then((db) => {
    const t = db.transaction(STORE_NAME, mode)
    const store = t.objectStore(STORE_NAME)
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
    return { store, done }
  })
}

function idbGet<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function getStatus(sku: string): Promise<CachedSKU | undefined> {
  const { store } = await tx('readonly')
  return idbGet<CachedSKU>(store, sku)
}

export async function getStatuses(
  skus: string[],
): Promise<Map<string, CachedSKU>> {
  const { store } = await tx('readonly')
  const entries = await Promise.all(
    skus.map((sku) =>
      idbGet<CachedSKU>(store, sku).then(
        (v) => [sku, v] as [string, CachedSKU | undefined],
      ),
    ),
  )
  const map = new Map<string, CachedSKU>()
  for (const [sku, entry] of entries) {
    if (entry) map.set(sku, entry)
  }
  return map
}

function productToStatus(
  containsCoconut: boolean | null,
): 'coconut' | 'clean' {
  return containsCoconut === true ? 'coconut' : 'clean'
}

export async function putProduct(product: Product): Promise<void> {
  const { store, done } = await tx('readwrite')
  store.put({
    sku: product.sku,
    status: productToStatus(product.contains_coconut),
    name: product.name,
    cachedAt: Date.now(),
  } satisfies CachedSKU)
  await done
}

export async function putProducts(products: Product[]): Promise<void> {
  if (products.length === 0) return
  const { store, done } = await tx('readwrite')
  const now = Date.now()
  for (const p of products) {
    store.put({
      sku: p.sku,
      status: productToStatus(p.contains_coconut),
      name: p.name,
      cachedAt: now,
    } satisfies CachedSKU)
  }
  await done
}

export async function putNotFound(sku: string): Promise<void> {
  const { store, done } = await tx('readwrite')
  store.put({
    sku,
    status: 'not_found',
    cachedAt: Date.now(),
  } satisfies CachedSKU)
  await done
}

export async function putSKULookupResults(
  results: Record<string, { name: string; contains_coconut: boolean | null }>,
  requestedSkus: string[],
): Promise<void> {
  const { store, done } = await tx('readwrite')
  const now = Date.now()
  const found = new Set(Object.keys(results))
  for (const [sku, r] of Object.entries(results)) {
    store.put({
      sku,
      status: productToStatus(r.contains_coconut),
      name: r.name,
      cachedAt: now,
    } satisfies CachedSKU)
  }
  for (const sku of requestedSkus) {
    if (!found.has(sku)) {
      store.put({
        sku,
        status: 'not_found',
        cachedAt: now,
      } satisfies CachedSKU)
    }
  }
  await done
}
