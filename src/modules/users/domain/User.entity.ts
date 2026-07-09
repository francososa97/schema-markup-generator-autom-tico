export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateUserProps = Pick<User, 'email' | 'name'>;
