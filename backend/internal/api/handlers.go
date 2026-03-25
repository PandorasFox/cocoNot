package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/hecate/coconutfree/internal/db"
	"github.com/hecate/coconutfree/internal/models"
)

type Handler struct {
	queries *db.Queries
}

func NewHandler(queries *db.Queries) *Handler {
	return &Handler{queries: queries}
}

func (h *Handler) ListProducts(w http.ResponseWriter, r *http.Request) {
	search := r.URL.Query().Get("q")

	var coconutFilter *bool
	if v := r.URL.Query().Get("coconut"); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			coconutFilter = &b
		}
	}

	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	products, total, err := h.queries.ListProducts(r.Context(), search, coconutFilter, limit, offset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{
		"products": products,
		"total":    total,
		"limit":    limit,
		"offset":   offset,
	})
}

func (h *Handler) GetProduct(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "invalid product id", http.StatusBadRequest)
		return
	}

	detail, err := h.queries.GetProduct(r.Context(), id)
	if err != nil {
		http.Error(w, "product not found", http.StatusNotFound)
		return
	}

	writeJSON(w, detail)
}

func (h *Handler) GetProductByBarcode(w http.ResponseWriter, r *http.Request) {
	sku := chi.URLParam(r, "sku")
	if sku == "" {
		http.Error(w, "sku required", http.StatusBadRequest)
		return
	}

	product, err := h.queries.GetProductByBarcode(r.Context(), sku)
	if err != nil {
		http.Error(w, "product not found", http.StatusNotFound)
		return
	}

	writeJSON(w, product)
}

func (h *Handler) SKUDump(w http.ResponseWriter, r *http.Request) {
	entries, err := h.queries.DumpSKUs(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{
		"products": entries,
		"total":    len(entries),
	})
}

func (h *Handler) CreateFlag(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	productID, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "invalid product id", http.StatusBadRequest)
		return
	}

	var req models.FlagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	validTypes := map[string]bool{"found_coconut": true, "wrong_ingredients": true, "other": true}
	if !validTypes[req.FlagType] {
		http.Error(w, "invalid flag_type", http.StatusBadRequest)
		return
	}

	flag, err := h.queries.CreateFlag(r.Context(), productID, req.FlagType, req.Notes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	writeJSON(w, flag)
}

func (h *Handler) SKULookup(w http.ResponseWriter, r *http.Request) {
	var req models.SKULookupRequest
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

	results, err := h.queries.LookupSKUs(r.Context(), req.SKUs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"results": results})
}

func (h *Handler) FuzzySearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "query required", http.StatusBadRequest)
		return
	}

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	products, err := h.queries.FuzzySearch(r.Context(), query, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"products": products})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
