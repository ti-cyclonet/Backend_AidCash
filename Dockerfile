# Etapa 1: Build
FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY nest-cli.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN ./node_modules/.bin/nest build

# Etapa 2: Imagen final
FROM node:18-alpine
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

ENV NODE_ENV=production
ENV PORT=3003
EXPOSE 3003

CMD ["node", "dist/main"]
