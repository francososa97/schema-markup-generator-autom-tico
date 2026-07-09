import { User } from '../domain/User.entity';
import { IUserRepository } from '../domain/IUserRepository';
import { UserNotFoundError } from '../domain/UserNotFoundError';

export class GetUserByIdUseCase {
  constructor(private readonly userRepository: IUserRepository) {}

  async execute(id: string): Promise<User> {
    const user = await this.userRepository.findById(id);
    if (!user) {
      throw new UserNotFoundError(id);
    }

    return user;
  }
}
