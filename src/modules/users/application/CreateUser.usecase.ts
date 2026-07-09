import { CreateUserProps, User } from '../domain/User.entity';
import { IUserRepository } from '../domain/IUserRepository';
import { UserAlreadyExistsError } from '../domain/UserAlreadyExistsError';

export class CreateUserUseCase {
  constructor(private readonly userRepository: IUserRepository) {}

  async execute(props: CreateUserProps): Promise<User> {
    const existing = await this.userRepository.findByEmail(props.email);
    if (existing) {
      throw new UserAlreadyExistsError(props.email);
    }

    return this.userRepository.create(props);
  }
}
