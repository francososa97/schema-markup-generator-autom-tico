// Tipos del dominio de autenticación multi-tenant (E3-T1).
// Se definen aquí porque src/shared/types/index.ts aún no expone tipos de auth;
// cuando ese barrel exista, re-exportar estos desde allí.

/** Rol de un usuario dentro de una organización de Clerk. */
export type OrgRole = 'admin' | 'member';

/** Payload recibido en POST /auth/login. */
export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}

/** Organización activa asociada a la sesión del usuario. */
export interface ActiveOrganization {
  readonly id: string;
  readonly slug: string | null;
  readonly name: string;
  readonly role: OrgRole;
}

/** Usuario autenticado y resuelto contra Clerk. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  /** null cuando el usuario no pertenece a ninguna organización activa. */
  readonly organization: ActiveOrganization | null;
}

/** Respuesta 200 de POST /auth/login. */
export interface LoginResponse {
  readonly token: string;
  readonly user: AuthenticatedUser;
}

/** Códigos de error de dominio mapeables a HTTP status. */
export type AuthErrorCode =
  | 'invalid_credentials' // 401
  | 'no_active_organization' // 403
  | 'internal'; // 500

const STATUS_BY_CODE: Readonly<Record<AuthErrorCode, number>> = {
  invalid_credentials: 401,
  no_active_organization: 403,
  internal: 500,
};

/** Error de dominio con status HTTP asociado, seguro para serializar al cliente. */
export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public readonly status: number;

  public constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    Object.setPrototypeOf(this, AuthError.prototype);
  }

  public toJSON(): { error: AuthErrorCode; message: string } {
    return { error: this.code, message: this.message };
  }
}

/** Dependencia mínima de Clerk que consume AuthService (permite inyectar mocks en tests). */
export interface ClerkAuthClient {
  users: {
    getUserList(params: { emailAddress: readonly string[] }): Promise<{
      data: ReadonlyArray<{
        id: string;
        primaryEmailAddressId: string | null;
        emailAddresses: ReadonlyArray<{ id: string; emailAddress: string }>;
      }>;
    }>;
    verifyPassword(params: { userId: string; password: string }): Promise<{ verified: boolean }>;
    getOrganizationMembershipList(params: { userId: string }): Promise<{
      data: ReadonlyArray<{
        role: string;
        organization: { id: string; name: string; slug: string | null };
      }>;
    }>;
  };
  signInTokens: {
    createSignInToken(params: { userId: string; expiresInSeconds: number }): Promise<{ token: string }>;
  };
}
