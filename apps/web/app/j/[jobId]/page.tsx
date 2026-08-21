import type { Metadata } from "next";

import { JobProgress } from "@/components/JobProgress";

export const metadata: Metadata = { title: "Extracting" };

export default async function JobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  return (
    <main className="mx-auto w-full max-w-[560px] flex-1 px-5 py-14">
      <p className="mb-2.5 text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
        Extracting
      </p>
      <h1 className="mb-1.5 font-display text-3xl leading-tight">Reading the recipe</h1>
      <p className="mb-8 text-sm text-ink-soft">Usually takes about 20 seconds.</p>
      <JobProgress jobId={jobId} />
    </main>
  );
}
