# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Required for native modules (better-sqlite3, canvas, etc.)
RUN apk add --no-cache python3 make g++ && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./

# Cache npm downloads between builds — skips re-downloading unchanged packages
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

# Placeholder so prisma generate + next build work without a real DB at build time.
ENV DATABASE_URL=postgresql://build-placeholder/placeholder

RUN npx prisma generate --schema=prisma/schema.prisma

EXPOSE 4002

CMD ["npm", "run", "start:railway"]
