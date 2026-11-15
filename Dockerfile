# ProMa container image. Multi-platform friendly (linux/amd64 and linux/arm64):
# every dependency is pure JavaScript, so the same recipe builds on a Mac (arm64)
# and runs on an EC2 server (amd64).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    ACTIVITY_DIR=/app/activity

# Install libraries first so this slow layer is cached when only the code changes.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . ./

# Folder where activity event files are written (a volume is mounted here).
RUN mkdir -p /app/activity && chown -R node:node /app/activity

# Never run the app as root inside the container.
USER node

EXPOSE 3000

# Kubernetes uses its own probes (k8s/proma.yaml); this one serves plain `docker run`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "server.js"]
