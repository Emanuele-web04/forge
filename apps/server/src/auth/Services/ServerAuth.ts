import type {
  AuthBearerBootstrapResult,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthSessionId,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
} from "@synara/contracts";
import { Data, DateTime, Duration, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { SessionRole } from "./SessionCredentialService";

export interface AuthRequest {
  readonly headers: Record<string, string | undefined>;
  readonly cookies: Record<string, string | undefined>;
  readonly url?: URL;
}

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly role: SessionRole;
  readonly expiresAt?: DateTime.DateTime;
}

export interface AuthenticatedHttpSession extends AuthenticatedSession {
  readonly credentialSource: "bearer" | "cookie";
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 429 | 500;
  readonly cause?: unknown;
}> {}

export interface ServerAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (request: AuthRequest) => Effect.Effect<AuthSessionState, never>;
  readonly exchangeBootstrapCredential: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly exchangeBootstrapCredentialForBearerSession: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<AuthBearerBootstrapResult, AuthError>;
  /** Validates a pairing credential without consuming one-time links. */
  readonly peekBootstrapCredential: (credential: string) => Effect.Effect<
    {
      readonly role: "owner" | "client";
      readonly subject: string;
    },
    AuthError
  >;
  readonly issuePairingCredential: (
    input?: AuthCreatePairingCredentialInput & {
      readonly role?: SessionRole;
      readonly ttl?: Duration.Duration;
    },
  ) => Effect.Effect<AuthPairingCredentialResult, AuthError>;
  readonly listPairingLinks: () => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthError>;
  readonly listClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<AuthClientSession>, AuthError>;
  readonly revokeClientSession: (
    currentSessionId: AuthSessionId,
    targetSessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthError>;
  readonly revokeOtherClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthError>;
  readonly logoutSession: (sessionId: AuthSessionId) => Effect.Effect<boolean, AuthError>;
  readonly authenticateHttpRequest: (
    request: AuthRequest,
  ) => Effect.Effect<AuthenticatedHttpSession, AuthError>;
  readonly authenticateWebSocketUpgrade: (
    request: AuthRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly issueWebSocketToken: (
    session: AuthenticatedSession,
  ) => Effect.Effect<AuthWebSocketTokenResult, AuthError>;
  readonly issueStartupPairingUrl: (baseUrl: string) => Effect.Effect<string, AuthError>;
}

export class ServerAuth extends ServiceMap.Service<ServerAuth, ServerAuthShape>()(
  "synara/auth/Services/ServerAuth",
) {}
