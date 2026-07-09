import { PrismaClient } from '@prisma/client';
import { CreateUserProps, User } from '../domain/User.entity';
import { IUserRepository } from '../domain/IUserRepository';

export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(props: CreateUserProps): Promise<User> {
    return this.prisma.user.create({ data: props });
  }
}
