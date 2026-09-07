import type { ButtonHTMLAttributes, ComponentType, SVGProps } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

export function Button({ variant = "secondary", size = "md", icon: Icon, className = "", children, ...props }: ButtonProps) {
  return <button className={`ui-button ui-button--${variant} ui-button--${size} ${className}`.trim()} {...props}>
    {Icon && <Icon aria-hidden="true" />}
    <span>{children}</span>
  </button>;
}
