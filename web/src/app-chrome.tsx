import { PackagePlus, Plus } from "lucide-react";
import { t } from "./i18n";

/** `secondary` marks a destination the compact navigation folds into More; CSS hides it there
 *  and every wider layout keeps showing it as it always has. */
export function Nav({ icon, label, active, badge, secondary, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; secondary?: boolean; onClick: () => void }) { return <button className={`${active ? " active" : ""}${secondary ? " nav-secondary" : ""}`.trim()} title={label} aria-label={label} onClick={onClick}>{icon}<span>{label}</span>{badge != null && <b>{badge}</b>}</button>; }

export function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty"><i>{icon}</i><h3>{title}</h3><p>{text}</p></div>; }
export function Onboarding({ onOpen }: { onOpen: () => void }) { return <div className="panel onboarding"><i><PackagePlus/></i><h2>{t("onboarding.title")}</h2><p>{t("onboarding.text")}</p><button className="primary" onClick={onOpen}><Plus/> {t("onboarding.action")}</button></div>; }
