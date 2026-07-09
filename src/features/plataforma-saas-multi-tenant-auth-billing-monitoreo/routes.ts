// Handlers HTTP framework-agnósticos para auth/organizaciones (E3-T1).
// Se exponen como funciones puras (req -> res) para poder montarlas sobre
// Express, Fastify o un test runner sin acoplar el servicio al framework.

import { AuthError, type AuthenticatedUser, type LoginRequest } from './types';
import { AuthService } from './service';

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

function isLoginRequest(body: unknown): body is LoginRequest {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return typeof candidate.email === 'string' && typeof candidate.password === 'string';
}

function toHttpResult(err: unknown): HttpResult {
  if (err instanceof AuthError) {
    return { status: err.status, body: err.toJSON() };
  }
  return { status: 500, body: { error: 'internal', message: 'Error interno.' } };
}

export class AuthRoutes {
  private readonly service: AuthService;

  public constructor(service: AuthService) {
    this.service = service;
  }

  /** POST /auth/login -> 200 { token, user } | 401 { error } */
  public async login(body: unknown): Promise<HttpResult> {
    if (!isLoginRequest(body)) {
      return { status: 401, body: { error: 'invalid_credentials', message: 'Payload inválido.' } };
    }
    try {
      const result = await this.service.login(body);
      return { status: 200, body: result };
    } catch (err) {
      return toHttpResult(err);
    }
  }

  /**
   * POST /schemas (fragmento de autorización) -> 403 si el usuario no tiene org activa.
   * En una request real, `user` proviene del middleware que valida el token de sesión.
   */
  public createSchema(user: AuthenticatedUser): HttpResult {
    try {
      const org = this.service.assertCanCreateSchemas(user);
      return { status: 201, body: { organizationId: org.id, created: true } };
    } catch (err) {
      return toHttpResult(err);
    }
  }
}
