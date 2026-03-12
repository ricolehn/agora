FROM node:20-alpine

ARG POCKETBASE_VERSION=0.36.6
ARG TARGETARCH

WORKDIR /app/backend

COPY --chown=node:node backend/package*.json ./
RUN npm install --omit=dev

WORKDIR /app

RUN apk add --no-cache curl unzip && \
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

# Create the directories and assign ownership to the bundled node user (UID 1000)
RUN mkdir -p /app/data /app/db /app/html-seed && \
    cp -R /app/html/. /app/html-seed/ && \
    chmod +x /app/pocketbase && \
    chown -R node:node /app

COPY --chown=node:node docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "backend/server.js"]
