import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

type StatusTone = "success" | "warning" | "loading" | "neutral";

export function StatusBadge({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : tone === "loading" ? LoaderCircle : null;
  return <span className={`ui-status ui-status--${tone}`}>
    {Icon && <Icon aria-hidden="true" />}
    <span>{children}</span>
  </span>;
}
