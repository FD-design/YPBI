export function compositionStatus(values:(number|null)[],total:number|null,complete:boolean) {
  if(!complete)return "分类覆盖或统计范围尚未核对完整";
  if(total===null||!Number.isFinite(total))return "总体未产出";
  if(values.some(value=>value===null||!Number.isFinite(value)))return "存在未产出的分类";
  if(total<0||values.some(value=>value!<0))return "包含负数，使用数值比较";
  if(total===0)return "总体为0，不计算占比";
  if(Math.abs(values.reduce<number>((sum,value)=>sum+value!,0)-total)>Math.max(.005,Math.abs(total)*1e-9))return "分类合计与同范围总体不一致";
  return null;
}
