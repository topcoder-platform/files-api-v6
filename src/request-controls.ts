import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { UploadLimitException, positiveSetting } from './upload-controls';

@Catch(UploadLimitException)
export class UploadLimitFilter implements ExceptionFilter {
  catch(error: UploadLimitException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(error.retryAfter));
    response.setHeader('Cache-Control', 'no-store');
    response.status(429).json(error.getResponse());
  }
}
/** Bounded work before parsing/authentication, including traffic bypassing the API gateway. */
export function requestBudget() {
  const rate = positiveSetting('UPLOAD_REQUESTS_PER_SECOND', 50);
  const burst = positiveSetting('UPLOAD_REQUEST_BURST', 100);
  let tokens = burst;
  let last = performance.now();
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && req.path === '/v6/uploads/files/health')
      return next();
    const now = performance.now();
    tokens = Math.min(burst, tokens + ((now - last) * rate) / 1000);
    last = now;
    if (tokens < 1) {
      res.setHeader('Retry-After', '1');
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json({
        statusCode: 429,
        message: 'Too many requests. Please retry shortly.',
      });
      return;
    }
    tokens -= 1;
    next();
  };
}
