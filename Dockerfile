# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --legacy-peer-deps
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend (Debian — DuckDB's static lib needs glibc)
FROM golang:1.26-bookworm AS backend-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ libstdc++-12-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=1 go build -o /coconutfree .

# Stage 3: Runtime (Debian slim — needs glibc + libstdc++ for DuckDB)
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend-build /coconutfree .
COPY --from=frontend-build /build/dist ./static
ENV PORT=8080 \
    FRONTEND_DIR=/app/static \
    DATA_DIR=/data \
    INGEST_INTERVAL=6h \
    INGEST_COUNTRIES=en:united-states \
    ALLERGEN_KEYWORDS=coconut,cocos\ nucifera,copra
EXPOSE 8080
CMD ["./coconutfree"]
