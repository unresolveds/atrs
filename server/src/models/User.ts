import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

import type { StoreRole } from './Store';

/**
 * Platform-level role, distinct from the per-store role below. `admin` is an
 * operator of the whole deployment and can see inside every store; it is not a
 * store position, and a store owner is not an admin.
 */
export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending' | 'active' | 'suspended';

export interface IUser extends Document {
  name: string;
  email: string;
  /**
   * The store this user works in. A user belongs to exactly one, and everything
   * they create is scoped to it. Null between signing up and creating or being
   * invited to a store — the only state in which a user has no tenancy.
   */
  storeId?: mongoose.Types.ObjectId | null;
  /** Their position within that store. Absent when `storeId` is. */
  storeRole?: StoreRole;
  /** Optional role/title shown as the presenter's subtitle on report decks. */
  jobTitle?: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  isRoot: boolean;
  /** Set when an admin issues a one-time password; forces a self-set on next login. */
  mustChangePassword: boolean;
  /** Set when the user requests a reset from the login screen; cleared on reset. */
  passwordResetRequested: boolean;
  passwordResetRequestedAt?: Date;
  /** Last time the password changed; JWTs issued before this are rejected. */
  passwordChangedAt?: Date;
  /**
   * The user's GitHub Personal Access Token, encrypted at rest (see utils/crypto).
   * `select: false` so it is never returned by default queries or serialized to
   * the client. Grants access to whatever repos the token's scopes allow —
   * including private and organization-owned repos.
   */
  githubToken?: string;
  /** GitHub login (username) resolved when the token was connected; safe to display. */
  githubLogin?: string;
  githubConnectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    jobTitle: { type: String, default: '', trim: true },
    passwordHash: { type: String, required: true },
    // Tenancy. Indexed because listing a store's members filters on it, and the
    // auth middleware reads it on every authenticated request.
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null, index: true },
    storeRole: { type: String, enum: ['owner', 'manager', 'developer'] },
    role: {
      type: String,
      enum: ['admin', 'user'],
      default: 'user',
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'suspended'],
      default: 'pending',
    },
    isRoot: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
    passwordResetRequested: { type: Boolean, default: false },
    passwordResetRequestedAt: { type: Date },
    passwordChangedAt: { type: Date },
    // Never selected/serialized by default — must be explicitly `.select('+githubToken')`.
    githubToken: { type: String, select: false },
    githubLogin: { type: String },
    githubConnectedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.passwordHash;
        delete ret.githubToken;
        delete ret.__v;
        return ret;
      },
    },
  }
);

UserSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.passwordHash);
};

// Cost factor is env-configurable; default 12 (a sensible 2026 baseline).
const BCRYPT_ROUNDS = Math.min(Math.max(parseInt(process.env.BCRYPT_ROUNDS || '', 10) || 12, 10), 15);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export const User = mongoose.model<IUser>('User', UserSchema);
