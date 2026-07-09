import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { asyncHandler } from '../../../shared/utils/asyncHandler';
import { validateBody } from '../../../shared/middlewares/validate.middleware';
import { CreateUserUseCase } from '../application/CreateUser.usecase';
import { GetUserByIdUseCase } from '../application/GetUserById.usecase';
import { PrismaUserRepository } from '../infrastructure/PrismaUserRepository';
import { UsersController } from './users.controller';
import { createUserSchema } from './users.schema';

export function createUsersRouter(prisma: PrismaClient): Router {
  const userRepository = new PrismaUserRepository(prisma);
  const controller = new UsersController(
    new CreateUserUseCase(userRepository),
    new GetUserByIdUseCase(userRepository),
  );

  const router = Router();
  router.post('/', validateBody(createUserSchema), asyncHandler(controller.create));
  router.get('/:id', asyncHandler(controller.getById));

  return router;
}
