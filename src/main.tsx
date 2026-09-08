import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { shouldUseV2Experience } from "./v2/app/experience";

async function bootstrap() {
  const allowClassic = import.meta.env.MODE === "development";
  const Application = allowClassic && !shouldUseV2Experience(window.location, { allowClassic: true })
    ? (await import("./legacyApp")).LegacyApp
    : (await import("./v2/app/ProductApp")).ProductApp;
  createRoot(document.getElementById("root")!).render(<AppErrorBoundary><Application /></AppErrorBoundary>);
}

void bootstrap();
