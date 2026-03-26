package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/hecate/coconutfree/internal/cache"
	"github.com/hecate/coconutfree/internal/ingest"
)

func NewRouter(cacheFunc func() *cache.Cache, readyFunc func() bool, progressFunc func() *ingest.Progress) *chi.Mux {
	h := NewHandler(cacheFunc)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5))

	r.Get("/privacy", servePrivacyPolicy)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
			resp := map[string]any{"ready": readyFunc()}
			if p := progressFunc(); p != nil && p.Phase != "idle" {
				resp["progress"] = p
			}
			writeJSON(w, resp)
		})
		r.Get("/products/barcode/{sku}", h.GetProductByBarcode)
		r.Post("/products/sku-lookup", h.SKULookup)
		r.Get("/bundle", h.BundleDownload)
		r.Get("/bundle/meta", h.BundleMeta)
	})

	return r
}
