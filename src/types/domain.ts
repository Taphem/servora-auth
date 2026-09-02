export const UserRole = {
  CUSTOMER: 'CUSTOMER',
  BUSINESS_OWNER: 'BUSINESS_OWNER',
  BUSINESS_STAFF: 'BUSINESS_STAFF',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
  SUPPORT: 'SUPPORT',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  LOCKED: 'LOCKED',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export interface User {
  id: string;
  email: string;
  phone: string | null;
  passwordHash: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OAuthIdentity {
  id: string;
  userId: string;
  provider: string;
  providerSubjectId: string;
  linkedAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  sessionTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  rotatedFrom: string | null;
  revokedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}
