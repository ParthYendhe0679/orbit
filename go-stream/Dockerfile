# Multi-stage build for ultra-minimalist, lightweight Go binary
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o orbit-stream .

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/orbit-stream .
EXPOSE 8001
CMD ["./orbit-stream", "--port", "8001"]
