// Barrel export for the auth service layer.
// Routes and integration tests import from here.

// Types
export type {
  UserForToken,
  JwtClaims,
  RegisterInput,
  RegisterResult,
  LoginInput,
  LoginResult,
  ForgotPasswordResult,
  VerifyEmailResult,
  BootstrapInput,
  BootstrapResult,
  CreateApiKeyInput,
  ApiKeyRecord,
  AuthResult,
  FieldRestrictions,
  RowFilter,
  GuestSessionResult,
  GuestSessionPayload,
  UserContext,
} from "./types.js";

// Auth-specific error classes
export {
  BootstrapAlreadyCompletedError,
  BootstrapInvalidTokenError,
  BootstrapTokenMissingError,
  AccountLockedError,
  AccountDeactivatedError,
  EmailNotVerifiedError,
  EmailAlreadyVerifiedError,
  TokenReplayDetectedError,
  SessionRevokedError,
  ResetTokenInvalidError,
  ResetTokenExpiredError,
  ResetTokenUsedError,
  VerifyTokenInvalidError,
  VerifyTokenExpiredError,
  VerifyTokenUsedError,
  TenantNotFoundError,
  RegistrationDisabledError,
  PredefinedRoleImmutableError,
  PredefinedRoleConflictError,
  InsufficientScopeError,
  OAuthProviderDisabledError,
  OAuthStateInvalidError,
  OAuthExchangeFailedError,
  OAuthEmailMissingError,
} from "./errors.js";

// Service factories
export {
  createPasswordService,
  type PasswordService,
} from "./password-service.js";

export {
  createTokenService,
  resolveScopes as resolveScopesFromRoles,
  type TokenService,
  type TokenServiceDeps,
} from "./token-service.js";

export {
  createAuthService,
  type AuthService,
  type AuthServiceDeps,
} from "./auth-service.js";

export {
  createBootstrapService,
  resetBootstrapRateLimiter,
  type BootstrapService,
  type BootstrapServiceDeps,
} from "./bootstrap-service.js";

export {
  createApiKeyService,
  type ApiKeyService,
  type ApiKeyServiceDeps,
} from "./api-key-service.js";

export {
  createOAuthService,
  type OAuthService,
  type OAuthServiceDeps,
  type OAuthProvider,
  type OAuthUserProfile,
  type OAuthProviderTokens,
} from "./oauth-service.js";

export {
  createRbacService,
  type RbacService,
  type RbacServiceDeps,
} from "./rbac-service.js";

export {
  createGuestSessionService,
  type GuestSessionService,
  type GuestSessionServiceDeps,
} from "./guest-session-service.js";
