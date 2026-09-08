import type {
  AgentRegistrationTrigger,
  RegisterAgentRequest,
} from "./agent-registrar";

/** Registration-time structural invariants, not a product capability matrix.
 *
 * In particular, `trigger: "runtime"` resident registration is a supported
 * current business path for a trusted persona materialization that has
 * already persisted a ResidentIdentity. Use-case entry points decide who may
 * create that durable definition; this policy only rejects internally
 * incoherent lifetime/identity shapes and invalid bootstrap inputs.
 */
export class AgentRegistrationPolicy {
  assertAllowed(request: RegisterAgentRequest): void {
    if (request.lifetime === "resident" && !request.residentIdentity) {
      throw new Error(
        "resident registration requires a durable ResidentIdentity",
      );
    }
    if (request.lifetime === "ephemeral" && request.residentIdentity) {
      throw new Error(
        "ephemeral registration may not claim a ResidentIdentity",
      );
    }
    if (
      request.trigger === "bootstrap" &&
      (
        request.lifetime !== "resident" ||
        request.locator.medium !== "filesystem"
      )
    ) {
      throw new Error(
        "Session bootstrap accepts filesystem-backed resident definitions only",
      );
    }
  }
}

export function isRegistrationTrigger(value: string): value is AgentRegistrationTrigger {
  return value === "bootstrap" || value === "runtime";
}
