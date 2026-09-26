import { CirclePlay } from "lucide-react";

export function Brand({ pulse = false }: { pulse?: boolean }) {
  return <div className="shell-brand">
    <div className={`brand-mark${pulse ? " shell-pulse" : ""}`}><CirclePlay/></div>
    <h1>Stremio <span>Offline</span></h1>
  </div>;
}
