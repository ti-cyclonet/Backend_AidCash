FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:20-alpine

RUN apk add --no-cache openssl tzdata

# Toda la lógica de periodos (mes/quincena de cada pago, "vence hoy",
# "vencido") usa la hora LOCAL del servidor. En UTC, desde las 7 p. m. hora
# Colombia el servidor ya está en el día siguiente: un pago hecho el 30 a las
# 8 p. m. quedaba etiquetado en el mes siguiente.
ENV TZ=America/Bogota

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
