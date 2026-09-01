import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app/context.js';
import { registerInternalSessionsVerifyRoute } from './internal/v1/sessionsVerify.js';
import { registerEmailResendRoute } from './v1/auth/emailResend.js';
import { registerEmailVerifyRoute } from './v1/auth/emailVerify.js';
import { registerGoogleCallbackRoute } from './v1/auth/googleCallback.js';
import { registerGoogleStartRoute } from './v1/auth/googleStart.js';
import { registerLoginRoute } from './v1/auth/login.js';
import { registerLogoutRoute } from './v1/auth/logout.js';
import { registerPasswordResetConfirmRoute } from './v1/auth/passwordResetConfirm.js';
import { registerPasswordResetRequestRoute } from './v1/auth/passwordResetRequest.js';
import { registerPhoneOtpRequestRoute } from './v1/auth/phoneOtpRequest.js';
import { registerPhoneOtpVerifyRoute } from './v1/auth/phoneOtpVerify.js';
import { registerRegisterRoute } from './v1/auth/register.js';
import { registerSessionRoute } from './v1/auth/session.js';

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerRegisterRoute(app, ctx);
  registerLoginRoute(app, ctx);
  registerLogoutRoute(app, ctx);
  registerSessionRoute(app, ctx);
  registerEmailVerifyRoute(app, ctx);
  registerEmailResendRoute(app, ctx);
  registerPhoneOtpRequestRoute(app, ctx);
  registerPhoneOtpVerifyRoute(app, ctx);
  registerGoogleStartRoute(app, ctx);
  registerGoogleCallbackRoute(app, ctx);
  registerPasswordResetRequestRoute(app, ctx);
  registerPasswordResetConfirmRoute(app, ctx);

  registerInternalSessionsVerifyRoute(app, ctx);
}
