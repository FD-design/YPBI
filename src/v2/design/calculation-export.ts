import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { calculationTableColumns } from "../features/dashboards/calculation-table-model";

/** Export numeric inputs at source precision and keep their units in separate typed cells. */
export function calculationExport(bases: readonly (CalculationBasis | undefined)[], fallback?: CalculationBasis) {
  const columns = calculationTableColumns(bases.length ? bases.map(basis => basis ?? fallback) : [fallback]);
  const headers = [...columns.flatMap(column => column.content === "value" ? [column.heading, `${column.role === "numerator" ? "分子" : "分母"}单位`] : [column.heading]), "公式", "计算范围"];
  const cells = (basis?: CalculationBasis): (string | number | null)[] => basis
    ? [...columns.flatMap(column => column.content === "name" ? [basis[column.role].name] : [basis[column.role].value, basis[column.role].unit]), basis.formula, basis.scope]
    : Array<null>(headers.length).fill(null);
  return { headers, cells };
}

const mixedCalculationExport = calculationExport([]);
export const calculationHeaders = mixedCalculationExport.headers;
export const calculationCells = mixedCalculationExport.cells;
