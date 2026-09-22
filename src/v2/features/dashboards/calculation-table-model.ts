import type { CalculationBasis } from "./CalculationEvidence";

type CalculationInputRole = "numerator" | "denominator";
export interface CalculationTableColumn {
  key: string;
  role: CalculationInputRole;
  content: "name" | "value";
  heading: string;
}

/** Stable input names belong in the header; varying or unknown names remain on their own rows. */
export function calculationTableColumns(bases: readonly (CalculationBasis | undefined)[], prefix = ""): CalculationTableColumn[] {
  return (["numerator", "denominator"] as const).flatMap(role => {
    const label = role === "numerator" ? "分子" : "分母";
    const names = new Set(bases.map(basis => basis?.[role].name.trim() || undefined));
    const name = names.size === 1 ? [...names][0] : undefined;
    return name
      ? [{ key: `${role}-value`, role, content: "value", heading: `${prefix}${name}（${label}）` }]
      : [{ key: `${role}-name`, role, content: "name", heading: `${prefix}${label}指标` }, { key: `${role}-value`, role, content: "value", heading: `${prefix}${label}值` }];
  });
}

export function missingCalculationValues(basis?: CalculationBasis): CalculationBasis | undefined {
  return basis ? { ...basis, numerator: { ...basis.numerator, value: null }, denominator: { ...basis.denominator, value: null } } : undefined;
}

export const formatCalculationInput = (input?: CalculationBasis["numerator"]) => input?.value == null || !Number.isFinite(input.value)
  ? "待接入"
  : `${input.value.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}${input.unit ? ` ${input.unit}` : ""}`;

export function calculationTableCells(basis: CalculationBasis | undefined, columns: readonly CalculationTableColumn[]): string[] {
  return columns.map(column => column.content === "name" ? basis?.[column.role].name || "待登记" : formatCalculationInput(basis?.[column.role]));
}
