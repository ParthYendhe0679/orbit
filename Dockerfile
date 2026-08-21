FROM python:3.12-slim

WORKDIR /app

# Install dependencies first so the layer caches across source changes
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source and frontend website assets
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# node_modules is intentionally not copied; main.py skips that mount when the
# directory is absent, and the frontend loads its libraries from a CDN.

ENV PYTHONUNBUFFERED=1

# Expose port for FastAPI WebSockets / REST
EXPOSE 8000

# Start server
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
