# syntax=docker/dockerfile:1
# ⚠️ Image ini menjalankan crawler ke situs berbahaya. Build & run HANYA di VPS sekali pakai.

FROM node:24-bookworm-slim AS base
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: tidak ada skrip install pihak ketiga yang dijalankan.
RUN npm ci --omit=dev --ignore-scripts \
 && npx --no-install playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY tsconfig.json ./
COPY src ./src
COPY dorks ./dorks

# Non-root (user bawaan image node, uid 1000). HOME ke /tmp karena root fs read-only.
USER node
ENV HOME=/tmp DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["help"]

# Target untuk tes & typecheck (devDependencies ikut). Tidak membuka jaringan ke situs mana pun.
FROM base AS dev
USER root
RUN npm ci --ignore-scripts && npm cache clean --force
USER node
ENTRYPOINT []
CMD ["sh", "-c", "npm test && npx --no-install tsc"]
