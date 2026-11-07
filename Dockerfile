FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
COPY api-gateway/package.json api-gateway/
COPY media-service/package.json media-service/

FROM dependencies AS build
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY shared shared
COPY api-gateway/src api-gateway/src
COPY media-service/src media-service/src
RUN npm run build

FROM dependencies AS production
ARG SERVICE
RUN npm ci --workspace="$SERVICE" --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/dist/${SERVICE}/src ./dist/service/src
ENV NODE_ENV=production BIND_HOST=0.0.0.0
USER node
CMD ["node", "dist/service/src/server.js"]
