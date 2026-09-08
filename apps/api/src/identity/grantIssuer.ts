import {
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  HOST_CONNECT_SCOPE,
  RELAY_CONTROL_SCOPE,
  RELAY_TICKET_JWT_TYP,
  RELAY_TICKET_MAX_AGE_SECONDS,
  SYNARA_RELAY_AUDIENCE,
} from "@synara/contracts";
import type { HostGrantIssuer } from "./interfaces";
import type { ApiSigningService } from "./signing";

export function createHostGrantIssuer(signing: ApiSigningService): HostGrantIssuer {
  return {
    issueGrant({ userId, host, deviceJkt }) {
      return signing.sign({
        typ: GRANT_JWT_TYP,
        audience: SYNARA_RELAY_AUDIENCE,
        subject: userId,
        expiresInSeconds: GRANT_MAX_AGE_SECONDS,
        claims: {
          hostId: host.id,
          environmentId: host.environmentId,
          cnf: { jkt: deviceJkt },
          scope: [HOST_CONNECT_SCOPE],
        },
      });
    },

    issueRelayTicket(host) {
      return signing.sign({
        typ: RELAY_TICKET_JWT_TYP,
        audience: SYNARA_RELAY_AUDIENCE,
        subject: host.id,
        expiresInSeconds: RELAY_TICKET_MAX_AGE_SECONDS,
        claims: {
          environmentId: host.environmentId,
          keyGeneration: host.keyGeneration,
          scope: [RELAY_CONTROL_SCOPE],
        },
      });
    },
  };
}
