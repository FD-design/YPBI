import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { shouldUseV2Experience } from "./v2/app/experience";

async function bootstrap() {
  const useV2 = shouldUseV2Experience(window.location);
  const Application = useV2
    ? (await import("./v2/app/ProductApp")).ProductApp
    : (await import("./legacyApp")).LegacyApp;
  createRoot(document.getElementById("root")!).render(<AppErrorBoundary><Application /></AppErrorBoundary>);
}

void bootstrap();
