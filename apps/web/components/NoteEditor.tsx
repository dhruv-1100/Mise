"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A private note on a recipe.
 *
 * "Used half the chilli, still too hot" is the note people actually write, and
 * it is worth more to them than anything the extractor produced. Saved on blur
 * and on an explicit save, never on every keystroke — a request per character
 * would be both wasteful and, on a flaky connection, a good way to lose a note
 * to an out-of-order response.
 */
export function NoteEditor({
  videoId,
  initialNote,
}: {
  videoId: string;
  initialNote: string | null;
}) {
  const [note, setNote] = useState(initialNote ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const lastSaved = useRef(initialNote ?? "");

  // Clear the "Saved" confirmation after a moment so it does not sit there
  // claiming something about text the person has since edited.
  useEffect(() => {
    if (state !== "saved") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function persist() {
    if (note === lastSaved.current) return;
    setState("saving");
    try {
      const res = await fetch(`/api/recipes/${videoId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) {
        setState("failed");
        return;
      }
      lastSaved.current = note;
      setState("saved");
    } catch {
      setState("failed");
    }
  }

  return (
    <section className="mt-8">
      <label
        htmlFor="note"
        className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint"
      >
        Your notes
      </label>
      <textarea
        id="note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => void persist()}
        rows={3}
        placeholder="What you changed, what to do differently next time…"
        className="mt-2 w-full resize-y rounded-md border border-line bg-surface px-3.5 py-3 text-base leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <p aria-live="polite" className="mt-1.5 h-4 text-[13px] text-ink-faint">
        {state === "saving"
          ? "Saving…"
          : state === "saved"
            ? "Saved"
            : state === "failed"
              ? "Could not save that note."
              : ""}
      </p>
    </section>
  );
}
