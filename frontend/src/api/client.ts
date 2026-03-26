const BASE = '/api'

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`)
  }
  return res.json()
}

export interface SKULookupResult {
  name: string
  contains_coconut: boolean | null
}

export interface HealthResponse {
  ready: boolean
  progress?: { phase: string; current: number; total: number }
}

export function checkHealth() {
  return fetchJSON<HealthResponse>('/health')
}

export function getProductByBarcode(sku: string) {
  return fetchJSON<SKULookupResult>(`/products/barcode/${encodeURIComponent(sku)}`)
}

export function skuLookup(skus: string[]) {
  return fetchJSON<{ results: Record<string, SKULookupResult> }>(
    '/products/sku-lookup',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus }),
    },
  )
}
