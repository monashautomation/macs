FROM node:22-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install --no-cache-dir .
COPY --from=frontend /src/dist /app/static
ENV MACS_STATIC_DIR=/app/static \
    MACS_CONFIG=/config/config.yaml
RUN useradd --system --uid 10001 macs && mkdir /data && chown macs /data
USER macs
WORKDIR /data
EXPOSE 8000
# One worker only: the GPU scheduler and job runner live in this process.
CMD ["uvicorn", "app.main:app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
