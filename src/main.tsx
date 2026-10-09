import { createRoot } from "react-dom/client";
import { AppErrorBoundary, AppFailure } from "./components/AppErrorBoundary";
import { installBrowserAssetRecovery } from "./app/assetRecovery";
import { shouldUseV2Experience } from "./v2/app/experience";

const recover = installBrowserAssetRecovery();
const root = createRoot(document.getElementById("root")!);

async function bootstrap() {
  const allowClassic = import.meta.env.MODE === "development";
  const Application = allowClassic && !shouldUseV2Experience(window.location, { allowClassic: true })
    ? (await import("./legacyApp")).LegacyApp
    : (await import("./v2/app/ProductApp")).ProductApp;
  root.render(<AppErrorBoundary recover={recover}><Application /></AppErrorBoundary>);
}

void bootstrap().catch((error: unknown) => {
  console.error("BI 页面启动失败", error);
  root.render(<AppFailure error={error} recover={recover} />);
  void recover(error);
});
