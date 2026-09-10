FROM python:3.12-slim

WORKDIR /app

# Install dependencies first so the layer caches across source changes
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python source
COPY . .

ENV PYTHONUNBUFFERED=1

# Expose internal port for FastAPI WebSockets / REST (internal to Docker network)
EXPOSE 8001

# Start server on internal port 8001
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
