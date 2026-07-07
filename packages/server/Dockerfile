FROM node:22-slim AS base
RUN npm install -g pnpm

WORKDIR /app
COPY pnpm-workspace.yaml ./
COPY package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile

COPY packages/core/src packages/core/src/
COPY packages/server/src packages/server/src/
COPY tsconfig.base.json ./
COPY packages/core/tsconfig.json packages/core/
COPY packages/server/tsconfig.json packages/server/

RUN pnpm --filter @mumo/server build

ENV DATA_DIR=/data
ENV PORT=1234
EXPOSE 1234
VOLUME ["/data"]

CMD ["node", "packages/server/dist/index.js"]
