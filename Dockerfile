# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
# The CLI is retained for deployment scripts. Refresh its bundled security patches
# independently, without resolving npm's unpublished development-only packages.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates perl-base postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global npm@12.2.0 --ignore-scripts \
  && npm --prefix /tmp/npm-security install --no-save --package-lock=false --ignore-scripts brace-expansion@5.0.11 undici@6.28.1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion /usr/local/lib/node_modules/npm/node_modules/undici \
  && cp -R /tmp/npm-security/node_modules/. /usr/local/lib/node_modules/npm/node_modules/ \
  && rm -rf /tmp/npm-security \
  && npm cache clean --force

FROM base AS deps
WORKDIR /app
COPY --from=contracts package.json /erp-contracts/package.json
COPY --from=contracts src /erp-contracts/src
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --install-links --omit=dev --ignore-scripts \
  && npx prisma generate \
  && npm cache clean --force

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 10001 nodeapp \
  && useradd --system --uid 10001 --gid nodeapp --home-dir /app --shell /usr/sbin/nologin nodeapp
COPY --chown=nodeapp:nodeapp --from=deps /app/node_modules ./node_modules
COPY --chown=nodeapp:nodeapp package.json package-lock.json ./
COPY --chown=nodeapp:nodeapp prisma ./prisma
COPY --chown=nodeapp:nodeapp src ./src
# REQ-HR-DEPLOY-HARDENING-2026-09-02 §3a. Without these the image cannot run its
# own post-deploy verification: `npm run smoke:deploy` and `npm run
# db:indexes:deploy` both live under scripts/, and every Prisma 7 CLI command
# needs prisma.config.js to resolve datasource.url. Omitting them is why the
# smoke had to be hand-copied into a running pod to work at all.
COPY --chown=nodeapp:nodeapp prisma.config.js ./
COPY --chown=nodeapp:nodeapp scripts ./scripts
COPY --chown=nodeapp:nodeapp --from=contracts package.json /erp-contracts/package.json
COPY --chown=nodeapp:nodeapp --from=contracts src /erp-contracts/src
USER nodeapp
EXPOSE 3001
CMD ["node", "src/server.js"]
