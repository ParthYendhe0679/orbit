# Mochatrade Backend (Go API Gateway)

This is the Go API Gateway and static file server for Mochatrade / ORBIT.

## Architecture

- **Public Port**: `8000` (`http://localhost:8000`)
- **Python AI Service (Internal)**: `8001` (`http://localhost:8001`)

### Routing Responsibilities

| Route | Target | Purpose |
|---|---|---|
| `GET /health` | Native Go | Aggregated health check (Gateway status + AI Service probe) |
| `GET /` | Native Go | Serves `frontend/index.html` with anti-cache headers |
| `/frontend/*` | Native Go | Static file server for client scripts, styles, and assets |
| `/node_modules/*` | Native Go | Static file server for local vendor dependencies |
| `/api/*` | Reverse Proxy | Forwards REST requests to `AI_SERVICE_URL` |
| `/ws` | WebSocket Proxy | Bi-directional WebSocket bridge to `ws://{AI_SERVICE_URL}/ws` |

## Environment Variables

- `PORT`: Gateway listening port (default: `8000`)
- `AI_SERVICE_URL`: Internal URL for the Python AI service (default: `http://localhost:8001`)
- `FRONTEND_PATH`: Path to frontend directory (defaults to auto-detecting `../frontend` or `./frontend`)
- `NODE_MODULES_PATH`: Path to node_modules directory (defaults to auto-detecting `../node_modules` or `./node_modules`)

## Running Locally

```bash
# Run backend gateway directly
cd backend
go run .

# Run with custom configuration
PORT=8000 AI_SERVICE_URL=http://localhost:8001 go run .

# Build binary
go build -o bin/backend.exe .
```
