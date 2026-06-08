FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Placeholder so prisma generate + next build work without a real DB at build time.
# Railway injects the real DATABASE_URL at runtime, which overrides this.
ENV DATABASE_URL=postgresql://build-placeholder/placeholder

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:railway"]
