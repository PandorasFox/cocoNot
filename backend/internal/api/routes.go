package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/hecate/coconutfree/internal/db"
)

func NewRouter(queries *db.Queries, readyFunc func() bool) *chi.Mux {
	h := NewHandler(queries)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5))

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, map[string]any{"ready": readyFunc()})
		})
		r.Get("/products", h.ListProducts)
		r.Get("/products/sku-dump", h.SKUDump)
		r.Get("/products/barcode/{sku}", h.GetProductByBarcode)
		r.Get("/products/{id}", h.GetProduct)
		r.Post("/products/{id}/flag", h.CreateFlag)
		r.Post("/products/sku-lookup", h.SKULookup)
		r.Get("/search", h.FuzzySearch)
	})

	return r
}
