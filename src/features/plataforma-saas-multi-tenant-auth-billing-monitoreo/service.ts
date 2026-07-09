// Servicio de autenticación y organizaciones sobre Clerk (E3-T1).
// Responsabilidades:
//  - Verificar credenciales email/password contra Clerk.
//  - Resolver la organización activa del usuario.
//  - Emitir un sign-in token de sesión.
//  - Autorizar acciones que requieren organización activa (p. ej. crear schemas).

import {
  AuthError,
  type ActiveOrganization,
  type AuthenticatedUser,
  type ClerkAuthClient,
  type LoginRequest,
  type LoginResponse,
  type OrgRole,
} from './types';

/** Vigencia del sign-in token emitido en el login, en segundos (1 hora). */
const SIGN_IN_TOKEN_TTL_SECONDS = 3600;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeRole(role: string): OrgRole {
  // Clerk expone roles como 'org:admin' | 'org:member' (o legacy 'admin'/'member').
  return role.endsWith('admin') ? 'admin' : 'member';
}

export class AuthService {
  private readonly clerk: ClerkAuthClient;

  public constructor(clerk: ClerkAuthClient) {
    this.clerk = clerk;
  }

  /**
   * Autentica credenciales y devuelve token + usuario con su organización activa.
   * @throws {AuthError} 'invalid_credentials' (401) si el email no existe o el password no verifica.
   */
  public async login(input: LoginRequest): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const password = input.password;

    if (!EMAIL_RE.test(email) || password.length === 0) {
      // No revelamos si el fallo es de formato o de credenciales: siempre 401.
      throw new AuthError('invalid_credentials', 'Email o contraseña inválidos.');
    }

    const clerkUser = await this.findUserByEmail(email);
    if (clerkUser === null) {
      throw new AuthError('invalid_credentials', 'Email o contraseña inválidos.');
    }

    const { verified } = await this.clerk.users.verifyPassword({
      userId: clerkUser.id,
      password,
    });
    if (!verified) {
      throw new AuthError('invalid_credentials', 'Email o contraseña inválidos.');
    }

    const organization = await this.resolveActiveOrganization(clerkUser.id);
    const { token } = await this.clerk.signInTokens.createSignInToken({
      userId: clerkUser.id,
      expiresInSeconds: SIGN_IN_TOKEN_TTL_SECONDS,
    });

    const user: AuthenticatedUser = {
      id: clerkUser.id,
      email,
      organization,
    };

    return { token, user };
  }

  /**
   * Garantiza que el usuario tenga una organización activa antes de una acción de tenant.
   * @throws {AuthError} 'no_active_organization' (403) si organization es null.
   */
  public assertCanCreateSchemas(user: AuthenticatedUser): ActiveOrganization {
    if (user.organization === null) {
      throw new AuthError(
        'no_active_organization',
        'El usuario no tiene una organización activa asignada.',
      );
    }
    return user.organization;
  }

  private async findUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string } | null> {
    const { data } = await this.clerk.users.getUserList({ emailAddress: [email] });
    const match = data[0];
    if (match === undefined) {
      return null;
    }
    const primary =
      match.emailAddresses.find((e) => e.id === match.primaryEmailAddressId) ??
      match.emailAddresses[0];
    return { id: match.id, email: primary?.emailAddress ?? email };
  }

  private async resolveActiveOrganization(userId: string): Promise<ActiveOrganization | null> {
    const { data } = await this.clerk.users.getOrganizationMembershipList({ userId });
    const membership = data[0];
    if (membership === undefined) {
      return null;
    }
    return {
      id: membership.organization.id,
      slug: membership.organization.slug,
      name: membership.organization.name,
      role: normalizeRole(membership.role),
    };
  }
}
