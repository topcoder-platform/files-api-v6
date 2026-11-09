# syntax=docker/dockerfile:1.7
FROM node:26.12.1-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund
COPY nest-cli.json tsconfig*.json jest.config.json eslint.config.mjs .prettierrc.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run lint && npm test && npm run build && npm prune --omit=dev --ignore-scripts

FROM alpine:3.24 AS runtime
RUN apk upgrade --no-cache && apk add --no-cache 'nodejs-current~26' \
    && addgroup -S app && adduser -S -D -H -u 10001 -G app app
WORKDIR /app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
ENV NODE_ENV=production
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v6/uploads/files/health', {signal: AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
