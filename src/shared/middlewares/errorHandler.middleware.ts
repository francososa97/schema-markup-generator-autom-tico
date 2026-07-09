import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'ValidationError',
      message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
      statusCode: 400,
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: 'InternalServerError',
    message: 'Ocurrió un error inesperado',
    statusCode: 500,
  });
}
