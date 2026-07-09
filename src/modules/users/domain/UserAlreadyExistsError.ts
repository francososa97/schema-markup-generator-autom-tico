import { ConflictError } from '../../../shared/errors/AppError';

export class UserAlreadyExistsError extends ConflictError {
  constructor(email: string) {
    super(`Ya existe un usuario con el email ${email}`);
  }
}
