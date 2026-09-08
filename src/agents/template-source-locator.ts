export type CanonicalAbsolutePath = string;
export type TemplateSourceId = string;

export type TemplateSourceLocator =
  | {
      readonly medium: "filesystem";
      readonly sourceId: TemplateSourceId;
      readonly root: CanonicalAbsolutePath;
    }
  | {
      readonly medium: "memory";
      readonly sourceId: TemplateSourceId;
    };

export type TemplateScope =
  | { readonly kind: "global" }
  | { readonly kind: "user"; readonly userId?: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "session"; readonly sid: string };

export type TemplateRegistrationLifetime = "durable" | "process" | "session";
export type TemplateTrust = "own" | "imported";

export interface TemplateProvenance {
  readonly adapter: string;
  readonly externalId?: string;
}

export type TemplateRevisionPolicy =
  | { readonly kind: "immutable" }
  | { readonly kind: "explicit" }
  | { readonly kind: "watch"; readonly debounceMs?: number }
  /** Compatibility spelling used by the capability watcher tests. */
  | { readonly kind: "capability-watch"; readonly debounceMs?: number };
