FROM node:24-alpine

ARG POCKETBASE_VERSION=0.40.6
ARG TARGETARCH

WORKDIR /app/backend

COPY --chown=node:node backend/package*.json ./
RUN npm install --omit=dev

WORKDIR /app

RUN apk add --no-cache curl unzip dos2unix tini && \
    case "${TARGETARCH:-amd64}" in \
      amd64) pb_arch="amd64" ;; \
      arm64) pb_arch="arm64" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_${pb_arch}.zip" -o /tmp/pocketbase.zip && \
    unzip -q /tmp/pocketbase.zip -d /app && \
    rm -f /tmp/pocketbase.zip /app/CHANGELOG.md /app/LICENSE.md

# Copy the backend code
COPY --chown=node:node backend/ ./backend/

# Copy the frontend code into /app/html and keep a bundled seed copy for empty bind mounts
COPY --chown=node:node assets/ ./html/assets/
COPY --chown=node:node index.html ./html/
COPY --chown=node:node manifest.json ./html/
COPY --chown=node:node sw.js ./html/
COPY --chown=node:node setup.html ./html/
COPY --chown=node:node account-deletion.html privacy.html ./html/

# Create the directories and assign ownership to the bundled node user (UID 1000)
RUN mkdir -p /app/data /app/db /app/html-seed && \
    cp -R /app/html/. /app/html-seed/ && \
    chmod +x /app/pocketbase && \
    chown -R node:node /app

COPY --chown=node:node docker-entrypoint.sh /app/
RUN dos2unix /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# Production mode: an error Express answers itself never shows its stack trace
ENV NODE_ENV=production

EXPOSE 3000

# Healthy while the server and its database both answer (docker ps, Unraid and orchestrators show it): a PocketBase that
# stopped behind a running server was not noticed
HEALTHCHECK --interval=30s --timeout=10s --start-period=2m --retries=3 \
  CMD pb="${POCKETBASE_HTTP:-0.0.0.0:8090}"; \
      wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/status" && \
      wget -q -O /dev/null "http://127.0.0.1:${pb##*:}/api/health" || exit 1

# tini as the first process: it passes docker stop on to the server and PocketBase (-g: to all of them) and reaps what
# ends. The shell of the entrypoint ignored the signal - both were killed hard after ten seconds
ENTRYPOINT ["/sbin/tini", "-s", "-g", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "backend/server.js"]
