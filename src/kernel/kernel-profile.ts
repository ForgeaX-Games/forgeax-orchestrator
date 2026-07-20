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
  /** Whether TurnRequest.history is the kernel's conversation source. */
  readonly hostOwnedHistory: boolean;
}

export const RENTED_KERNEL_PROFILE: KernelOrchestrationProfile = Object.freeze({
  nativeAttachmentKinds: [] as NativeAttachmentKind[],
  hostOwnedHistory: false,
});

export const NATIVE_KERNEL_PROFILE: KernelOrchestrationProfile = Object.freeze({
  nativeAttachmentKinds: ['image', 'document'] as NativeAttachmentKind[],
  hostOwnedHistory: true,
});

type ProfiledKernel = AgentKernel & { readonly orchestrationProfile?: KernelOrchestrationProfile };

/** Unknown/older kernels degrade to text-only rented semantics. */
export function orchestrationProfileOf(kernel: AgentKernel): KernelOrchestrationProfile {
  return (kernel as ProfiledKernel).orchestrationProfile ?? RENTED_KERNEL_PROFILE;
}
