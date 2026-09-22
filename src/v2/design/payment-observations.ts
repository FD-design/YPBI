// DEV-only transaction fixture. Amount, users and composition share the same records.
export type PaymentDimension="stage"|"product"|"client";
export type PaymentRange={start:string;end:string};
type Payment={date:string;user:string;stage:string;product:string;client:string;way:string;cents:number;repurchase:boolean};
const dayMs=86400000;
export const paymentDates=(range:PaymentRange)=>Array.from({length:Math.round((Date.parse(range.end)-Date.parse(range.start))/dayMs)+1},(_,i)=>new Date(Date.parse(range.start)+i*dayMs).toISOString().slice(0,10));
export const paymentGroups:Record<PaymentDimension,{id:string;label:string}[]>={stage:[{id:"new",label:"新用户"},{id:"old",label:"老用户"}],product:[{id:"vip",label:"VIP"},{id:"coin",label:"金币"}],client:[{id:"android",label:"Android"},{id:"ios",label:"iOS"},{id:"web",label:"Web"}]};
function observations(range:PaymentRange):Payment[] {
  return paymentDates(range).flatMap(date=>{
    const day=Math.floor(Date.parse(date)/dayMs),prior=new Date((day-1)*dayMs).toISOString().slice(0,10);
    return Array.from({length:60},(_,i)=>{
      const stage=i>=40?"new":"old",user=i<20?`legacy-${i}`:`${i<40?prior:date}-${i%20}`;
      return Array.from({length:i%3===0?2:1},(_,j)=>({date,user,stage,way:(i+j)%5<3?"alipay":"wechat",product:(i+j)%5<3?"vip":"coin",client:["android","ios","web"][(i+j+day)%3],cents:900+((day*37+i*127+j*19)%4200),repurchase:stage==="old"||j>0}));
    }).flat();
  });
}
export function paymentAggregate(range:PaymentRange,filter:Partial<Record<PaymentDimension,string>>={}) {
  const rows=observations(range).filter(row=>Object.entries(filter).every(([key,value])=>row[key as PaymentDimension]===value));
  const amount=rows.reduce((sum,row)=>sum+row.cents,0)/100,users=new Set(rows.map(row=>row.user)).size;
  return {amount,users,arppu:users?amount/users:null,orders:rows.length,repurchaseUsers:new Set(rows.filter(row=>row.repurchase).map(row=>row.user)).size,repurchaseAmount:rows.filter(row=>row.repurchase).reduce((sum,row)=>sum+row.cents,0)/100};
}
export const paymentMetricIds=new Set(["M058","M059","M065","M066","M067","M104","M105"]);
export function paymentMetric(id:string,range:PaymentRange,filter:Partial<Record<PaymentDimension,string>>={}) {
  const row=paymentAggregate(range,{...filter,...(id==="M065"?{product:"vip"}:id==="M066"?{product:"coin"}:{})});
  return id==="M059"?row.users:id==="M067"?row.arppu!:id==="M104"?row.repurchaseUsers:id==="M105"?row.repurchaseAmount:row.amount;
}

export const paymentWays=[{id:"all",label:"总体"},{id:"alipay",label:"支付宝"},{id:"wechat",label:"微信"}];
export function paymentBusinessAggregate(range:PaymentRange,way="all") {
  const paid=observations(range).filter(row=>way==="all"||row.way===way);
  const requests=paymentDates(range).flatMap(date=>paymentWays.slice(1).filter(item=>way==="all"||item.id===way).flatMap(item=>{
    const successes=observations({start:date,end:date}).filter(row=>row.way===item.id);
    const seed=Math.floor(Date.parse(date)/dayMs)%7;
    return [...successes.map(row=>row.user),...Array.from({length:110+seed*7+(item.id==="alipay"?30:0)},(_,i)=>`attempt-${date}-${i%65}`)];
  }));
  const active=new Set(paymentDates(range).flatMap(date=>Array.from({length:430+(Math.floor(Date.parse(date)/dayMs)%9)*8},(_,i)=>i<350?`active-${i}`:`active-${date}-${i}`)));
  const paidUsers=new Set(paid.map(row=>row.user));
  for(const user of observations(range).map(row=>row.user))active.add(user);
  for(const date of paymentDates(range))for(let i=0;i<65;i++)active.add(`attempt-${date}-${i}`);
  const amount=paid.reduce((sum,row)=>sum+row.cents,0)/100;
  const inputs={requests:requests.length,requestUsers:new Set(requests).size,successes:paid.length,paidUsers:paidUsers.size,activeUsers:active.size,amount};
  const values:Record<string,number>={M113:inputs.requestUsers,M112:inputs.requests,M060:inputs.successes,M114:inputs.requests?inputs.successes/inputs.requests:0,M059:inputs.paidUsers,M061:inputs.activeUsers?inputs.paidUsers/inputs.activeUsers:0,M058:amount,M087:inputs.activeUsers?amount/inputs.activeUsers:0,M067:inputs.paidUsers?amount/inputs.paidUsers:0};
  return {inputs,values};
}
