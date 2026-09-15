import "./calculation-evidence.css";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import { useState } from "react";
import { Calculator } from "lucide-react";
import { MetricReadingDialog } from "./MetricReadingDialog";
import { formatMetricAuthorityText } from "../metrics/metric-presentation";
import { calculationTableCells, formatCalculationInput as inputValue, type CalculationTableColumn } from "./calculation-table-model";

export interface CalculationBasis {
  formula: string;
  scope: string;
  numerator: { name: string; value: number | null; unit: string };
  denominator: { name: string; value: number | null; unit: string };
  result: string;
  percentage: boolean;
}

/** Authority supplies the formula; missing inputs remain missing, never inferred from a rate. */
export function missingCalculation(formula: string, scope: string, result: string, percentage: boolean): CalculationBasis | undefined {
  const expression = formula.includes("公式：") ? formula.split("公式：").at(-1)! : formula;
  const readable = formatMetricAuthorityText(expression.replace(/\bM\d{3}\s*/g, ""), new Map()).replace(/`/g, "").trim();
  const parts = readable.split("÷");
  if (parts.length !== 2) return undefined;
  return { formula: readable, scope, result, percentage, numerator: { name: parts[0].trim(), value: null, unit: "" }, denominator: { name: parts[1].replace(/\s*[×*]\s*100%.*$/, "").trim(), value: null, unit: "" } };
}

export function CalculationColumnHeaders({ columns }: { columns: readonly CalculationTableColumn[] }) {
  return <>{columns.map(column => <th key={column.key}>{column.heading}</th>)}</>;
}

export function CalculationColumns({ basis, fallback, columns }: { basis?: CalculationBasis; fallback?: CalculationBasis; columns: readonly CalculationTableColumn[] }) {
  return <>{calculationTableCells(basis ?? fallback, columns).map((value, index) => <td key={columns[index].key} className={columns[index].content === "name" ? "calculation-table__name" : undefined}>{value}</td>)}</>;
}

/** Displays supplied snapshot inputs. Never infers bases from a displayed ratio. */
export function CalculationEvidence({ basis, compact = false }: { basis?: CalculationBasis; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!basis) return <p className="calculation-evidence__pending">计算基数待接入</p>;
  if (compact) return <div className="calculation-evidence__compact">
    <FloatingHint content={<><p>{basis.numerator.name}：{inputValue(basis.numerator)}</p><p>{basis.denominator.name}：{inputValue(basis.denominator)}</p><p>{basis.formula}</p></>}>
      <button className="calculation-evidence__trigger" type="button" onClick={event=>{event.stopPropagation();setOpen(true);}}><Calculator aria-hidden="true"/>计算依据{(basis.numerator.value===null||basis.denominator.value===null)&&<span> · 基数待接入</span>}</button>
    </FloatingHint>
    {open&&<MetricReadingDialog title="计算依据" onClose={()=>setOpen(false)} content={<CalculationEvidence basis={basis}/>}/>}
  </div>;
  const available = basis.numerator.value !== null && Number.isFinite(basis.numerator.value) && basis.denominator.value !== null && Number.isFinite(basis.denominator.value) && basis.denominator.value > 0;
  return <section className="calculation-evidence" aria-label="计算依据">
    <b>计算依据</b><p>{basis.formula}</p><small>{basis.scope}</small>
    <dl><div><dt>分子 · {basis.numerator.name}</dt><dd>{inputValue(basis.numerator)}</dd></div><div><dt>分母 · {basis.denominator.name}</dt><dd>{inputValue(basis.denominator)}</dd></div><div><dt>结果</dt><dd>{basis.result}</dd></div></dl>
    {!available && <p>{basis.denominator.value === 0 ? "分母为0，不能计算。" : "计算基数待接入；保留查询返回结果，不倒推或补齐输入。"}</p>}
  </section>;
}
