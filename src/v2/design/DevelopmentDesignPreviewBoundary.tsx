import type { ReactNode } from "react";
import type { AuthenticatedSession } from "../api/auth";
import { AuthenticationProvider } from "../app/AuthProvider";
import { ReviewToolsProvider } from "../components/ReviewTools";
import { DemoDataProvider } from "../components/DataOrigin";
import "../components/review-tools.css";

const DEVELOPMENT_DESIGN_PREVIEW_SESSION: AuthenticatedSession = {
  user: {
    subjectId: "00000000-0000-4000-8000-000000000001",
    username: "design.preview",
    displayName: "设计评审",
    role: "reader",
    permissions: ["bi:read"],
    pidScope: "all"
  },
  expiresAt: "2099-12-31T23:59:59.000Z",
  mustChangePassword: false,
  csrfToken: "developmentDesignPreviewSessionToken0000000"
};

export default function DevelopmentDesignPreviewBoundary({ children }: { children: ReactNode }) {
  return <AuthenticationProvider developmentPreviewSession={DEVELOPMENT_DESIGN_PREVIEW_SESSION}>
    <DemoDataProvider><ReviewToolsProvider>{children}</ReviewToolsProvider></DemoDataProvider>
  </AuthenticationProvider>;
}
