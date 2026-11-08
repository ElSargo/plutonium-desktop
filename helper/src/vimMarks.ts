// Pluto Vim's uppercase marks across the desktop (PLUTO_VIM.md, Across the
// desktop): m{A-Z} in any field, a page's or a native app's, names that field,
// and '{A-Z} anywhere goes there: the helper shows the tab or window (through
// its shell) and the field's engine moves to the mark. In memory, like the
// registers.
export type MarkPlace =
  | { readonly kind: "page"; readonly targetId: string }
  | { readonly kind: "native"; readonly windowId: number };

export interface Mark {
  readonly place: MarkPlace;
  readonly offset: number;
}

export class VimMarks {
  private readonly marks = new Map<string, Mark>();

  set(name: string, place: MarkPlace, offset: number): void {
    if (!/^[A-Z]$/.test(name) || !Number.isSafeInteger(offset) || offset < 0) return;
    this.marks.set(name, { place, offset });
  }

  get(name: string): Mark | undefined {
    return this.marks.get(name);
  }

  /** Marks in a tab or window that's gone go with it. */
  forget(place: MarkPlace): void {
    for (const [name, mark] of this.marks) {
      if (mark.place.kind === place.kind && (place.kind === "page" ? mark.place.kind === "page" && mark.place.targetId === place.targetId : mark.place.kind === "native" && mark.place.windowId === place.windowId)) {
        this.marks.delete(name);
      }
    }
  }
}
