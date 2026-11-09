import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-5 py-16">
      <h1 className="mb-3 font-display text-[28px] leading-[1.12] tracking-[-0.02em]">
        We could not find that page
      </h1>
      <p className="text-base leading-relaxed text-ink-soft">
        If you followed a link to a recipe, we may not have extracted that video yet.
        Paste its YouTube link and we will.
      </p>

      <Link
        href="/"
        className="mt-7 flex min-h-11 items-center justify-center rounded-md bg-accent px-4 py-3.5 text-base font-semibold text-ground"
      >
        Extract a recipe
      </Link>
    </main>
  );
}
