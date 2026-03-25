export interface Product {
  id: string
  sku: string
  brand: string
  name: string
  category: string
  image_url?: string
  contains_coconut: boolean | null
  status_as_of?: string
  created_at: string
  updated_at: string
}

export interface IngredientSource {
  id: string
  product_id: string
  source_type: string
  source_url?: string
  ingredients_raw: string
  coconut_found: boolean
  fetched_at: string
  created_at: string
}

export interface ProductDetail extends Product {
  sources: IngredientSource[]
}

export interface ProductListResponse {
  products: Product[]
  total: number
  limit: number
  offset: number
}

const BASE = '/api'

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`)
  }
  return res.json()
}

export function listProducts(params: {
  q?: string
  coconut?: boolean
  limit?: number
  offset?: number
}) {
  const sp = new URLSearchParams()
  if (params.q) sp.set('q', params.q)
  if (params.coconut !== undefined) sp.set('coconut', String(params.coconut))
  if (params.limit) sp.set('limit', String(params.limit))
  if (params.offset) sp.set('offset', String(params.offset))
  return fetchJSON<ProductListResponse>(`/products?${sp}`)
}

export function getProduct(id: string) {
  return fetchJSON<ProductDetail>(`/products/${id}`)
}

export function getProductByBarcode(sku: string) {
  return fetchJSON<Product>(`/products/barcode/${encodeURIComponent(sku)}`)
}

export interface SKUDumpEntry {
  sku: string
  name: string
  contains_coconut: boolean | null
}

export function skuDump() {
  return fetchJSON<{ products: SKUDumpEntry[]; total: number }>('/products/sku-dump')
}

export function fuzzySearch(q: string, limit = 20) {
  return fetchJSON<{ products: Product[] }>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export interface SKULookupResult {
  name: string
  contains_coconut: boolean | null
}

export function checkHealth() {
  return fetchJSON<{ ready: boolean }>('/health')
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

