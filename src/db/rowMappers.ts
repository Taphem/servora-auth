import type {
  EmailVerificationToken,
  OAuthIdentity,
  PasswordResetToken,
  Session,
  User,
  UserRole,
  UserStatus,
} from '../types/domain.js';

interface UserRow {
  id: string;
  email: string;
  phone: string | null;
  password_hash: string | null;
  role: string;
  status: string;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    passwordHash: row.password_hash,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    emailVerifiedAt: row.email_verified_at,
    phoneVerifiedAt: row.phone_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface OAuthIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  provider_subject_id: string;
  linked_at: Date;
}

export function mapOAuthIdentityRow(row: OAuthIdentityRow): OAuthIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerSubjectId: row.provider_subject_id,
    linkedAt: row.linked_at,
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  session_token_hash: string;
  created_at: Date;
  expires_at: Date;
  rotated_from: string | null;
  revoked_at: Date | null;
  user_agent: string | null;
  ip: string | null;
}

export function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    sessionTokenHash: row.session_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    rotatedFrom: row.rotated_from,
    revokedAt: row.revoked_at,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export function mapEmailVerificationTokenRow(row: TokenRow): EmailVerificationToken {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export function mapPasswordResetTokenRow(row: TokenRow): PasswordResetToken {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}
