import { NotFoundError } from '../../../shared/errors/AppError';

export class UserNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`Usuario ${id} no encontrado`);
  }
}
