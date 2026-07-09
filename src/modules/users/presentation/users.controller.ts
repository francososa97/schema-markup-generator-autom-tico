import { Request, Response } from 'express';
import { ValidationError } from '../../../shared/errors/AppError';
import { CreateUserUseCase } from '../application/CreateUser.usecase';
import { GetUserByIdUseCase } from '../application/GetUserById.usecase';

export class UsersController {
  constructor(
    private readonly createUserUseCase: CreateUserUseCase,
    private readonly getUserByIdUseCase: GetUserByIdUseCase,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const user = await this.createUserUseCase.execute(req.body);
    res.status(201).json(user);
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('El parámetro id es requerido');
    }

    const user = await this.getUserByIdUseCase.execute(id);
    res.status(200).json(user);
  };
}
