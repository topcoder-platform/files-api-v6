import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createJwtVerifier } from 'tc-core-library-js';
import type { Request } from 'express';

export interface JwtUser {
  userId?: string;
  isMachine: boolean;
}

export type MemberRequest = Request & { user: JwtUser };

@Injectable()
export class MemberGuard implements CanActivate {
  private readonly verifier = createJwtVerifier({
    AUTH_SECRET: process.env.AUTH_SECRET,
    VALID_ISSUERS: process.env.VALID_ISSUERS,
    JWT_AUDIENCE: process.env.JWT_AUDIENCE,
    AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE,
  });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MemberRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization || '',
    );
    if (!match) throw new UnauthorizedException('A member login is required.');
    try {
      const user = await this.verifier.verify(match[1]);
      if (!user.userId || user.isMachine) throw new Error('Member required');
      request.user = { userId: String(user.userId), isMachine: false };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }
}
