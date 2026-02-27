import jwt from 'jsonwebtoken';
import type { UserRole } from '../types';
import { logger } from './logger.util';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY = '7d';

export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
}

export function generateAccessToken(payload: TokenPayload): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

export function generateRefreshToken(payload: TokenPayload): string {
  if (!JWT_REFRESH_SECRET) {
    throw new Error('JWT_REFRESH_SECRET is not configured');
  }
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  if (!JWT_SECRET) {
    logger.error(
      'JWT_SECRET is not configured when verifying access token',
      new Error('Missing JWT_SECRET')
    );
    throw new Error('JWT configuration error');
  }
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  if (!JWT_REFRESH_SECRET) {
    logger.error(
      'JWT_REFRESH_SECRET is not configured when verifying refresh token',
      new Error('Missing JWT_REFRESH_SECRET')
    );
    throw new Error('JWT configuration error');
  }
  return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
}
