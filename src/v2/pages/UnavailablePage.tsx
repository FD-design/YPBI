import { ArrowRight, Construction, Map } from "lucide-react";
import { ProductLink } from "../app/router";

export function UnavailablePage({ title, description }: { title: string; description: string }) {
  return <div className="v2-page" data-page="unavailable">
    <header className="v2-page-head"><div><span className="v2-eyebrow">产品框架</span><h1>{title}</h1><p>{description}</p></div></header>
    <section className="v2-route-notice">
      <Construction aria-hidden="true" />
      <div><h2>首批版本暂未开放此能力</h2><p>这个语义路径和产品位置已经保留，但不会用旧页面或演示数据伪装成可用功能。当前可以进入真实只读指标链路。</p></div>
      <ProductLink className="v2-button v2-button--primary" href="/analysis/metrics/M016">查看 M016 分析<ArrowRight aria-hidden="true" /></ProductLink>
    </section>
  </div>;
}

export function NotFoundPage() {
  return <div className="v2-page" data-page="not-found">
    <header className="v2-page-head"><div><span className="v2-eyebrow">产品框架</span><h1>页面未找到</h1><p>当前地址不属于已登记的产品路径，请从产品导航重新进入。</p></div></header>
    <section className="v2-route-notice">
      <Map aria-hidden="true" />
      <div><h2>无法识别这个深链</h2><p>浏览器地址已保留，没有自动跳到含义不同的页面。</p></div>
      <ProductLink className="v2-button v2-button--primary" href="/data/metrics">前往指标中心<ArrowRight aria-hidden="true" /></ProductLink>
    </section>
  </div>;
}
