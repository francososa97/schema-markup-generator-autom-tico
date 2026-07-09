# Backend Clean Architecture — Template

Base para APIs Node + Express + Prisma con Clean Architecture, siguiendo la convención de [CLAUDE.md](../../../CLAUDE.md) de Franco.

## Stack
Express · TypeScript (strict) · Prisma · Zod · PostgreSQL

## Estructura

```
src/
├── modules/
│   └── <feature>/
│       ├── domain/          # Entidades, interfaces, errores de dominio — sin dependencias externas
│       ├── application/     # Casos de uso — dependen de interfaces, no implementaciones
│       ├── infrastructure/  # Implementaciones concretas (Prisma, APIs externas)
│       └── presentation/    # Controllers, routes, schemas de validación (Zod)
├── shared/
│   ├── errors/       # AppError y subclases (NotFoundError, ConflictError, ValidationError)
│   ├── middlewares/  # errorHandler, validateBody
│   └── utils/        # asyncHandler y demás helpers sin estado
└── config/
    └── env.ts        # Validación de variables de entorno con Zod al iniciar
```

**Regla de dependencia:** `presentation → application → domain`. `infrastructure` implementa interfaces de `domain`. Nada en `domain` importa de `infrastructure` o `presentation`.

## Cómo agregar un módulo nuevo

Copiá la carpeta `src/modules/users/` como punto de partida:
1. `domain/`: entidad + interfaz de repositorio + errores propios (`XNotFoundError`, etc.)
2. `application/`: un caso de uso por acción (`CreateX.usecase.ts`, `GetXById.usecase.ts`)
3. `infrastructure/`: `PrismaXRepository implements IXRepository`
4. `presentation/`: schema Zod + controller + router, inyectando el repositorio en el router (ver `users.routes.ts`)
5. Registrar el router nuevo en `src/app.ts`

## Setup local

```bash
cp .env.example .env       # completar DATABASE_URL
npm install
npm run prisma:migrate
npm run dev                 # http://localhost:3000/api/health
```

## Deploy
Ver `proceso/deploy-checklist.md` del vault — Dockerfile ya usa `node:20-alpine` + `openssl` + `binaryTargets` con `linux-musl-openssl-3.0.x` para Prisma en Alpine.
