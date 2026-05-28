# 🧾 Backend Factonet

![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)

## 📋 Descripción

Backend Factonet es una API REST desarrollada con **NestJS** y **TypeScript** para la gestión completa de facturación. El sistema está integrado con el ecosistema Cyclonet y se conecta con Backend_Authoriza para la autenticación.

## ✨ Características principales

- 🔐 **Autenticación JWT** integrada con Backend_Authoriza
- 👥 **Gestión de clientes** completa
- 📦 **Catálogo de productos** con control de inventario
- 🧾 **Facturación electrónica** con numeración automática
- 📊 **Cálculo automático** de impuestos y totales
- 🗄️ **Base de datos PostgreSQL** con esquema `billing`
- ☁️ **Integración Cloudinary** para documentos
- 📖 **Documentación automática** con Swagger

## 🛠 Tecnologías utilizadas

| Tecnología | Descripción |
|------------|------------|
| **NestJS** | Framework backend Node.js con TypeScript |
| **TypeScript** | Lenguaje con tipado fuerte |
| **PostgreSQL** | Base de datos relacional |
| **TypeORM** | ORM para TypeScript |
| **JWT** | Autenticación con tokens |
| **Docker** | Contenedores para desarrollo |
| **Cloudinary** | Almacenamiento de archivos |

## 🚀 Instalación y configuración

### Requisitos previos
- Node.js (v16+)
- Docker y Docker Compose
- Backend_Authoriza ejecutándose en puerto 3000

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar variables de entorno
Editar el archivo `.env` con tus configuraciones:
```env
# Database
DB_HOST=localhost
DB_PORT=5434
DB_USERNAME=postgres
DB_PASSWORD=123456
DB_NAME=FactonetDB

# Application
PORT=3002

# Auth Service
AUTH_SERVICE_URL=http://localhost:3000

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

### 3. Iniciar base de datos
```bash
docker-compose up -d
```

### 4. Crear esquema de base de datos
```bash
docker exec -it factonetdb psql -U postgres -d FactonetDB
CREATE SCHEMA billing;
```

### 5. Ejecutar la aplicación
```bash
# Desarrollo
npm run start:dev

# Producción
npm run build
npm run start:prod
```

## 📚 API Endpoints

### Autenticación
- `GET /api/auth/profile` - Obtener perfil del usuario
- `GET /api/auth/validate` - Validar token

### Clientes
- `GET /api/customers` - Listar clientes
- `POST /api/customers` - Crear cliente
- `GET /api/customers/:id` - Obtener cliente
- `PATCH /api/customers/:id` - Actualizar cliente
- `DELETE /api/customers/:id` - Eliminar cliente

### Productos
- `GET /api/products` - Listar productos
- `POST /api/products` - Crear producto
- `GET /api/products/:id` - Obtener producto
- `PATCH /api/products/:id` - Actualizar producto
- `DELETE /api/products/:id` - Eliminar producto

### Facturas
- `GET /api/invoices` - Listar facturas
- `POST /api/invoices` - Crear factura
- `GET /api/invoices/:id` - Obtener factura
- `PATCH /api/invoices/:id` - Actualizar factura
- `DELETE /api/invoices/:id` - Eliminar factura

## 🗄️ Estructura de la base de datos

### Esquema: `billing`

**Tablas principales:**
- `customers` - Información de clientes
- `products` - Catálogo de productos
- `invoices` - Facturas emitidas
- `invoice_items` - Detalles de facturas

## 🔗 Integración con Frontend

El backend está configurado para conectarse con Frontend_Factonet en:
- **Desarrollo:** `http://localhost:4202`
- **CORS habilitado** para desarrollo

## 📝 Scripts disponibles

```bash
npm run start:dev    # Desarrollo con hot reload
npm run build        # Compilar aplicación
npm run start:prod   # Producción
npm run lint         # Verificar código
npm run test         # Pruebas unitarias
```

## 🏗️ Arquitectura del sistema

```
Frontend_Factonet (Angular) → Backend_Factonet (NestJS) → Backend_Authoriza (Auth)
                                      ↓
                              PostgreSQL (FactonetDB)
```

## 📄 Licencia

Privada - Derechos reservados Cyclonet
