import type { ReactNode } from "react";
import { HardDrive } from "lucide-react";
import { t, useI18n } from "./i18n";

export function RemoteRootsPlaceholder({ count, children }: { count: number; children?: ReactNode }) {
  useI18n();
  return <section className="panel browse-panel remote-libraries" aria-label={t("mediaServer.remoteTitle")} aria-busy="true">
    <div className="browse-head">
      <div className="browse-bar">
        <nav className="crumbs" aria-label={t("library.breadcrumbs")}>
          <button type="button" disabled><HardDrive/> {t("mediaServer.remoteTitle")}</button>
        </nav>
      </div>
    </div>
    {children}
    <div className="browse-scroll">
      <div className="browse-grid">
        {Array.from({ length: count }, (_, index) => <article key={index} className="browse-item library remote-root-placeholder" aria-hidden="true">
          <button className="library-open" disabled>
            <span className="browse-art"/>
            <span className="library-copy"><strong>{"\u00a0"}</strong><small>{"\u00a0"}</small></span>
            <span className="library-action"/>
          </button>
        </article>)}
      </div>
    </div>
  </section>;
}
