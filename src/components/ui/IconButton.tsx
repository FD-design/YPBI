import type { ButtonHTMLAttributes, ComponentType, SVGProps } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export function IconButton({ label, icon: Icon, className = "", ...props }: IconButtonProps) {
  return <button className={`ui-icon-button ${className}`.trim()} aria-label={label} title={label} {...props}>
    <Icon aria-hidden="true" />
  </button>;
}
