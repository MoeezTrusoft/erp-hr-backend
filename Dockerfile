# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=contracts package.json /contracts/package.json
COPY --from=contracts src /contracts/src
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts \
  && rm -rf node_modules/@trusoft/contracts \
  && mkdir -p node_modules/@trusoft/contracts \
  && cp -R /contracts/package.json /contracts/src node_modules/@trusoft/contracts/ \
  && npx prisma generate \
  && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 nodeapp \
  && useradd --system --uid 10001 --gid nodeapp --home-dir /app --shell /usr/sbin/nologin nodeapp
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
# REQ-HR-DEPLOY-HARDENING-2026-09-02 §3a. Without these the image cannot run its
# own post-deploy verification: `npm run smoke:deploy` and `npm run
# db:indexes:deploy` both live under scripts/, and every Prisma 7 CLI command
# needs prisma.config.js to resolve datasource.url. Omitting them is why the
# smoke had to be hand-copied into a running pod to work at all.
COPY prisma.config.js ./
COPY scripts ./scripts
USER nodeapp
EXPOSE 3001
CMD ["node", "src/server.js"]
