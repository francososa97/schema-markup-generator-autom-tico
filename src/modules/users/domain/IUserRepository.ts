import { CreateUserProps, User } from './User.entity';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(props: CreateUserProps): Promise<User>;
}
