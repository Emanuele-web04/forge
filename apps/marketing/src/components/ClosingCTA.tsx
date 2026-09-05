import DownloadButton from "@/components/DownloadButton";
import InstallerCount from "@/components/InstallerCount";
import ProviderMarkRow from "@/components/ProviderMarkRow";
import { PRODUCT_CATEGORY, PRODUCT_HERO_TITLE } from "@/data/product";

export default function ClosingCTA({
  initialInstallerCount,
}: {
  initialInstallerCount: number | null;
}) {
  return (
    <section className="border-t border-[var(--divide)] bg-[var(--page-bg)] py-16 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4 text-center sm:px-6">
        <div className="mb-8 sm:mb-10">
          <ProviderMarkRow centered />
        </div>

        <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {PRODUCT_CATEGORY}
        </p>
        <h2 className="mx-auto mt-4 max-w-3xl text-[2rem] font-medium leading-[1.08] tracking-[-0.045em] text-[var(--text-primary)] sm:text-[3rem]">
          {PRODUCT_HERO_TITLE}
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-[14px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
          Start with one repository and one provider. Add parallel tasks, worktrees, browser
          verification, handoffs, and pull-request delivery when the work requires them.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3">
          <DownloadButton />
          <p className="text-[11px] text-[var(--text-tertiary)]">
            Free and open source · <InstallerCount initialCount={initialInstallerCount} />
          </p>
        </div>
      </div>
    </section>
  );
}
