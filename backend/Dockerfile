# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY go.mod go.sum ./
RUN go mod download

# Copy Go source code
COPY . .

# Build statically linked binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/bin/gateway .

# Runtime stage
FROM alpine:3.20

WORKDIR /app

# Install ca-certificates for TLS
RUN apk --no-cache add ca-certificates tzdata

# Copy binary from builder
COPY --from=builder /app/bin/gateway /app/gateway

# Expose Go gateway public port
EXPOSE 8000

ENV PORT=8000 \
    AI_SERVICE_URL=http://ai-service:8001 \
    FRONTEND_PATH=/app/frontend

CMD ["/app/gateway"]
