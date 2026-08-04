/**
 * CLI-local projection of orchestration capabilities that are not yet part of
 * the frozen AgentKernel contract. Kernel implementations own the declaration;
 * compose only consumes this shape and never branches on concrete kernel ids.
 */
import type { AgentKernel } from '@forgeax/agent-runtime';

export type NativeAttachmentKind = 'image' | 'document';

export interface KernelOrchestrationProfile {
  /** Attachment kinds the kernel can consume from a durable host path. */
  readonly nativeAttachmentKinds: readonly NativeAttachmentKind[];
  /** Whether the kernel consumes history from the host-owned ledger directly. */
  readonly hostOwnedHistory: boolean;
  /** How the host supplies shared history to this kernel. */
  readonly historyIntake: 'structured' | 'text-bridge';
}

export const RENTED_KERNEL_PROFILE: KernelOrchestrationProfile = Object.freeze({
  nativeAttachmentKinds: [] as NativeAttachmentKind[],
  hostOwnedHistory: false,
  historyIntake: 'text-bridge',
});

export const NATIVE_KERNEL_PROFILE: KernelOrchestrationProfile = Object.freeze({
  nativeAttachmentKinds: ['image', 'document'] as NativeAttachmentKind[],
  hostOwnedHistory: true,
  historyIntake: 'structured',
});

type ProfiledKernel = AgentKernel & { readonly orchestrationProfile?: KernelOrchestrationProfile };
type ResumeAwareKernel = AgentKernel & { readonly hasNativeHistoryResume?: (threadId: string) => boolean };

/** Unknown/older kernels degrade to text-only rented semantics. */
export function orchestrationProfileOf(kernel: AgentKernel): KernelOrchestrationProfile {
  return (kernel as ProfiledKernel).orchestrationProfile ?? RENTED_KERNEL_PROFILE;
}

/**
 * A text-bridge kernel may retain a private chat and resume it on the next
 * process invocation. Only that concrete, live resume reference authorizes a
 * delta: a missing reference (including after a server restart) requires a
 * fresh authoritative snapshot.
 */
export function hasNativeHistoryResume(kernel: AgentKernel, threadId?: string): boolean {
  const tid = threadId?.trim();
  return Boolean(tid && (kernel as ResumeAwareKernel).hasNativeHistoryResume?.(tid));
}
