#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Kiri Finance — Reset de Base de Datos en Producción
# ═══════════════════════════════════════════════════════════════════════════════
#
# ADVERTENCIA: Este script ELIMINA todos los datos de producción.
# Los usuarios deberán registrarse nuevamente desde cero.
#
# Uso:
#   ssh ec2-user@3.95.90.144
#   cd /opt/cyclonet/AidCash/Backend_AidCash
#   bash scripts/reset-production-db.sh
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

CONTAINER_NAME="cyclonet-kiri-api"

echo -e "${RED}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ⚠️  RESET COMPLETO DE BASE DE DATOS PRODUCCIÓN  ⚠️  ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Esto ELIMINARÁ:                                    ║"
echo "║  - Todos los usuarios registrados                   ║"
echo "║  - Todas las deudas, gastos fijos, ahorros          ║"
echo "║  - Todas las conexiones sociales y préstamos        ║"
echo "║  - Todo el historial financiero                     ║"
echo "║                                                     ║"
echo "║  Esta acción NO es reversible.                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

read -p "¿Estás SEGURO de que quieres continuar? (escribe 'RESET' para confirmar): " CONFIRM

if [ "$CONFIRM" != "RESET" ]; then
  echo -e "${YELLOW}Operación cancelada.${NC}"
  exit 0
fi

echo ""
echo -e "${YELLOW}[1/4] Verificando que el contenedor esté corriendo...${NC}"
if ! docker ps --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
  echo -e "${RED}Error: El contenedor '$CONTAINER_NAME' no está corriendo.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Contenedor encontrado${NC}"

echo ""
echo -e "${YELLOW}[2/4] Ejecutando prisma migrate reset --force dentro del contenedor...${NC}"
docker exec "$CONTAINER_NAME" npx prisma migrate reset --force

echo ""
echo -e "${YELLOW}[3/4] Verificando que las migraciones se aplicaron correctamente...${NC}"
docker exec "$CONTAINER_NAME" npx prisma migrate status

echo ""
echo -e "${YELLOW}[4/4] Reiniciando el contenedor para limpiar caché en memoria...${NC}"
docker restart "$CONTAINER_NAME"
sleep 3

# Verificar que el servicio está arriba
echo ""
echo -e "${YELLOW}Verificando health check...${NC}"
sleep 2
if docker exec "$CONTAINER_NAME" wget -q -O- http://localhost:4000/api/health > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Servicio arriba y funcionando${NC}"
else
  echo -e "${YELLOW}⚠ Health check no respondió inmediatamente. Verifica logs:${NC}"
  docker logs "$CONTAINER_NAME" --tail 10
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Base de datos reseteada exitosamente             ║${NC}"
echo -e "${GREEN}║  Los usuarios pueden registrarse desde cero.        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
