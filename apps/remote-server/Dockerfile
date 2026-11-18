FROM node:24-bookworm-slim
WORKDIR /app
COPY apps/remote-server/dist/package.json apps/remote-server/dist/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /data && chown node:node /data
COPY apps/remote-server/dist/ ./
USER node
ENV DSH_SERVER_HOST=0.0.0.0 DSH_SERVER_PORT=8080 DSH_SERVER_DATA_FILE=/data/state.json
EXPOSE 8080
CMD ["node", "main.mjs"]
