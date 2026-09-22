import { ArrowRight, Construction, Map } from "lucide-react";
import { ProductLink } from "../app/router";

export function UnavailablePage({ title, description }: { title: string; description: string }) {
  return <div className="v2-page" data-page="unavailable">
    <header className="v2-page-head"><div><span className="v2-eyebrow">产品框架</span><h1>{title}</h1><p>{description}</p></div></header>
    <section className="v2-route-notice">
      <Construction aria-hidden="true" />
      <div><h2>产品位置已确定，能力尚未接入</h2><p>这里仅用于确认完整产品架构。真实数据、对象归属和必要写入契约完成前，不展示静态卡片、数量或不可用操作。</p></div>
    </section>
  </div>;
}

export function NotFoundPage() {
  return <div className="v2-page" data-page="not-found">
    <header className="v2-page-head"><div><span className="v2-eyebrow">产品框架</span><h1>页面未找到</h1><p>当前地址不属于已登记的产品路径，请从产品导航重新进入。</p></div></header>
    <section className="v2-route-notice">
      <Map aria-hidden="true" />
      <div><h2>无法识别这个深链</h2><p>浏览器地址已保留，没有自动跳到含义不同的页面。</p></div>
      <ProductLink className="ui-button ui-button--primary ui-button--lg" href="/data/metrics">前往指标中心<ArrowRight aria-hidden="true" /></ProductLink>
    </section>
  </div>;
}
