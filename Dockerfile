# Pinned measurement environment: Playwright 1.51.1 image ships the matching Chromium 134 (build 1161).
FROM mcr.microsoft.com/playwright:v1.51.1-noble
ENV TZ=Europe/Paris NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY rules ./rules
COPY scripts ./scripts
COPY data ./data
COPY sites.json ./
USER pwuser
