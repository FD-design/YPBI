import logoUrl from "../../assets/ypinbi-logo.png";

export function BrandLogo({ className = "" }: { className?: string }) {
  const classes = ["v2-brand-logo", className].filter(Boolean).join(" ");
  return <img className={classes} src={logoUrl} alt="" aria-hidden="true" draggable={false} />;
}
