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

/** Codex keeps a native lane and can resume it when the concrete kernel has
 * already observed the thread. Kept as a profile constant so callers do not
 * branch on the implementation class. */
export const CODEX_KERNEL_PROFILE: KernelOrchestrationProfile = Object.freeze({
  nativeAttachmentKinds: ['image'] as NativeAttachmentKind[],
  hostOwnedHistory: false,
  historyIntake: 'text-bridge',
});

export const NATIVE_KERNEL_PROFILE: KernelOrchestrationProfile = Object.freeze({
  nativeAttachmentKinds: ['image', 'document'] as NativeAttachmentKind[],
  hostOwnedHistory: true,
  historyIntake: 'structured',
});

type ProfiledKernel = AgentKernel & { readonly orchestrationProfile?: KernelOrchestrationProfile };

/** Unknown/older kernels degrade to text-only rented semantics. */
export function orchestrationProfileOf(kernel: AgentKernel): KernelOrchestrationProfile {
  return (kernel as ProfiledKernel).orchestrationProfile ?? RENTED_KERNEL_PROFILE;
}

export function hasNativeHistoryResume(kernel: AgentKernel, threadId?: string): boolean {
  const candidate = kernel as AgentKernel & {
    hasNativeHistoryResume?: (id: string) => boolean;
  };
  return Boolean(threadId && candidate.hasNativeHistoryResume?.(threadId));
}
