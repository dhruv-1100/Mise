import { UrlForm } from "@/components/UrlForm";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-5 py-16">
      <h1 className="font-display text-[40px] leading-[1.05] tracking-[-0.02em] sm:text-[52px]">
        Paste a cooking video. Get a recipe you can actually cook from.
      </h1>
      <p className="mb-8 mt-3.5 text-base leading-relaxed text-ink-soft">
        Ingredients, steps and a serving stepper that knows salt does not triple.
      </p>

      <UrlForm />

      <p className="mt-3.5 text-[13px] text-ink-faint">
        No account needed. Nothing is downloaded or hosted — every recipe links back to the
        creator&rsquo;s video.
      </p>
    </main>
  );
}
