# 🌱 Kiri Finance — Backend API

Backend REST para la app de finanzas personales Kiri Finance.

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express.js
- **ORM:** Prisma
- **Base de datos:** PostgreSQL
- **Auth:** JWT (access + refresh tokens)
- **Validación:** Zod
- **Seguridad:** Helmet, CORS, Rate Limiting

## Configuración rápida

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales de PostgreSQL

# 3. Generar cliente Prisma
npm run prisma:generate

# 4. Ejecutar migraciones
npm run prisma:migrate

# 5. (Opcional) Sembrar datos de prueba
npm run prisma:seed

# 6. Iniciar en modo desarrollo
npm run dev
```



## Endpoints API

### Auth
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Crear cuenta |
| POST | `/api/auth/login` | Iniciar sesión |
| POST | `/api/auth/refresh` | Renovar token |
| POST | `/api/auth/logout` | Cerrar sesión |
| GET | `/api/auth/me` | Perfil del usuario autenticado |

### Usuario
| Método | Ruta | Descripción |
|--------|------|-------------|
| PATCH | `/api/users/profile` | Actualizar perfil financiero |
| GET | `/api/users/dashboard-summary` | Datos completos del dashboard |

### Deudas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/debts` | Listar deudas activas |
| POST | `/api/debts` | Crear deuda |
| PATCH | `/api/debts/:id` | Actualizar deuda |
| POST | `/api/debts/:id/pay` | Registrar pago |
| DELETE | `/api/debts/:id` | Eliminar deuda |

### Gastos Fijos
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/fixed-expenses` | Listar gastos fijos |
| POST | `/api/fixed-expenses` | Crear gasto fijo |
| PATCH | `/api/fixed-expenses/:id` | Actualizar |
| DELETE | `/api/fixed-expenses/:id` | Eliminar |

### Ahorro
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/savings` | Historial + total acumulado |
| POST | `/api/savings` | Registrar ahorro del periodo |

### Ingresos Extra
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/extra-incomes` | Listar ingresos extra |
| POST | `/api/extra-incomes` | Crear ingreso extra |
| PATCH | `/api/extra-incomes/:id` | Actualizar |
| DELETE | `/api/extra-incomes/:id` | Eliminar |

### Gastos Hormiga
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/impulse-expenses` | Listar gastos hormiga |
| POST | `/api/impulse-expenses` | Registrar gasto |
| DELETE | `/api/impulse-expenses/:id` | Eliminar |

### Fondo de Emergencia
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/emergency-fund` | Saldo + historial |
| POST | `/api/emergency-fund/transaction` | Aporte o retiro |

### Gamificación
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/gamification/status` | Racha + insignias |
| PATCH | `/api/gamification/streak` | Actualizar racha |
| GET | `/api/gamification/badges` | Listar insignias |
| POST | `/api/gamification/badges` | Desbloquear insignia |

### IA (placeholders — requieren Google AI API Key)
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/ai/coach` | Coach financiero IA |
| POST | `/api/ai/budget-insight` | Análisis de presupuesto |
| POST | `/api/ai/scan-receipt` | Escáner de recibos |

### Health
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Estado del servidor |

## Autenticación

Todas las rutas (excepto `/auth/register`, `/auth/login`, `/auth/refresh` y `/health`) requieren el header:

```
Authorization: Bearer <access_token>
```

## Usuario de prueba

Después de ejecutar el seed:
- **Correo:** demo@kiri.app
- **Contraseña:** demo123
