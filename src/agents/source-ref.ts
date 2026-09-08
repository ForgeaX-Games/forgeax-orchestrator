export type SourceRef =
  | {
      readonly kind: "file";
      readonly path: string;
    }
  | {
      readonly kind: "directory";
      readonly path: string;
    }
  | {
      readonly kind: "inline";
      readonly text: string;
      /** Stable display label retained when a file source is snapshotted. */
      readonly label?: string;
    }
  | {
      readonly kind: "catalog";
      readonly templateRef: string;
      readonly entryId: string;
    };
