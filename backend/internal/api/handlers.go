package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/hecate/coconutfree/internal/cache"
)

type Handler struct {
	cacheFunc func() *cache.Cache
}

func NewHandler(cacheFunc func() *cache.Cache) *Handler {
	return &Handler{cacheFunc: cacheFunc}
}

func (h *Handler) GetProductByBarcode(w http.ResponseWriter, r *http.Request) {
	sku := chi.URLParam(r, "sku")
	if sku == "" {
		http.Error(w, "sku required", http.StatusBadRequest)
		return
	}

	c := h.cacheFunc()
	if c == nil {
		http.Error(w, "cache not ready", http.StatusServiceUnavailable)
		return
	}

	entry := c.Lookup(sku)
	if entry == nil {
		http.Error(w, "product not found", http.StatusNotFound)
		return
	}

	writeJSON(w, entry)
}

func (h *Handler) SKULookup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SKUs []string `json:"skus"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if len(req.SKUs) == 0 {
		http.Error(w, "skus required", http.StatusBadRequest)
		return
	}
	if len(req.SKUs) > 50 {
		http.Error(w, "max 50 SKUs per request", http.StatusBadRequest)
		return
	}

	c := h.cacheFunc()
	if c == nil {
		http.Error(w, "cache not ready", http.StatusServiceUnavailable)
		return
	}

	writeJSON(w, map[string]any{"results": c.LookupBatch(req.SKUs)})
}

func (h *Handler) BundleDownload(w http.ResponseWriter, r *http.Request) {
	c := h.cacheFunc()
	if c == nil {
		http.Error(w, "cache not ready", http.StatusServiceUnavailable)
		return
	}
	c.ServeBundle(w)
}

func (h *Handler) BundleMeta(w http.ResponseWriter, r *http.Request) {
	c := h.cacheFunc()
	if c == nil {
		http.Error(w, "cache not ready", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, c.Meta())
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
